package world

import (
	"bytes"
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
