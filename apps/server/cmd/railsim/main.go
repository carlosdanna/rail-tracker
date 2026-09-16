// Command railsim simulates trains on generated rail lines and streams their
// positions over WebSocket. See docs/SPEC.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/carlosdanna/rail-tracker/server/internal/config"
	"github.com/carlosdanna/rail-tracker/server/internal/httpapi"
	"github.com/carlosdanna/rail-tracker/server/internal/sim"
	"github.com/carlosdanna/rail-tracker/server/internal/stream"
	"github.com/carlosdanna/rail-tracker/server/internal/world"
)

// shutdownGrace is how long in-flight requests get to finish after a signal.
const shutdownGrace = 5 * time.Second

func main() {
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(2)
		}
		fmt.Fprintln(os.Stderr, "railsim:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cfg, err := config.Parse(args, os.LookupEnv)
	if err != nil {
		return err
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)
	log.Info("railsim starting", "config", cfg.String())

	w, err := buildWorld(cfg)
	if err != nil {
		return err
	}
	log.Info("world ready",
		"source", worldSource(cfg),
		"stations", len(w.Stations),
		"lines", len(w.Lines),
		"trains", len(w.Trains),
	)

	// SIGINT/SIGTERM cancel this context, which unwinds everything below.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	opts := sim.DefaultOptions(cfg.Seed)
	opts.Accel = cfg.Accel
	s := sim.New(w, opts)

	simDone := make(chan struct{})
	go func() {
		defer close(simDone)
		s.Run(ctx, cfg.Tick)
	}()

	hub := stream.NewHub(s, cfg.Rate, log)
	api := httpapi.New(ctx, cfg, s, hub, log)

	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", cfg.Addr, err)
	}
	httpSrv := &http.Server{
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return context.Background() },
	}

	serveErr := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", ln.Addr().String())
		err := httpSrv.Serve(ln)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serveErr <- err
	}()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
		log.Info("shutting down", "grace", shutdownGrace)
	}

	shutCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := httpSrv.Shutdown(shutCtx); err != nil {
		log.Warn("graceful shutdown timed out", "err", err)
		if err := httpSrv.Close(); err != nil {
			log.Warn("forced close failed", "err", err)
		}
	}
	<-simDone
	log.Info("stopped", "clients", hub.Clients())
	return <-serveErr
}

// buildWorld loads world.json when --world is set, and otherwise generates a
// world from the seed.
func buildWorld(cfg config.Config) (*world.World, error) {
	if cfg.World != "" {
		return world.Load(cfg.World)
	}
	return world.Generate(world.GenParams{
		Seed:     cfg.Seed,
		Bounds:   world.Bounds{W: 1000, H: 1000},
		Stations: cfg.Stations,
		Lines:    cfg.Lines,
		Trains:   cfg.Trains,
	})
}

func worldSource(cfg config.Config) string {
	if cfg.World != "" {
		return cfg.World
	}
	return fmt.Sprintf("generated(seed=%d)", cfg.Seed)
}
