package config

import (
	"strings"
	"testing"
	"time"
)

// envMap turns a map into a LookupEnv function.
func envMap(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) {
		v, ok := m[k]
		return v, ok
	}
}

func TestDefaults(t *testing.T) {
	cfg, err := Parse(nil, envMap(nil))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	want := Default()
	if cfg != want {
		t.Fatalf("got %+v, want %+v", cfg, want)
	}
	// Spot-check the spec §3 table.
	if cfg.Addr != ":8080" || cfg.Rate != 1000 || cfg.Trains != 100 ||
		cfg.Lines != 6 || cfg.Stations != 30 || cfg.Seed != 42 ||
		cfg.Tick != 50*time.Millisecond || cfg.EmitTick != 20*time.Millisecond ||
		cfg.Accel || cfg.HideState || cfg.Format != FormatJSON {
		t.Fatalf("defaults do not match spec §3: %s", cfg)
	}
}

func TestFlagsOverrideDefaults(t *testing.T) {
	cfg, err := Parse([]string{
		"--addr", "127.0.0.1:9000",
		"--rate", "10000",
		"--trains", "500",
		"--tick", "10ms",
		"--emit-tick", "5ms",
		"--accel",
		"--hide-state",
		"--format", "bin",
		"--seed", "7",
	}, envMap(nil))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Addr != "127.0.0.1:9000" || cfg.Rate != 10000 || cfg.Trains != 500 ||
		cfg.Tick != 10*time.Millisecond || cfg.EmitTick != 5*time.Millisecond ||
		!cfg.Accel || !cfg.HideState || cfg.Format != FormatBin || cfg.Seed != 7 {
		t.Fatalf("flags not applied: %s", cfg)
	}
}

func TestEnvironmentSetsValues(t *testing.T) {
	cfg, err := Parse(nil, envMap(map[string]string{
		"RAIL_ADDR":       ":9999",
		"RAIL_RATE":       "2500",
		"RAIL_EMIT_TICK":  "40ms",
		"RAIL_HIDE_STATE": "true",
		"RAIL_FORMAT":     "bin",
		"RAIL_WORLD":      "/tmp/world.json",
	}))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Addr != ":9999" || cfg.Rate != 2500 || cfg.EmitTick != 40*time.Millisecond ||
		!cfg.HideState || cfg.Format != FormatBin || cfg.World != "/tmp/world.json" {
		t.Fatalf("environment not applied: %s", cfg)
	}
}

func TestFlagBeatsEnvironment(t *testing.T) {
	cfg, err := Parse([]string{"--rate", "300"}, envMap(map[string]string{"RAIL_RATE": "2500"}))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Rate != 300 {
		t.Fatalf("rate = %d, want the flag value 300", cfg.Rate)
	}
}

