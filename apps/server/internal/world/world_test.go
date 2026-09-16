package world

import (
	"bytes"
	"math"
	"strings"
	"testing"
)

func defaultParams(seed int64) GenParams {
	return GenParams{
		Seed:     seed,
		Bounds:   Bounds{W: 1000, H: 1000},
		Stations: 30,
		Lines:    6,
		Trains:   100,
	}
}

func mustGenerate(t *testing.T, p GenParams) *World {
	t.Helper()
	w, err := Generate(p)
	if err != nil {
		t.Fatalf("Generate(seed=%d): %v", p.Seed, err)
	}
	return w
}

func mustJSON(t *testing.T, w *World) []byte {
	t.Helper()
	b, err := w.JSON()
	if err != nil {
		t.Fatalf("JSON: %v", err)
	}
	return b
}

func TestGenerateIsDeterministic(t *testing.T) {
	a := mustJSON(t, mustGenerate(t, defaultParams(42)))
	b := mustJSON(t, mustGenerate(t, defaultParams(42)))
	if !bytes.Equal(a, b) {
		t.Fatal("the same seed produced different JSON")
	}
}

func TestDifferentSeedsDiffer(t *testing.T) {
	a := mustJSON(t, mustGenerate(t, defaultParams(42)))
	b := mustJSON(t, mustGenerate(t, defaultParams(43)))
	if bytes.Equal(a, b) {
		t.Fatal("seeds 42 and 43 produced identical JSON")
	}
}

// TestInvariantsAcrossSeeds asserts every spec §1 generation constraint over a
// wide range of seeds, not just the default one.
func TestInvariantsAcrossSeeds(t *testing.T) {
	for seed := int64(0); seed < 100; seed++ {
		p := defaultParams(seed)
		w := mustGenerate(t, p)

		if err := w.Validate(); err != nil {
			t.Fatalf("seed %d: Validate: %v", seed, err)
		}

		// Stations are at least the (possibly relaxed) minimum distance apart.
		floor := MinStationDistance(w.Bounds, len(w.Stations)) * RelaxFloor
		if got := w.MinStationSpacing(); got < floor {
			t.Fatalf("seed %d: closest stations are %g apart, want >= %g", seed, got, floor)
		}

		served := make(map[StationID]bool, len(w.Stations))
		perLine := make(map[string]int, len(w.Lines))

		for i := range w.Lines {
			l := &w.Lines[i]

			// 3-8 stops per line.
			if n := len(l.Stops); n < MinStops || n > MaxStops {
				t.Fatalf("seed %d: line %s has %d stops, want %d-%d", seed, l.ID, n, MinStops, MaxStops)
			}
			if !l.Kind.Valid() {
				t.Fatalf("seed %d: line %s has kind %q", seed, l.ID, l.Kind)
			}
			for _, sid := range l.Stops {
				served[sid] = true
			}

			// 0-3 waypoints between consecutive stops, and the track visits the
			// stops in order starting at Track[0].
			if l.StopTrackIndex(0) != 0 {
				t.Fatalf("seed %d: line %s does not start at its first stop", seed, l.ID)
			}
			for j := 0; j+1 < len(l.Stops); j++ {
				gap := l.StopTrackIndex(j+1) - l.StopTrackIndex(j) - 1
				if gap < 0 || gap > MaxWaypoints {
					t.Fatalf("seed %d: line %s has %d waypoints between stops %d and %d",
						seed, l.ID, gap, j, j+1)
				}
			}
			lastStop := l.StopTrackIndex(len(l.Stops) - 1)
			closing := len(l.Track) - 1 - lastStop
			switch l.Kind {
			case KindLoop:
				if closing < 0 || closing > MaxWaypoints {
					t.Fatalf("seed %d: loop %s has %d waypoints on its closing gap", seed, l.ID, closing)
				}
			case KindShuttle:
				if closing != 0 {
					t.Fatalf("seed %d: shuttle %s has %d points after its last stop", seed, l.ID, closing)
				}
			}

			// Every track vertex is inside the world bounds.
			for k, pt := range l.Track {
				if pt.X < 0 || pt.X > w.Bounds.W || pt.Y < 0 || pt.Y > w.Bounds.H {
					t.Fatalf("seed %d: line %s point %d at (%g, %g) is out of bounds",
						seed, l.ID, k, pt.X, pt.Y)
				}
			}
		}

		// Every station is served by at least one line.
		for _, s := range w.Stations {
			if !served[s.ID] {
				t.Fatalf("seed %d: station %s is not served by any line", seed, s.ID)
			}
		}

		// Trains are spread across the lines and staggered along each track.
		if len(w.Trains) != p.Trains {
			t.Fatalf("seed %d: got %d trains, want %d", seed, len(w.Trains), p.Trains)
		}
		arcs := make(map[string][]float64, len(w.Lines))
		for _, tr := range w.Trains {
			perLine[tr.LineID]++
			l, ok := w.Line(tr.LineID)
			if !ok {
				t.Fatalf("seed %d: train %s on unknown line %s", seed, tr.ID, tr.LineID)
			}
			arc := tr.Progress
			for s := 0; s < tr.SegmentIndex; s++ {
				arc += l.SegmentLen(s)
			}
			arcs[tr.LineID] = append(arcs[tr.LineID], arc)
		}
		for _, l := range w.Lines {
			if perLine[l.ID] == 0 {
				t.Fatalf("seed %d: line %s has no trains", seed, l.ID)
			}
			if perLine[l.ID] > p.Trains/p.Lines+1 {
				t.Fatalf("seed %d: line %s has %d trains, distribution is uneven", seed, l.ID, perLine[l.ID])
			}
			// Staggered: no two trains on a line start at the same arc offset.
			seen := arcs[l.ID]
			for i := range seen {
				for j := i + 1; j < len(seen); j++ {
					if seen[i] == seen[j] {
						t.Fatalf("seed %d: line %s has two trains at arc %g", seed, l.ID, seen[i])
					}
				}
			}
		}
	}
}

