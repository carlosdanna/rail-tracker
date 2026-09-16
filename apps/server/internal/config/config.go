// Package config defines the railsim server configuration: the flag set from
// spec §3 plus the matching RAIL_* environment variables.
package config

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Format is the wire format used for batch frames.
type Format string

const (
	// FormatJSON emits batches as JSON text frames.
	FormatJSON Format = "json"
	// FormatBin emits batches as the binary layout from spec §2.
	FormatBin Format = "bin"
)

// ParseFormat validates a wire format name.
func ParseFormat(s string) (Format, error) {
	switch Format(s) {
	case FormatJSON:
		return FormatJSON, nil
	case FormatBin:
		return FormatBin, nil
	default:
		return "", fmt.Errorf("invalid format %q (want json or bin)", s)
	}
}

// Config holds every tunable of the server. Zero values are not meaningful;
// build one with Parse or Default.
type Config struct {
	Addr      string        // listen address
	Rate      int           // default updates/sec per client
	Trains    int           // number of trains
	Lines     int           // number of generated lines
	Stations  int           // number of generated stations
	Seed      int64         // world seed
	Tick      time.Duration // simulation step
	EmitTick  time.Duration // emitter batch interval
	World     string        // path to world.json, empty means generate
	Accel     bool          // enable the acceleration model
	HideState bool          // omit train state from the stream
	Format    Format        // default wire format
}

// Default returns the configuration described by the spec §3 defaults.
func Default() Config {
	return Config{
		Addr:     ":8080",
		Rate:     1000,
		Trains:   100,
		Lines:    6,
		Stations: 30,
		Seed:     42,
		Tick:     50 * time.Millisecond,
		EmitTick: 20 * time.Millisecond,
		Format:   FormatJSON,
	}
}

// envName maps a flag name to its environment variable: --emit-tick becomes
// RAIL_EMIT_TICK.
func envName(flagName string) string {
	return "RAIL_" + strings.ToUpper(strings.ReplaceAll(flagName, "-", "_"))
}

// Parse builds a Config from args (without the program name). Environment
// variables supply defaults; an explicitly passed flag always wins.
//
// lookupEnv is normally os.LookupEnv; tests pass their own.
func Parse(args []string, lookupEnv func(string) (string, bool)) (Config, error) {
	if lookupEnv == nil {
		lookupEnv = os.LookupEnv
	}
	cfg := Default()

	fs := flag.NewFlagSet("railsim", flag.ContinueOnError)
	fs.StringVar(&cfg.Addr, "addr", cfg.Addr, "listen address")
	fs.IntVar(&cfg.Rate, "rate", cfg.Rate, "total updates/sec per client")
	fs.IntVar(&cfg.Trains, "trains", cfg.Trains, "number of trains")
	fs.IntVar(&cfg.Lines, "lines", cfg.Lines, "number of generated lines")
	fs.IntVar(&cfg.Stations, "stations", cfg.Stations, "number of generated stations")
	fs.Int64Var(&cfg.Seed, "seed", cfg.Seed, "world seed")
	fs.DurationVar(&cfg.Tick, "tick", cfg.Tick, "simulation step")
	fs.DurationVar(&cfg.EmitTick, "emit-tick", cfg.EmitTick, "emitter batch interval")
	fs.StringVar(&cfg.World, "world", cfg.World, "path to world.json (overrides generation)")
	fs.BoolVar(&cfg.Accel, "accel", cfg.Accel, "enable acceleration model")
	fs.BoolVar(&cfg.HideState, "hide-state", cfg.HideState, "omit train state from the stream")
	format := fs.String("format", string(cfg.Format), "default wire format (json|bin)")

	// Environment variables become the flag defaults, so a flag given on the
	// command line still takes precedence.
	var envErr error
	fs.VisitAll(func(f *flag.Flag) {
		v, ok := lookupEnv(envName(f.Name))
		if !ok {
			return
		}
		if err := f.Value.Set(v); err != nil {
			envErr = errors.Join(envErr, fmt.Errorf("%s=%q: %w", envName(f.Name), v, err))
		}
	})
	if envErr != nil {
		return Config{}, envErr
	}

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if fs.NArg() > 0 {
		return Config{}, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}

	f, err := ParseFormat(*format)
	if err != nil {
		return Config{}, err
	}
	cfg.Format = f

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate reports configuration that the simulation cannot run with.
func (c Config) Validate() error {
	var errs error
	if c.Addr == "" {
		errs = errors.Join(errs, errors.New("addr must not be empty"))
	}
	if c.Rate < 0 {
		errs = errors.Join(errs, fmt.Errorf("rate must be >= 0, got %d", c.Rate))
	}
	if c.Trains < 1 {
		errs = errors.Join(errs, fmt.Errorf("trains must be >= 1, got %d", c.Trains))
	}
	if c.World == "" {
		if c.Lines < 1 {
			errs = errors.Join(errs, fmt.Errorf("lines must be >= 1, got %d", c.Lines))
		}
		if c.Stations < 3 {
			errs = errors.Join(errs, fmt.Errorf("stations must be >= 3, got %d", c.Stations))
		}
	}
	if c.Tick <= 0 {
		errs = errors.Join(errs, fmt.Errorf("tick must be > 0, got %s", c.Tick))
	}
	if c.EmitTick <= 0 {
		errs = errors.Join(errs, fmt.Errorf("emit-tick must be > 0, got %s", c.EmitTick))
	}
	return errs
}

// String renders the configuration as a single stable line, used by the
// startup banner and by tests.
func (c Config) String() string {
	fields := []struct {
		k, v string
	}{
		{"addr", c.Addr},
		{"rate", strconv.Itoa(c.Rate)},
		{"trains", strconv.Itoa(c.Trains)},
		{"lines", strconv.Itoa(c.Lines)},
		{"stations", strconv.Itoa(c.Stations)},
		{"seed", strconv.FormatInt(c.Seed, 10)},
		{"tick", c.Tick.String()},
		{"emit-tick", c.EmitTick.String()},
		{"world", c.World},
		{"accel", strconv.FormatBool(c.Accel)},
		{"hide-state", strconv.FormatBool(c.HideState)},
		{"format", string(c.Format)},
	}
	parts := make([]string, 0, len(fields))
	for _, f := range fields {
		parts = append(parts, f.k+"="+f.v)
	}
	return strings.Join(parts, " ")
}
