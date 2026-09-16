// Package stream turns simulation snapshots into per-connection update streams.
//
// Each WebSocket connection gets three goroutines, as described in spec §3:
// a reader for client control messages, an emitter that decides what to send on
// every emit tick, and a writer draining a bounded queue. The emitter never
// blocks: when the queue is full it drops the frame and counts it, so one slow
// client cannot slow the simulation or anybody else.
package stream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/carlosdanna/rail-tracker/server/internal/config"
	"github.com/carlosdanna/rail-tracker/server/internal/encode"
	"github.com/carlosdanna/rail-tracker/server/internal/sim"
)

const (
	// queueDepth is how many encoded frames may be waiting for the writer
	// before the emitter starts dropping. A few frames absorb scheduling
	// jitter; more than that would just add latency.
	queueDepth = 64

	// maxRecordsPerFrame is the binary format's u16 record-count limit. Larger
	// batches are split across frames.
	maxRecordsPerFrame = 65535

	// writeTimeout bounds a single frame write, so a dead peer is noticed.
	writeTimeout = 10 * time.Second

	// readLimit caps client control messages; they are tiny.
	readLimit = 4096
)

// frame is one encoded WebSocket message waiting to be written.
type frame struct {
	buf []byte
	typ websocket.MessageType
}

// bufPool recycles encode buffers between the emitter and the writer.
var bufPool = sync.Pool{New: func() any { b := make([]byte, 0, 8192); return &b }}

// Options configures a session.
type Options struct {
	// Rate is the initial updates/sec for this connection.
	Rate int
	// RateOverridden records that the client asked for a specific rate, which
	// means POST /config must not change it.
	RateOverridden bool
	// Format is the wire format for batch frames.
	Format config.Format
	// HideState omits the train state from updates.
	HideState bool
	// EmitTick is the emitter's ticker interval.
	EmitTick time.Duration
	// Remote identifies the peer in /metrics and logs.
	Remote string
}

// Session streams updates to one WebSocket connection.
type Session struct {
	id   uint64
	conn *websocket.Conn
	sim  *sim.Sim
	log  *slog.Logger
	opts Options

	rate       atomic.Int64
	overridden atomic.Bool

	seq           atomic.Uint32
	sent          atomic.Uint64
	dropped       atomic.Uint64
	droppedFrames atomic.Uint64

	frames chan frame

	// cursor and carry belong to the emitter goroutine alone.
	cursor int
	carry  float64

	hub *Hub
}

// Stats is a session's slice of /metrics.
type Stats struct {
	ID            uint64 `json:"id"`
	Remote        string `json:"remote"`
	Format        string `json:"format"`
	Rate          int    `json:"rate"`
	Sent          uint64 `json:"sent"`
	Dropped       uint64 `json:"dropped"`
	DroppedFrames uint64 `json:"droppedFrames"`
}

// Stats returns a snapshot of this session's counters.
func (s *Session) Stats() Stats {
	return Stats{
		ID:            s.id,
		Remote:        s.opts.Remote,
		Format:        string(s.opts.Format),
		Rate:          int(s.rate.Load()),
		Sent:          s.sent.Load(),
		Dropped:       s.dropped.Load(),
		DroppedFrames: s.droppedFrames.Load(),
	}
}

// Rate returns the connection's current updates/sec.
func (s *Session) Rate() int { return int(s.rate.Load()) }

// SetRate changes the connection's rate. overridden marks the change as coming
// from the client, which pins it against later POST /config changes.
func (s *Session) SetRate(rate int, overridden bool) {
	if rate < 0 {
		rate = 0
	}
	s.rate.Store(int64(rate))
	if overridden {
		s.overridden.Store(true)
	}
}

// Run serves the connection until ctx is cancelled or the peer goes away.
func (s *Session) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	s.conn.SetReadLimit(readLimit)

	if err := s.sendHello(ctx); err != nil {
		return fmt.Errorf("hello: %w", err)
	}

	var wg sync.WaitGroup
	errc := make(chan error, 3)

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer cancel()
		errc <- s.readLoop(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer cancel()
		errc <- s.writeLoop(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		// The emitter owns the frame channel, so it closes it on the way out
		// and the writer drains what is left.
		defer close(s.frames)
		s.emitLoop(ctx)
	}()

	wg.Wait()
	close(errc)

	var err error
	for e := range errc {
		if e != nil && !isClosed(e) {
			err = errors.Join(err, e)
		}
	}
	return err
}

