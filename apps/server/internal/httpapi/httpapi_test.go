package httpapi_test

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/carlosdanna/rail-tracker/server/internal/config"
	"github.com/carlosdanna/rail-tracker/server/internal/encode"
	"github.com/carlosdanna/rail-tracker/server/internal/httpapi"
	"github.com/carlosdanna/rail-tracker/server/internal/sim"
	"github.com/carlosdanna/rail-tracker/server/internal/stream"
	"github.com/carlosdanna/rail-tracker/server/internal/world"
)

// harness is a running server plus everything a test needs to poke at it.
type harness struct {
	t     *testing.T
	ts    *httptest.Server
	hub   *stream.Hub
	sim   *sim.Sim
	wsURL string
}

func newHarness(t *testing.T, mutate func(*config.Config)) *harness {
	t.Helper()

	cfg := config.Default()
	cfg.Trains = 40
	cfg.Tick = 10 * time.Millisecond
	cfg.EmitTick = 20 * time.Millisecond
	if mutate != nil {
		mutate(&cfg)
	}

	w, err := world.Generate(world.GenParams{
		Seed: cfg.Seed, Bounds: world.Bounds{W: 1000, H: 1000},
		Stations: cfg.Stations, Lines: cfg.Lines, Trains: cfg.Trains,
	})
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}

	opts := sim.DefaultOptions(cfg.Seed)
	opts.Accel = cfg.Accel
	s := sim.New(w, opts)

	ctx, cancel := context.WithCancel(context.Background())
	go s.Run(ctx, cfg.Tick)

	// Keep test output readable; raise this when debugging a failure.
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := stream.NewHub(s, cfg.Rate, log)
	ts := httptest.NewServer(httpapi.New(ctx, cfg, s, hub, log).Handler())

	t.Cleanup(func() {
		cancel()
		ts.Close()
	})

	return &harness{
		t:     t,
		ts:    ts,
		hub:   hub,
		sim:   s,
		wsURL: "ws" + strings.TrimPrefix(ts.URL, "http") + "/stream",
	}
}

// dial opens a stream connection and returns it with the hello frame already
// consumed.
func (h *harness) dial(ctx context.Context, query string) (*websocket.Conn, encode.Hello) {
	h.t.Helper()
	url := h.wsURL
	if query != "" {
		url += "?" + query
	}
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		h.t.Fatalf("dial %s: %v", url, err)
	}
	h.t.Cleanup(func() { conn.CloseNow() }) //nolint:errcheck // best effort

	typ, data, err := conn.Read(ctx)
	if err != nil {
		h.t.Fatalf("read hello: %v", err)
	}
	if typ != websocket.MessageText {
		h.t.Fatalf("hello arrived as %v, want a text frame", typ)
	}
	var hello encode.Hello
	if err := json.Unmarshal(data, &hello); err != nil {
		h.t.Fatalf("unmarshal hello: %v (%s)", err, data)
	}
	return conn, hello
}

func (h *harness) metrics() stream.Metrics {
	h.t.Helper()
	resp, err := http.Get(h.ts.URL + "/metrics")
	if err != nil {
		h.t.Fatalf("GET /metrics: %v", err)
	}
	defer resp.Body.Close()
	var m stream.Metrics
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		h.t.Fatalf("decode metrics: %v", err)
	}
	return m
}

// batch is the decoded shape of a JSON batch frame.
type batch struct {
	Type    string `json:"type"`
	T       int64  `json:"t"`
	Updates []struct {
		Seq     uint32  `json:"seq"`
		Train   string  `json:"train"`
		X       float64 `json:"x"`
		Y       float64 `json:"y"`
		Heading float64 `json:"heading"`
		Compass string  `json:"compass"`
		Speed   float64 `json:"speed"`
		State   *string `json:"state"`
	} `json:"updates"`
}

// tap drains a connection continuously in the background and tallies what
// arrives. Tests must not stop reading between measurements: the server would
// see backpressure and the next window would read a burst from the socket
// buffer instead of the live rate. It also means read contexts are never
// cancelled, which in this WebSocket library would close the connection.
type tap struct {
	mu    sync.Mutex
	total int
	seqs  []uint32
	err   error
	done  chan struct{}
}

