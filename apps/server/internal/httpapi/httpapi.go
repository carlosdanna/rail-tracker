// Package httpapi exposes the server's HTTP surface from spec §2: the
// /stream WebSocket endpoint plus /world, /metrics, /config and /healthz.
package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"

	"github.com/carlosdanna/rail-tracker/server/internal/config"
	"github.com/carlosdanna/rail-tracker/server/internal/sim"
	"github.com/carlosdanna/rail-tracker/server/internal/stream"
)

// Server wires the HTTP routes to the simulation and the session hub.
type Server struct {
	cfg config.Config
	sim *sim.Sim
	hub *stream.Hub
	log *slog.Logger

	// baseCtx bounds every session; it is cancelled on shutdown.
	baseCtx context.Context
	started time.Time
}

// New builds the HTTP server. baseCtx is the lifetime of the process: when it
// is cancelled, in-flight sessions wind down.
func New(baseCtx context.Context, cfg config.Config, s *sim.Sim, hub *stream.Hub, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{cfg: cfg, sim: s, hub: hub, log: log, baseCtx: baseCtx, started: time.Now()}
}

// Handler returns the router for all routes.
func (srv *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/stream", srv.handleStream)
	mux.HandleFunc("GET /world", srv.handleWorld)
	mux.HandleFunc("GET /metrics", srv.handleMetrics)
	mux.HandleFunc("POST /config", srv.handleConfig)
	mux.HandleFunc("GET /healthz", srv.handleHealthz)
	return mux
}

// handleStream upgrades the connection and runs a session on it.
func (srv *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	format := srv.cfg.Format
	if v := r.URL.Query().Get("format"); v != "" {
		f, err := config.ParseFormat(v)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		format = f
	}

	rate, overridden := srv.hub.DefaultRate(), false
	if v := r.URL.Query().Get("rate"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			http.Error(w, "rate must be a non-negative integer", http.StatusBadRequest)
			return
		}
		rate, overridden = n, true
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The client is served from a different origin in dev (Vite proxies,
		// but direct connections are useful too), and this endpoint is
		// read-only telemetry.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		srv.log.Warn("websocket upgrade failed", "err", err, "remote", r.RemoteAddr)
		return
	}
	defer conn.CloseNow() //nolint:errcheck // best effort on the way out

	sess := srv.hub.NewSession(conn, stream.Options{
		Rate:           rate,
		RateOverridden: overridden,
		Format:         format,
		HideState:      srv.cfg.HideState,
		EmitTick:       srv.cfg.EmitTick,
		Remote:         r.RemoteAddr,
	})
	defer srv.hub.Remove(sess)

	srv.log.Info("client connected",
		"remote", r.RemoteAddr, "format", format, "rate", rate, "clients", srv.hub.Clients())

	// The session ends when the peer goes away, when the request context ends,
	// or when the process is shutting down.
	ctx, cancel := context.WithCancel(srv.baseCtx)
	defer cancel()
	go func() {
		select {
		case <-r.Context().Done():
			cancel()
		case <-ctx.Done():
		}
	}()

	if err := sess.Run(ctx); err != nil {
		srv.log.Info("client disconnected", "remote", r.RemoteAddr, "err", err)
	} else {
		srv.log.Info("client disconnected", "remote", r.RemoteAddr)
	}
	conn.Close(websocket.StatusNormalClosure, "") //nolint:errcheck // best effort
}

// handleWorld serves the full world for verification, as /world in spec §2.
func (srv *Server) handleWorld(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, srv.sim.World())
}

// handleMetrics serves the counters from spec §2.
func (srv *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, srv.hub.Metrics())
}

// handleConfig changes the default rate for clients that have not overridden it.
func (srv *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Rate *int `json:"rate"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if body.Rate == nil {
		http.Error(w, `body must contain a "rate"`, http.StatusBadRequest)
		return
	}
	if *body.Rate < 0 {
		http.Error(w, "rate must be non-negative", http.StatusBadRequest)
		return
	}

	applied := srv.hub.SetDefaultRate(*body.Rate)
	srv.log.Info("default rate changed", "rate", *body.Rate, "clientsUpdated", applied)
	writeJSON(w, http.StatusOK, map[string]any{
		"rate":           *body.Rate,
		"clientsUpdated": applied,
	})
}

func (srv *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	snap := srv.sim.Latest()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"tick":    snap.Tick,
		"simTime": snap.SimTime.String(),
		"uptime":  time.Since(srv.started).Round(time.Millisecond).String(),
		"clients": srv.hub.Clients(),
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Debug("writing a JSON response failed", "err", err)
	}
}