func TestParseErrors(t *testing.T) {
	cases := []struct {
		name string
		args []string
		env  map[string]string
		want string
	}{
		{"bad format flag", []string{"--format", "protobuf"}, nil, "invalid format"},
		{"bad env duration", nil, map[string]string{"RAIL_TICK": "soon"}, "RAIL_TICK"},
		{"bad env int", nil, map[string]string{"RAIL_TRAINS": "many"}, "RAIL_TRAINS"},
		{"negative rate", []string{"--rate", "-1"}, nil, "rate must be >= 0"},
		{"zero trains", []string{"--trains", "0"}, nil, "trains must be >= 1"},
		{"zero tick", []string{"--tick", "0s"}, nil, "tick must be > 0"},
		{"stray argument", []string{"extra"}, nil, "unexpected argument"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse(tc.args, envMap(tc.env))
			if err == nil {
				t.Fatal("want an error, got nil")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

func TestWorldFileSkipsGenerationChecks(t *testing.T) {
	// stations/lines only constrain generation, so a loaded world ignores them.
	if _, err := Parse([]string{"--world", "w.json", "--stations", "0", "--lines", "0"}, envMap(nil)); err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if _, err := Parse([]string{"--stations", "0"}, envMap(nil)); err == nil {
		t.Fatal("want an error when generating with 0 stations")
	}
}

func TestWorldSizeFlags(t *testing.T) {
	cfg, err := Parse([]string{
		"--width", "200000",
		"--height", "150000",
		"--stations", "2000",
		"--lines", "120",
		"--stops-per-line", "24",
		"--speed", "8000",
		"--trains", "5000",
	}, envMap(nil))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Width != 200000 || cfg.Height != 150000 {
		t.Fatalf("bounds = %gx%g, want 200000x150000", cfg.Width, cfg.Height)
	}
	if cfg.Stations != 2000 || cfg.Lines != 120 || cfg.StopsPerLine != 24 {
		t.Fatalf("network = %d stations on %d lines of %d stops",
			cfg.Stations, cfg.Lines, cfg.StopsPerLine)
	}
	if cfg.Speed != 8000 || cfg.Trains != 5000 {
		t.Fatalf("speed = %g, trains = %d", cfg.Speed, cfg.Trains)
	}
}

func TestWorldSizeFromEnvironment(t *testing.T) {
	cfg, err := Parse(nil, envMap(map[string]string{
		"RAIL_WIDTH":          "100000",
		"RAIL_HEIGHT":         "100000",
		"RAIL_STOPS_PER_LINE": "16",
		"RAIL_SPEED":          "4000",
	}))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Width != 100000 || cfg.Height != 100000 || cfg.StopsPerLine != 16 || cfg.Speed != 4000 {
		t.Fatalf("environment not applied: %s", cfg)
	}
}

func TestWorldSizeDefaults(t *testing.T) {
	cfg := Default()
	// Spec §1: the default plane is 1000x1000, and speed 0 means "derive it".
	if cfg.Width != 1000 || cfg.Height != 1000 {
		t.Fatalf("default bounds = %gx%g, want 1000x1000", cfg.Width, cfg.Height)
	}
	if cfg.StopsPerLine != 8 || cfg.Speed != 0 {
		t.Fatalf("default stops-per-line = %d, speed = %g", cfg.StopsPerLine, cfg.Speed)
	}
}

func TestWorldSizeValidation(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"zero width", []string{"--width", "0"}, "width and height must be > 0"},
		{"negative height", []string{"--height", "-1"}, "width and height must be > 0"},
		{"negative speed", []string{"--speed", "-1"}, "speed must be >= 0"},
		{"stops below the minimum", []string{"--stops-per-line", "2"}, "stops-per-line must be >= 3"},
		{
			"more stations than the lines can serve",
			[]string{"--stations", "2000", "--lines", "6"},
			"raise --lines or --stops-per-line",
		},
		{
			// The binary record addresses trains with a u16.
			"more trains than the protocol can address",
			[]string{"--trains", "70000"},
			"trains must be <= 65535",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse(tc.args, envMap(nil))
			if err == nil {
				t.Fatal("want an error, got nil")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

func TestLargeNetworkIsAccepted(t *testing.T) {
	// 2000 stations only needs enough line capacity to cover them.
	if _, err := Parse([]string{
		"--stations", "2000", "--lines", "120", "--stops-per-line", "24",
	}, envMap(nil)); err != nil {
		t.Fatalf("Parse: %v", err)
	}
	// And the ceiling on trains is exactly the protocol's.
	if _, err := Parse([]string{"--trains", "65535"}, envMap(nil)); err != nil {
		t.Fatalf("Parse at MaxTrains: %v", err)
	}
}

func TestEnvName(t *testing.T) {
	for flagName, want := range map[string]string{
		"addr":           "RAIL_ADDR",
		"emit-tick":      "RAIL_EMIT_TICK",
		"hide-state":     "RAIL_HIDE_STATE",
		"stops-per-line": "RAIL_STOPS_PER_LINE",
		"width":          "RAIL_WIDTH",
	} {
		if got := envName(flagName); got != want {
			t.Fatalf("envName(%q) = %q, want %q", flagName, got, want)
		}
	}
}