func TestGenerateRejectsImpossibleParams(t *testing.T) {
	cases := []struct {
		name string
		p    GenParams
		want string
	}{
		{"too few stations", GenParams{Seed: 1, Bounds: Bounds{1000, 1000}, Stations: 2, Lines: 2, Trains: 2}, "at least 3 stations"},
		{"no lines", GenParams{Seed: 1, Bounds: Bounds{1000, 1000}, Stations: 10, Lines: 0, Trains: 2}, "at least 1 line"},
		{"no trains", GenParams{Seed: 1, Bounds: Bounds{1000, 1000}, Stations: 10, Lines: 2, Trains: 0}, "at least 1 train"},
		{"unservable", GenParams{Seed: 1, Bounds: Bounds{1000, 1000}, Stations: 40, Lines: 2, Trains: 4}, "cannot serve"},
		{"degenerate bounds", GenParams{Seed: 1, Bounds: Bounds{0, 0}, Stations: 10, Lines: 2, Trains: 2}, "bounds must be positive"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Generate(tc.p)
			if err == nil {
				t.Fatal("want an error, got nil")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

func TestRoundTripThroughJSON(t *testing.T) {
	orig := mustGenerate(t, defaultParams(7))
	encoded := mustJSON(t, orig)

	got, err := Decode(bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if !bytes.Equal(encoded, mustJSON(t, got)) {
		t.Fatal("re-encoding a decoded world changed its JSON")
	}

	// Derived state survives the round trip.
	for i := range orig.Lines {
		a, b := &orig.Lines[i], &got.Lines[i]
		if a.TotalLen() != b.TotalLen() {
			t.Fatalf("line %s: total length %g != %g", a.ID, a.TotalLen(), b.TotalLen())
		}
		for j := range a.Stops {
			if a.StopTrackIndex(j) != b.StopTrackIndex(j) {
				t.Fatalf("line %s: stop %d maps to track point %d != %d",
					a.ID, j, a.StopTrackIndex(j), b.StopTrackIndex(j))
			}
		}
	}
}

// TestLargeWorld covers the shape a big map is actually configured with: a
// plane far larger than the 1000x1000 default, many more stations than six
// lines of eight stops could serve, and thousands of trains.
func TestLargeWorld(t *testing.T) {
	p := GenParams{
		Seed:     42,
		Bounds:   Bounds{W: 200_000, H: 200_000},
		Stations: 2000,
		Lines:    120,
		Trains:   5000,
		MaxStops: 24,
	}
	w := mustGenerate(t, p)

	if len(w.Stations) != 2000 || len(w.Lines) != 120 || len(w.Trains) != 5000 {
		t.Fatalf("got %d stations, %d lines, %d trains",
			len(w.Stations), len(w.Lines), len(w.Trains))
	}
	if w.Bounds.W != 200_000 || w.Bounds.H != 200_000 {
		t.Fatalf("bounds = %gx%g", w.Bounds.W, w.Bounds.H)
	}

	served := make(map[StationID]bool, len(w.Stations))
	for i := range w.Lines {
		l := &w.Lines[i]
		if n := len(l.Stops); n < MinStops || n > p.MaxStops {
			t.Fatalf("line %s has %d stops, want %d-%d", l.ID, n, MinStops, p.MaxStops)
		}
		for _, sid := range l.Stops {
			served[sid] = true
		}
		for k, pt := range l.Track {
			if pt.X < 0 || pt.X > w.Bounds.W || pt.Y < 0 || pt.Y > w.Bounds.H {
				t.Fatalf("line %s point %d is outside the bounds at (%g, %g)", l.ID, k, pt.X, pt.Y)
			}
		}
	}
	for _, st := range w.Stations {
		if !served[st.ID] {
			t.Fatalf("station %s is not served by any line", st.ID)
		}
	}

	// Spacing scales with the world, so stations are not bunched into a corner.
	floor := MinStationDistance(w.Bounds, len(w.Stations)) * RelaxFloor
	if got := w.MinStationSpacing(); got < floor {
		t.Fatalf("closest stations are %g apart, want >= %g", got, floor)
	}
}

// TestSpeedScalesWithTheWorld is the reason a big map is usable at all: if
// trains kept the speed tuned for a 1000-unit world, a lap of a 200,000-unit
// line would take the better part of an hour and no client would ever see one.
func TestSpeedScalesWithTheWorld(t *testing.T) {
	lapSeconds := func(w *World) (fastest, slowest float64) {
		fastest, slowest = math.Inf(1), 0
		for _, tr := range w.Trains {
			l, ok := w.Line(tr.LineID)
			if !ok {
				t.Fatalf("train %s on unknown line", tr.ID)
			}
			lap := l.TotalLen() / tr.MaxSpeed
			if lap < fastest {
				fastest = lap
			}
			if lap > slowest {
				slowest = lap
			}
		}
		return fastest, slowest
	}

	base := mustGenerate(t, defaultParams(42))
	baseFast, baseSlow := lapSeconds(base)

	big := mustGenerate(t, GenParams{
		Seed: 42, Bounds: Bounds{W: 200_000, H: 200_000},
		Stations: 30, Lines: 6, Trains: 60,
	})
	bigFast, bigSlow := lapSeconds(big)

	// A 200x bigger world should take a comparable time to get round, not 200x
	// longer. Allow a wide band: track layout differs between the two worlds.
	if bigFast < baseFast/3 || bigFast > baseFast*3 {
		t.Fatalf("fastest lap %.0fs on the big world vs %.0fs on the default", bigFast, baseFast)
	}
	if bigSlow < baseSlow/3 || bigSlow > baseSlow*3 {
		t.Fatalf("slowest lap %.0fs on the big world vs %.0fs on the default", bigSlow, baseSlow)
	}
}

func TestMaxSpeedOverride(t *testing.T) {
	w := mustGenerate(t, GenParams{
		Seed: 1, Bounds: Bounds{W: 50_000, H: 50_000},
		Stations: 30, Lines: 6, Trains: 30,
		MaxSpeed: 1234,
	})
	for _, tr := range w.Trains {
		if tr.MaxSpeed > 1234 || tr.MaxSpeed < 1234*0.6 {
			t.Fatalf("train %s has speed %g, want within [%g, 1234]", tr.ID, tr.MaxSpeed, 1234*0.6)
		}
	}
}

func TestDefaultMaxSpeed(t *testing.T) {
	// The default world keeps exactly the speed the rest of the suite is
	// tuned against; everything else is proportional to the shorter side.
	if got := DefaultMaxSpeed(Bounds{W: 1000, H: 1000}); got != 50 {
		t.Fatalf("DefaultMaxSpeed on the reference world = %g, want 50", got)
	}
	if got := DefaultMaxSpeed(Bounds{W: 100_000, H: 100_000}); got != 5000 {
		t.Fatalf("DefaultMaxSpeed = %g, want 5000", got)
	}
	if got := DefaultMaxSpeed(Bounds{W: 200_000, H: 2000}); got != 100 {
		t.Fatalf("DefaultMaxSpeed uses the shorter side, got %g, want 100", got)
	}
}

// TestDefaultWorldUnchanged pins the behaviour the golden fixtures and the
// determinism guarantee depend on: making the world configurable must not have
// moved the default one.
func TestDefaultWorldUnchanged(t *testing.T) {
	explicit := mustGenerate(t, GenParams{
		Seed: 42, Bounds: Bounds{W: 1000, H: 1000},
		Stations: 30, Lines: 6, Trains: 100,
		MaxStops: 8, MaxSpeed: 50,
	})
	implicit := mustGenerate(t, defaultParams(42))
	if !bytes.Equal(mustJSON(t, explicit), mustJSON(t, implicit)) {
		t.Fatal("spelling out the defaults produced a different world")
	}
	for _, tr := range implicit.Trains {
		if tr.MaxSpeed < 30 || tr.MaxSpeed > 50 {
			t.Fatalf("train %s speed %g is outside the historical 30-50 range", tr.ID, tr.MaxSpeed)
		}
	}
}