// sendHello writes the always-JSON hello frame that opens every connection.
func (s *Session) sendHello(ctx context.Context) error {
	w := s.sim.World()
	raw, err := encode.MarshalHello(encode.Hello{
		Bounds:     encode.Bounds{W: w.Bounds.W, H: w.Bounds.H},
		TrainCount: len(w.Trains),
		Rate:       s.Rate(),
		Format:     string(s.opts.Format),
		HideState:  s.opts.HideState,
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return s.conn.Write(ctx, websocket.MessageText, raw)
}

// clientMessage is the union of the messages a client may send.
type clientMessage struct {
	Type string `json:"type"`
	Rate *int   `json:"rate"`
	ID   *int64 `json:"id"`
}

// readLoop handles setRate and ping until the peer closes or ctx ends.
func (s *Session) readLoop(ctx context.Context) error {
	for {
		_, data, err := s.conn.Read(ctx)
		if err != nil {
			return err
		}
		var msg clientMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			s.log.Debug("ignoring malformed client message", "err", err)
			continue
		}
		switch msg.Type {
		case "setRate":
			if msg.Rate == nil {
				continue
			}
			s.SetRate(*msg.Rate, true)
			s.log.Debug("rate changed by client", "rate", s.Rate())
		case "ping":
			var id int64
			if msg.ID != nil {
				id = *msg.ID
			}
			s.sendPong(id)
		default:
			s.log.Debug("ignoring unknown client message", "type", msg.Type)
		}
	}
}

// sendPong queues a pong. Like every other frame it is dropped rather than
// blocking if the client is not reading.
func (s *Session) sendPong(id int64) {
	raw, err := json.Marshal(struct {
		Type string `json:"type"`
		ID   int64  `json:"id"`
		T    int64  `json:"t"`
	}{"pong", id, nowMillis()})
	if err != nil {
		return
	}
	buf := getBuf()
	*buf = append((*buf)[:0], raw...)
	if !s.enqueue(frame{buf: *buf, typ: websocket.MessageText}, 0) {
		putBuf(buf)
	}
}

// emitLoop is the heart of spec §3: every emit tick it sends
// rate x emitTick updates, carrying the fractional remainder forward so the
// long-run rate is exact, round-robinning through the latest snapshot.
func (s *Session) emitLoop(ctx context.Context) {
	tk := time.NewTicker(s.opts.EmitTick)
	defer tk.Stop()

	updates := make([]encode.Update, 0, 1024)
	for {
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
		}

		rate := float64(s.rate.Load())
		if rate <= 0 {
			// Keep the remainder from accumulating while paused.
			s.carry = 0
			continue
		}

		want := rate*s.opts.EmitTick.Seconds() + s.carry
		n := int(want)
		s.carry = want - float64(n)
		if n <= 0 {
			continue
		}

		snap := s.sim.Latest()
		if snap == nil || len(snap.Trains) == 0 {
			continue
		}

		t := snap.Wall.UnixMilli()
		for sent := 0; sent < n; {
			chunk := n - sent
			if chunk > maxRecordsPerFrame {
				chunk = maxRecordsPerFrame
			}
			updates = s.collect(snap, chunk, updates[:0])
			s.emitFrame(t, updates)
			sent += chunk
		}
	}
}

// collect appends the next n round-robin updates from snap, assigning each a
// fresh per-connection sequence number.
func (s *Session) collect(snap *sim.Snapshot, n int, out []encode.Update) []encode.Update {
	trains := snap.Trains
	for i := 0; i < n; i++ {
		ts := &trains[s.cursor]
		s.cursor++
		if s.cursor >= len(trains) {
			s.cursor = 0
		}
		out = append(out, encode.Update{
			Seq:     s.seq.Add(1),
			Train:   ts.ID,
			Index:   ts.Index,
			X:       ts.X,
			Y:       ts.Y,
			Heading: ts.Heading,
			Compass: ts.Compass,
			Speed:   ts.Speed,
			State:   ts.State,
		})
	}
	return out
}

// emitFrame encodes one batch and hands it to the writer, dropping it if the
// queue is full.
func (s *Session) emitFrame(t int64, updates []encode.Update) {
	buf := getBuf()
	var f frame
	if s.opts.Format == config.FormatBin {
		*buf = encode.BinaryBatch((*buf)[:0], float64(t), updates, s.opts.HideState)
		f = frame{buf: *buf, typ: websocket.MessageBinary}
	} else {
		raw, err := encode.JSONBatch(t, updates, s.opts.HideState)
		if err != nil {
			putBuf(buf)
			s.log.Error("encoding a batch failed", "err", err)
			return
		}
		*buf = append((*buf)[:0], raw...)
		f = frame{buf: *buf, typ: websocket.MessageText}
	}

	if s.enqueue(f, len(updates)) {
		s.sent.Add(uint64(len(updates)))
		s.hub.addSent(uint64(len(updates)))
	} else {
		putBuf(buf)
	}
}

// enqueue offers a frame to the writer without ever blocking. n is the number
// of updates the frame carries, counted as dropped if it does not fit.
func (s *Session) enqueue(f frame, n int) bool {
	select {
	case s.frames <- f:
		return true
	default:
		s.dropped.Add(uint64(n))
		s.droppedFrames.Add(1)
		s.hub.addDropped(uint64(n))
		return false
	}
}

// writeLoop drains the frame queue onto the socket.
func (s *Session) writeLoop(ctx context.Context) error {
	for f := range s.frames {
		wctx, cancel := context.WithTimeout(ctx, writeTimeout)
		err := s.conn.Write(wctx, f.typ, f.buf)
		cancel()
		buf := f.buf
		putBuf(&buf)
		if err != nil {
			// Drain whatever the emitter still queues so it never blocks on a
			// channel nobody reads; it stops when the context is cancelled.
			go func() {
				for range s.frames { //nolint:revive // intentional drain
				}
			}()
			return err
		}
	}
	return nil
}

func getBuf() *[]byte {
	b, _ := bufPool.Get().(*[]byte)
	if b == nil {
		nb := make([]byte, 0, 8192)
		return &nb
	}
	return b
}

func putBuf(b *[]byte) {
	if b == nil || cap(*b) > 1<<20 {
		return
	}
	*b = (*b)[:0]
	bufPool.Put(b)
}

func nowMillis() int64 { return time.Now().UnixMilli() }

// isClosed reports whether err is just the peer going away.
func isClosed(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	switch websocket.CloseStatus(err) {
	case websocket.StatusNormalClosure, websocket.StatusGoingAway, websocket.StatusNoStatusRcvd:
		return true
	}
	return false
}