func newTap(t *testing.T, ctx context.Context, conn *websocket.Conn) *tap {
	t.Helper()
	tp := &tap{done: make(chan struct{})}
	go func() {
		defer close(tp.done)
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				tp.mu.Lock()
				tp.err = err
				tp.mu.Unlock()
				return
			}
			n, seqs := decodeFrame(typ, data)
			tp.mu.Lock()
			tp.total += n
			tp.seqs = append(tp.seqs, seqs...)
			tp.mu.Unlock()
		}
	}()
	return tp
}

// decodeFrame returns the update count and sequence numbers in one frame.
// Non-batch frames (pong) contribute nothing.
func decodeFrame(typ websocket.MessageType, data []byte) (int, []uint32) {
	switch typ {
	case websocket.MessageBinary:
		n := int(binary.LittleEndian.Uint16(data[2:4]))
		seqs := make([]uint32, n)
		for i := 0; i < n; i++ {
			off := encode.HeaderSize + i*encode.RecordSize
			seqs[i] = binary.LittleEndian.Uint32(data[off+17 : off+21])
		}
		return n, seqs
	default:
		var b batch
		if err := json.Unmarshal(data, &b); err != nil || b.Type != "batch" {
			return 0, nil
		}
		seqs := make([]uint32, len(b.Updates))
		for i, u := range b.Updates {
			seqs[i] = u.Seq
		}
		return len(b.Updates), seqs
	}
}

// sample returns how many updates arrived during d.
func (tp *tap) sample(d time.Duration) int {
	tp.mu.Lock()
	before := tp.total
	tp.mu.Unlock()

	time.Sleep(d)

	tp.mu.Lock()
	defer tp.mu.Unlock()
	return tp.total - before
}

// sequence returns every sequence number seen so far, in arrival order.
func (tp *tap) sequence() []uint32 {
	tp.mu.Lock()
	defer tp.mu.Unlock()
	return append([]uint32(nil), tp.seqs...)
}

// dialTap opens a connection and starts draining it immediately.
func (h *harness) dialTap(ctx context.Context, query string) (*tap, encode.Hello) {
	h.t.Helper()
	conn, hello := h.dial(ctx, query)
	return newTap(h.t, ctx, conn), hello
}

func TestHelloThenUpdatesAtRequestedRate(t *testing.T) {
	h := newHarness(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	tp, hello := h.dialTap(ctx, "rate=1000&format=json")

	if hello.Type != "hello" || hello.Version != encode.Version {
		t.Fatalf("bad hello: %+v", hello)
	}
	if hello.Rate != 1000 || hello.Format != "json" || hello.HideState {
		t.Fatalf("hello does not reflect the query: %+v", hello)
	}
	if hello.TrainCount != 40 || hello.Bounds.W != 1000 || hello.Bounds.H != 1000 {
		t.Fatalf("hello has the wrong world summary: %+v", hello)
	}

	got := tp.sample(2 * time.Second)
	seqs := tp.sequence()

	// 1000 updates/sec for 2 s, within 5%.
	const want = 2000
	if got < want*95/100 || got > want*105/100 {
		t.Fatalf("received %d updates in 2 s at rate=1000, want %d +/- 5%%", got, want)
	}

	// seq is strictly increasing across the whole connection.
	for i := 1; i < len(seqs); i++ {
		if seqs[i] <= seqs[i-1] {
			t.Fatalf("seq went backwards at %d: %d then %d", i, seqs[i-1], seqs[i])
		}
	}
	// Nothing was dropped on a client that keeps up, so there are no gaps.
	if len(seqs) > 1 && seqs[len(seqs)-1]-seqs[0] != uint32(len(seqs)-1) {
		t.Fatalf("seq gaps on a healthy client: first=%d last=%d count=%d",
			seqs[0], seqs[len(seqs)-1], len(seqs))
	}
}

func TestBinaryFormatStreams(t *testing.T) {
	h := newHarness(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	conn, hello := h.dial(ctx, "rate=500&format=bin")
	if hello.Format != "bin" {
		t.Fatalf("hello format = %q, want bin", hello.Format)
	}

	typ, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("frame type = %v, want binary", typ)
	}
	if data[0] != encode.Version || data[1] != encode.FrameBatch {
		t.Fatalf("bad binary header: % x", data[:4])
	}
	n := int(binary.LittleEndian.Uint16(data[2:4]))
	if len(data) != encode.HeaderSize+n*encode.RecordSize {
		t.Fatalf("frame is %d bytes, want %d for %d records",
			len(data), encode.HeaderSize+n*encode.RecordSize, n)
	}
}

func TestSetRateTakesEffectWithoutReconnecting(t *testing.T) {
	h := newHarness(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	conn, _ := h.dial(ctx, "rate=200&format=json")
	tp := newTap(t, ctx, conn)

	// Baseline at 200/sec.
	before := tp.sample(time.Second)
	if before < 150 || before > 260 {
		t.Fatalf("baseline was %d updates/sec, want about 200", before)
	}

	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"setRate","rate":2000}`)); err != nil {
		t.Fatalf("write setRate: %v", err)
	}

	// Spec §5.3: the new rate must be in force within one second.
	tp.sample(time.Second)
	after := tp.sample(time.Second)
	if after < 1800 || after > 2200 {
		t.Fatalf("after setRate the connection ran at %d updates/sec, want about 2000", after)
	}
}

func TestPingIsAnsweredWithPong(t *testing.T) {
	h := newHarness(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// rate=0 keeps the connection quiet so the pong is easy to find.
	conn, _ := h.dial(ctx, "rate=0")
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"ping","id":7}`)); err != nil {
		t.Fatalf("write ping: %v", err)
	}

	readCtx, cancelRead := context.WithTimeout(ctx, 3*time.Second)
	defer cancelRead()
	_, data, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read pong: %v", err)
	}
	var pong struct {
		Type string `json:"type"`
		ID   int64  `json:"id"`
		T    int64  `json:"t"`
	}
	if err := json.Unmarshal(data, &pong); err != nil {
		t.Fatalf("unmarshal pong: %v (%s)", err, data)
	}
	if pong.Type != "pong" || pong.ID != 7 {
		t.Fatalf("pong = %+v, want type pong and id 7", pong)
	}
	if pong.T <= 0 {
		t.Fatalf("pong carries t = %d, want a wall-clock timestamp", pong.T)
	}
}

