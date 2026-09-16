package stream

import (
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/carlosdanna/rail-tracker/server/internal/sim"
)

// Hub owns the live sessions and the counters behind /metrics.
type Hub struct {
	sim *sim.Sim
	log *slog.Logger

	mu       sync.RWMutex
	sessions map[uint64]*Session

	nextID      atomic.Uint64
	defaultRate atomic.Int64

	sentTotal    atomic.Uint64
	droppedTotal atomic.Uint64
}

// NewHub creates a hub over s with the given starting default rate.
func NewHub(s *sim.Sim, defaultRate int, log *slog.Logger) *Hub {
	if log == nil {
		log = slog.Default()
	}
	h := &Hub{sim: s, log: log, sessions: make(map[uint64]*Session)}
	h.defaultRate.Store(int64(defaultRate))
	return h
}

// DefaultRate returns the rate new connections start at.
func (h *Hub) DefaultRate() int { return int(h.defaultRate.Load()) }

// SetDefaultRate changes the default and applies it to every client that has
// not chosen a rate of its own. It reports how many sessions it touched.
func (h *Hub) SetDefaultRate(rate int) int {
	if rate < 0 {
		rate = 0
	}
	h.defaultRate.Store(int64(rate))

	h.mu.RLock()
	defer h.mu.RUnlock()
	n := 0
	for _, s := range h.sessions {
		if !s.overridden.Load() {
			s.SetRate(rate, false)
			n++
		}
	}
	return n
}

// NewSession registers a session for conn. The caller runs it.
func (h *Hub) NewSession(conn *websocket.Conn, opts Options) *Session {
	if opts.EmitTick <= 0 {
		opts.EmitTick = 20 * time.Millisecond
	}
	id := h.nextID.Add(1)
	s := &Session{
		id:     id,
		conn:   conn,
		sim:    h.sim,
		log:    h.log.With("session", id),
		opts:   opts,
		frames: make(chan frame, queueDepth),
		hub:    h,
	}
	s.SetRate(opts.Rate, opts.RateOverridden)

	h.mu.Lock()
	h.sessions[s.id] = s
	h.mu.Unlock()
	return s
}

// Remove unregisters a finished session. Its counters stay in the totals.
func (h *Hub) Remove(s *Session) {
	h.mu.Lock()
	delete(h.sessions, s.id)
	h.mu.Unlock()
}

// Clients returns the number of live sessions.
func (h *Hub) Clients() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.sessions)
}

func (h *Hub) addSent(n uint64)    { h.sentTotal.Add(n) }
func (h *Hub) addDropped(n uint64) { h.droppedTotal.Add(n) }

// Metrics is the /metrics payload from spec §2.
type Metrics struct {
	Clients      int     `json:"clients"`
	SentTotal    uint64  `json:"sentTotal"`
	DroppedTotal uint64  `json:"droppedTotal"`
	SimTickMs    float64 `json:"simTickMs"`
	DefaultRate  int     `json:"defaultRate"`
	PerClient    []Stats `json:"perClient"`
}

// Metrics collects the current counters. Per-client rows are sorted by id so
// the output is stable across calls.
func (h *Hub) Metrics() Metrics {
	h.mu.RLock()
	per := make([]Stats, 0, len(h.sessions))
	for _, s := range h.sessions {
		per = append(per, s.Stats())
	}
	h.mu.RUnlock()
	sort.Slice(per, func(i, j int) bool { return per[i].ID < per[j].ID })

	return Metrics{
		Clients:      len(per),
		SentTotal:    h.sentTotal.Load(),
		DroppedTotal: h.droppedTotal.Load(),
		SimTickMs:    float64(h.sim.TickDuration()) / float64(time.Millisecond),
		DefaultRate:  h.DefaultRate(),
		PerClient:    per,
	}
}
