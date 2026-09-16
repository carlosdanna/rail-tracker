// Command loadclient opens N streaming connections to a railsim server and
// reports throughput and sequence gaps. It backs `make bench`.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"

	"github.com/carlosdanna/rail-tracker/server/internal/encode"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "loadclient:", err)
		os.Exit(1)
	}
}

type options struct {
	addr     string
	conns    int
	rate     int
	format   string
	duration time.Duration
	interval time.Duration
}

func run() error {
	var o options
	flag.StringVar(&o.addr, "addr", "localhost:8080", "railsim address")
	flag.IntVar(&o.conns, "conns", 8, "number of concurrent connections")
	flag.IntVar(&o.rate, "rate", 1000, "updates/sec requested per connection")
	flag.StringVar(&o.format, "format", "bin", "wire format (json|bin)")
	flag.DurationVar(&o.duration, "duration", 10*time.Second, "how long to run; 0 means until interrupted")
	flag.DurationVar(&o.interval, "interval", time.Second, "reporting interval")
	flag.Parse()

	if o.conns < 1 {
		return fmt.Errorf("conns must be >= 1, got %d", o.conns)
	}
	if o.format != "json" && o.format != "bin" {
		return fmt.Errorf("format must be json or bin, got %q", o.format)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if o.duration > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, o.duration)
		defer cancel()
	}

	url := fmt.Sprintf("ws://%s/stream?rate=%d&format=%s", strings.TrimPrefix(o.addr, "http://"), o.rate, o.format)
	fmt.Printf("loadclient: %d connections to %s\n", o.conns, url)

	var st stats
	var wg sync.WaitGroup
	for i := 0; i < o.conns; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			if err := stream(ctx, url, &st); err != nil && !isExpected(err) {
				fmt.Fprintf(os.Stderr, "conn %d: %v\n", id, err)
				st.errors.Add(1)
			}
		}(i)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		report(ctx, &st, o)
	}()

	wg.Wait()
	<-done
	st.summary(o)
	return nil
}

// stats are shared across every connection.
type stats struct {
	updates atomic.Uint64
	frames  atomic.Uint64
	bytes   atomic.Uint64
	gaps    atomic.Uint64
	missing atomic.Uint64
	errors  atomic.Uint64
	conns   atomic.Int64
}

// stream runs one connection until ctx ends, counting what arrives.
func stream(ctx context.Context, url string, st *stats) error {
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.CloseNow() //nolint:errcheck // best effort
	conn.SetReadLimit(64 << 20)

	st.conns.Add(1)
	defer st.conns.Add(-1)

	var lastSeq uint32
	var haveSeq bool
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		st.frames.Add(1)
		st.bytes.Add(uint64(len(data)))

		seqs, n := decode(typ, data)
		st.updates.Add(uint64(n))
		for _, seq := range seqs {
			if haveSeq && seq != lastSeq+1 {
				st.gaps.Add(1)
				if seq > lastSeq {
					st.missing.Add(uint64(seq - lastSeq - 1))
				}
			}
			lastSeq, haveSeq = seq, true
		}
	}
}

// decode pulls the sequence numbers out of a frame.
func decode(typ websocket.MessageType, data []byte) ([]uint32, int) {
	if typ == websocket.MessageBinary {
		if len(data) < encode.HeaderSize {
			return nil, 0
		}
		n := int(binary.LittleEndian.Uint16(data[2:4]))
		seqs := make([]uint32, 0, n)
		for i := 0; i < n; i++ {
			off := encode.HeaderSize + i*encode.RecordSize
			if off+encode.RecordSize > len(data) {
				break
			}
			seqs = append(seqs, binary.LittleEndian.Uint32(data[off+17:off+21]))
		}
		return seqs, len(seqs)
	}

	var b struct {
		Type    string `json:"type"`
		Updates []struct {
			Seq uint32 `json:"seq"`
		} `json:"updates"`
	}
	if err := json.Unmarshal(data, &b); err != nil || b.Type != "batch" {
		return nil, 0
	}
	seqs := make([]uint32, len(b.Updates))
	for i, u := range b.Updates {
		seqs[i] = u.Seq
	}
	return seqs, len(seqs)
}

// report prints a throughput line every interval.
func report(ctx context.Context, st *stats, o options) {
	tk := time.NewTicker(o.interval)
	defer tk.Stop()

	var lastUpdates, lastBytes uint64
	last := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tk.C:
			u, b := st.updates.Load(), st.bytes.Load()
			elapsed := now.Sub(last).Seconds()
			fmt.Printf("conns=%d  updates/sec=%.0f  MiB/sec=%.2f  gaps=%d  missing=%d\n",
				st.conns.Load(),
				float64(u-lastUpdates)/elapsed,
				float64(b-lastBytes)/elapsed/(1<<20),
				st.gaps.Load(), st.missing.Load(),
			)
			lastUpdates, lastBytes, last = u, b, now
		}
	}
}

// summary prints the totals once the run is over.
func (st *stats) summary(o options) {
	updates := st.updates.Load()
	secs := o.duration.Seconds()
	if secs <= 0 {
		secs = 1
	}
	fmt.Println("---")
	fmt.Printf("connections   %d at %d updates/sec each (%d requested total)\n",
		o.conns, o.rate, o.conns*o.rate)
	fmt.Printf("received      %d updates in %d frames (%.1f MiB)\n",
		updates, st.frames.Load(), float64(st.bytes.Load())/(1<<20))
	fmt.Printf("throughput    %.0f updates/sec\n", float64(updates)/secs)
	fmt.Printf("seq gaps      %d (%d updates missing)\n", st.gaps.Load(), st.missing.Load())
	if e := st.errors.Load(); e > 0 {
		fmt.Printf("errors        %d\n", e)
	}
}

func isExpected(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	switch websocket.CloseStatus(err) {
	case websocket.StatusNormalClosure, websocket.StatusGoingAway:
		return true
	}
	return false
}