// TestSlowClientDoesNotSlowOthers covers spec §5.4: a client that never reads
// must not affect anyone else, and its drops must show up in /metrics.
func TestSlowClientDoesNotSlowOthers(t *testing.T) {
	h := newHarness(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// A client that opens a connection at a high rate and then never reads.
	stalled, _ := h.dial(ctx, "rate=100000&format=json")
	_ = stalled

	// Give the stalled client time to fill its queue and start dropping.
	deadline := time.Now().Add(30 * time.Second)
	var dropped uint64
	for time.Now().Before(deadline) {
		m := h.metrics()
		for _, c := range m.PerClient {
			if c.Rate == 100000 {
				dropped = c.Dropped
			}
		}
		if dropped > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if dropped == 0 {
		t.Fatal("the stalled client never dropped anything; the emitter must be blocking")
	}

	// A healthy client connecting alongside it still gets its full rate.
	healthy, _ := h.dialTap(ctx, "rate=1000&format=json")
	got := healthy.sample(2 * time.Second)
	if got < 1900 || got > 2100 {
		t.Fatalf("the healthy client received %d updates in 2 s, want 2000 +/- 5%%", got)
	}

	// And the drops are still visible per client and in the totals.
	m := h.metrics()
	if m.DroppedTotal == 0 {
		t.Fatal("droppedTotal is 0 in /metrics")
	}
	if m.Clients != 2 {
		t.Fatalf("clients = %d, want 2", m.Clients)
	}
	var sawStalled bool
	for _, c := range m.PerClient {
		if c.Rate == 100000 {
			sawStalled = true
			if c.Dropped == 0 || c.DroppedFrames == 0 {
				t.Fatalf("stalled client shows no drops: %+v", c)
			}
		}
	}
	if !sawStalled {
		t.Fatalf("the stalled client is missing from /metrics: %+v", m.PerClient)
	}
}

func TestSimulationKeepsRunningWithAStalledClient(t *testing.T) {
	h := newHarness(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stalled, _ := h.dial(ctx, "rate=100000&format=json")
	_ = stalled

	before := h.sim.Latest().Tick
	time.Sleep(500 * time.Millisecond)
	after := h.sim.Latest().Tick

	// The sim ticks every 10 ms, so half a second is ~50 ticks. Allow plenty of
	// slack for a loaded CI machine; the point is that it is not stalled.
	if after-before < 20 {
		t.Fatalf("the simulation advanced only %d ticks in 500 ms with a stalled client", after-before)
	}
}

func TestPostConfigChangesDefaultRateOnly(t *testing.T) {
	h := newHarness(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// One client on the server default, one that asked for its own rate.
	def, hello := h.dialTap(ctx, "format=json")
	if hello.Rate != 1000 {
		t.Fatalf("default client hello rate = %d, want the server default 1000", hello.Rate)
	}
	pinned, _ := h.dialTap(ctx, "rate=300&format=json")

	resp, err := http.Post(h.ts.URL+"/config", "application/json", strings.NewReader(`{"rate":2000}`))
	if err != nil {
		t.Fatalf("POST /config: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /config returned %d", resp.StatusCode)
	}

	// Let the change settle, then measure both connections.
	time.Sleep(300 * time.Millisecond)
	defGot := def.sample(time.Second)
	if defGot < 1800 || defGot > 2200 {
		t.Fatalf("the default-rate client ran at %d updates/sec, want about 2000", defGot)
	}
	pinnedGot := pinned.sample(time.Second)
	if pinnedGot < 240 || pinnedGot > 380 {
		t.Fatalf("the pinned client ran at %d updates/sec, want its own 300", pinnedGot)
	}
}

func TestHideStateOmitsTheField(t *testing.T) {
	h := newHarness(t, func(c *config.Config) { c.HideState = true })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	conn, hello := h.dial(ctx, "rate=500&format=json")
	if !hello.HideState {
		t.Fatal("hello does not advertise hideState")
	}
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if strings.Contains(string(data), `"state"`) {
		t.Fatalf("a hide-state batch still carries a state field: %s", data)
	}

	binConn, _ := h.dial(ctx, "rate=500&format=bin")
	_, raw, err := binConn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if raw[encode.HeaderSize+16] != encode.StateHidden {
		t.Fatalf("binary state byte = %d, want %d when hidden",
			raw[encode.HeaderSize+16], encode.StateHidden)
	}
}

func TestHTTPRoutes(t *testing.T) {
	h := newHarness(t, nil)

	t.Run("world", func(t *testing.T) {
		resp, err := http.Get(h.ts.URL + "/world")
		if err != nil {
			t.Fatalf("GET /world: %v", err)
		}
		defer resp.Body.Close()
		var got world.World
		if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(got.Stations) != 30 || len(got.Lines) != 6 || len(got.Trains) != 40 {
			t.Fatalf("/world returned %d stations, %d lines, %d trains",
				len(got.Stations), len(got.Lines), len(got.Trains))
		}
	})

	t.Run("healthz", func(t *testing.T) {
		resp, err := http.Get(h.ts.URL + "/healthz")
		if err != nil {
			t.Fatalf("GET /healthz: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		var body map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body["status"] != "ok" {
			t.Fatalf("status = %v, want ok", body["status"])
		}
	})

	t.Run("bad requests", func(t *testing.T) {
		cases := []struct {
			name   string
			do     func() (*http.Response, error)
			status int
		}{
			{"bad format", func() (*http.Response, error) {
				return http.Get(h.ts.URL + "/stream?format=protobuf")
			}, http.StatusBadRequest},
			{"bad rate", func() (*http.Response, error) {
				return http.Get(h.ts.URL + "/stream?rate=-5")
			}, http.StatusBadRequest},
			{"config without rate", func() (*http.Response, error) {
				return http.Post(h.ts.URL+"/config", "application/json", strings.NewReader(`{}`))
			}, http.StatusBadRequest},
			{"config with bad JSON", func() (*http.Response, error) {
				return http.Post(h.ts.URL+"/config", "application/json", strings.NewReader(`nope`))
			}, http.StatusBadRequest},
			{"config via GET", func() (*http.Response, error) {
				return http.Get(h.ts.URL + "/config")
			}, http.StatusMethodNotAllowed},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				resp, err := tc.do()
				if err != nil {
					t.Fatalf("request: %v", err)
				}
				defer resp.Body.Close()
				if resp.StatusCode != tc.status {
					t.Fatalf("status = %d, want %d", resp.StatusCode, tc.status)
				}
			})
		}
	})
}
