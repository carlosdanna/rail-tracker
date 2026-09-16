package sim

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/carlosdanna/rail-tracker/server/internal/world"
)

const eps = 1e-6

// straightWorld builds a minimal world the tests fully control: one line whose
// track is given verbatim, and one train parked at Track[0].
func straightWorld(kind world.Kind, stops []world.Station, track []world.Point, speed float64) *world.World {
	ids := make([]world.StationID, len(stops))
	for i, s := range stops {
		ids[i] = s.ID
	}
	w := &world.World{
		Seed:     1,
		Bounds:   world.Bounds{W: 1000, H: 1000},
		Stations: stops,
		Lines: []world.Line{{
			ID:    "L-0",
			Name:  "Test",
			Color: "#000000",
			Kind:  kind,
			Stops: ids,
			Track: track,
		}},
		Trains: []world.Train{{
			ID: "T-0", LineID: "L-0", MaxSpeed: speed,
			SegmentIndex: 0, Progress: 0, Direction: 1,
		}},
	}
	return w
}

func station(id string, x, y float64) world.Station {
	return world.Station{ID: world.StationID(id), Name: id, X: x, Y: y}
}

// mustIndex runs the same derived-field setup Decode/Generate do.
func mustIndex(t *testing.T, w *world.World) *world.World {
	t.Helper()
	b, err := w.JSON()
	if err != nil {
		t.Fatalf("JSON: %v", err)
	}
	got, err := world.Decode(readerOf(b))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	return got
}

func newSim(t *testing.T, w *world.World, opts Options) *Sim {
	t.Helper()
	return New(mustIndex(t, w), opts)
}

func only(t *testing.T, s *Sim) TrainState {
	t.Helper()
	snap := s.Latest()
	if len(snap.Trains) != 1 {
		t.Fatalf("want 1 train, got %d", len(snap.Trains))
	}
	return snap.Trains[0]
}

// stepFor advances the sim by total using a fixed step.
func stepFor(s *Sim, total, step time.Duration) {
	for elapsed := time.Duration(0); elapsed < total; elapsed += step {
		s.Step(step)
	}
}

func fixedDwell(seed int64, d time.Duration) Options {
	return Options{MinDwell: d, MaxDwell: d, Seed: seed}
}

// --- straight-line travel ------------------------------------------------

func TestStraightSegmentTiming(t *testing.T) {
	// Three stations 100 units apart on a horizontal shuttle; no dwell so the
	// train just runs. At 10 u/s the first 100 units take exactly 10 s.
	w := straightWorld(world.KindShuttle,
		[]world.Station{station("S-0", 0, 0), station("S-1", 100, 0), station("S-2", 200, 0)},
		[]world.Point{{X: 0, Y: 0}, {X: 100, Y: 0}, {X: 200, Y: 0}},
		10)
	s := newSim(t, w, fixedDwell(1, 0))

	cases := []struct {
		after time.Duration
		wantX float64
	}{
		{1 * time.Second, 10},
		{5 * time.Second, 50},
		{10 * time.Second, 100},
		{15 * time.Second, 150},
	}
	elapsed := time.Duration(0)
	for _, tc := range cases {
		stepFor(s, tc.after-elapsed, 100*time.Millisecond)
		elapsed = tc.after
		got := only(t, s)
		if math.Abs(got.X-tc.wantX) > 1e-9 {
			t.Fatalf("after %s: x = %g, want %g", tc.after, got.X, tc.wantX)
		}
		if math.Abs(got.Y) > 1e-9 {
			t.Fatalf("after %s: y = %g, want 0", tc.after, got.Y)
		}
	}
}

// --- dwell ----------------------------------------------------------------

func TestDwellStopsTheTrain(t *testing.T) {
	const dwell = 3 * time.Second
	w := straightWorld(world.KindShuttle,
		[]world.Station{station("S-0", 0, 0), station("S-1", 100, 0), station("S-2", 300, 0)},
		[]world.Point{{X: 0, Y: 0}, {X: 100, Y: 0}, {X: 300, Y: 0}},
		10)
	s := newSim(t, w, fixedDwell(1, dwell))

	// 10 s to reach S-1 at x=100.
	stepFor(s, 10*time.Second, 50*time.Millisecond)
	got := only(t, s)
	if got.State != StateAtStation {
		t.Fatalf("state = %q, want %q", got.State, StateAtStation)
	}
	if got.Speed != 0 {
		t.Fatalf("speed = %g, want 0 while dwelling", got.Speed)
	}
	if math.Abs(got.X-100) > eps {
		t.Fatalf("x = %g, want 100", got.X)
	}

	// Still dwelling just before the dwell expires.
	stepFor(s, dwell-100*time.Millisecond, 50*time.Millisecond)
	if got := only(t, s); got.State != StateAtStation {
		t.Fatalf("left the station early: state = %q", got.State)
	}

	// Moving again shortly after.
	stepFor(s, 400*time.Millisecond, 50*time.Millisecond)
	got = only(t, s)
	if got.State != StateRunning {
		t.Fatalf("state = %q, want %q after the dwell", got.State, StateRunning)
	}
	if got.Speed <= 0 {
		t.Fatalf("speed = %g, want > 0 after the dwell", got.Speed)
	}
	if got.X <= 100 {
		t.Fatalf("x = %g, want > 100 after the dwell", got.X)
	}
}

func TestDwellIsDeterministicPerStop(t *testing.T) {
	w := straightWorld(world.KindShuttle,
		[]world.Station{station("S-0", 0, 0), station("S-1", 100, 0), station("S-2", 200, 0)},
		[]world.Point{{X: 0, Y: 0}, {X: 100, Y: 0}, {X: 200, Y: 0}},
		10)
	indexed := mustIndex(t, w)
	s := New(indexed, DefaultOptions(42))

	tr := &s.trains[0]
	for stop := 0; stop < 3; stop++ {
		d := s.dwellFor(tr, stop)
		if d < 2 || d > 5 {
			t.Fatalf("stop %d: dwell %gs outside the 2-5 s default range", stop, d)
		}
		if again := s.dwellFor(tr, stop); again != d {
			t.Fatalf("stop %d: dwell changed between calls (%g then %g)", stop, d, again)
		}
	}
	if s.dwellFor(tr, 0) == s.dwellFor(tr, 1) {
		t.Fatal("two stops drew exactly the same dwell; the hash is not mixing the stop index")
	}
}

// --- topology -------------------------------------------------------------

func TestShuttleReverses(t *testing.T) {
	w := straightWorld(world.KindShuttle,
		[]world.Station{station("S-0", 0, 0), station("S-1", 100, 0)},
		[]world.Point{{X: 0, Y: 0}, {X: 100, Y: 0}},
		10)
	s := newSim(t, w, fixedDwell(1, 0))

	// Out: heading east.
	stepFor(s, 5*time.Second, 50*time.Millisecond)
	if got := only(t, s); got.Compass != E {
		t.Fatalf("outbound compass = %q, want E", got.Compass)
	}
	// Past the far end: reversed, heading west and coming back.
	stepFor(s, 10*time.Second, 50*time.Millisecond)
	got := only(t, s)
	if got.Compass != W {
		t.Fatalf("return compass = %q, want W", got.Compass)
	}
	if got.X >= 100 || got.X <= 0 {
		t.Fatalf("x = %g, want the train back between the endpoints", got.X)
	}
	// And it never leaves the track.
	for i := 0; i < 2000; i++ {
		s.Step(50 * time.Millisecond)
		st := only(t, s)
		if st.X < -eps || st.X > 100+eps {
			t.Fatalf("shuttle ran off the track at x = %g", st.X)
		}
	}
}

func TestLoopWrapsAround(t *testing.T) {
	// A square loop, 400 units around.
	w := straightWorld(world.KindLoop,
		[]world.Station{station("S-0", 0, 0), station("S-1", 100, 0), station("S-2", 100, 100), station("S-3", 0, 100)},
		[]world.Point{{X: 0, Y: 0}, {X: 100, Y: 0}, {X: 100, Y: 100}, {X: 0, Y: 100}},
		10)
	s := newSim(t, w, fixedDwell(1, 0))

	// One full lap is 400 units = 40 s; the train should be back at the start.
	stepFor(s, 40*time.Second, 10*time.Millisecond)
	got := only(t, s)
	if math.Abs(got.X) > 1e-6 || math.Abs(got.Y) > 1e-6 {
		t.Fatalf("after one lap the train is at (%g, %g), want the origin", got.X, got.Y)
	}
	// Direction never flips on a loop.
	for i := 0; i < 500; i++ {
		s.Step(50 * time.Millisecond)
		if s.trains[0].dir != 1 {
			t.Fatal("a loop train reversed direction")
		}
	}
}

// --- heading and compass ---------------------------------------------------

func TestHeadingOf(t *testing.T) {
	// Y points down, 0 is north, angles increase clockwise.
	cases := []struct {
		name   string
		dx, dy float64
		want   float64
	}{
		{"north", 0, -1, 0},
		{"north-east", 1, -1, 45},
		{"east", 1, 0, 90},
		{"south-east", 1, 1, 135},
		{"south", 0, 1, 180},
		{"south-west", -1, 1, 225},
		{"west", -1, 0, 270},
		{"north-west", -1, -1, 315},
		{"still", 0, 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := HeadingOf(tc.dx, tc.dy); math.Abs(got-tc.want) > eps {
				t.Fatalf("HeadingOf(%g, %g) = %g, want %g", tc.dx, tc.dy, got, tc.want)
			}
		})
	}
}

func TestCompassOf(t *testing.T) {
	cases := []struct {
		heading float64
		want    Compass
	}{
		{0, N}, {10, N}, {350, N}, {360, N},
		{45, NE}, {60, NE},
		{90, E}, {100, E},
		{135, SE},
		{180, S},
		{225, SW},
		{270, W},
		{315, NW},
		{337.5 + 1, N},
		{-45, NW},
	}
	for _, tc := range cases {
		if got := CompassOf(tc.heading); got != tc.want {
			t.Fatalf("CompassOf(%g) = %q, want %q", tc.heading, got, tc.want)
		}
	}
}

// TestCompassAllEightDirections drives a real train through eight legs, one per
// compass point, and checks the heading the simulation reports on each.
func TestCompassAllEightDirections(t *testing.T) {
	// A star-shaped shuttle whose legs point in all eight directions.
	const r = 100.0
	legs := []struct {
		dx, dy  float64
		compass Compass
		heading float64
	}{
		{0, -r, N, 0},
		{r, -r, NE, 45},
		{r, 0, E, 90},
		{r, r, SE, 135},
		{0, r, S, 180},
		{-r, r, SW, 225},
		{-r, 0, W, 270},
		{-r, -r, NW, 315},
	}

	for _, leg := range legs {
		t.Run(string(leg.compass), func(t *testing.T) {
			start := world.Point{X: 500, Y: 500}
			end := world.Point{X: start.X + leg.dx, Y: start.Y + leg.dy}
			w := straightWorld(world.KindShuttle,
				[]world.Station{
					station("S-0", start.X, start.Y),
					station("S-1", end.X, end.Y),
				},
				[]world.Point{start, end},
				10)
			s := newSim(t, w, fixedDwell(1, 0))
			s.Step(time.Second)

			got := only(t, s)
			if math.Abs(got.Heading-leg.heading) > eps {
				t.Fatalf("heading = %g, want %g", got.Heading, leg.heading)
			}
			if got.Compass != leg.compass {
				t.Fatalf("compass = %q, want %q", got.Compass, leg.compass)
			}
		})
	}
}

// --- waypoints -------------------------------------------------------------

func TestWaypointsTurnWithoutDwelling(t *testing.T) {
	// S-0 -> waypoint -> S-1: the waypoint is a right-angle turn, so heading
	// changes there, but the train must not stop.
	w := straightWorld(world.KindShuttle,
		[]world.Station{station("S-0", 0, 0), station("S-1", 100, 100)},
		[]world.Point{{X: 0, Y: 0}, {X: 100, Y: 0}, {X: 100, Y: 100}},
		10)
	s := newSim(t, w, fixedDwell(1, 4*time.Second))

	sawEast, sawSouth := false, false
	for i := 0; i < 300; i++ { // 15 s: 150 units, past the waypoint, short of S-1
		s.Step(50 * time.Millisecond)
		got := only(t, s)
		if got.State != StateRunning {
			t.Fatalf("step %d: state = %q at (%g, %g); the waypoint must not cause a dwell",
				i, got.State, got.X, got.Y)
		}
		if got.Speed <= 0 {
			t.Fatalf("step %d: speed = %g; the train stopped at the waypoint", i, got.Speed)
		}
		switch got.Compass {
		case E:
			sawEast = true
		case S:
			sawSouth = true
		}
	}
	if !sawEast || !sawSouth {
		t.Fatalf("heading did not change at the waypoint (east=%v south=%v)", sawEast, sawSouth)
	}

	// It does dwell once it reaches the real station at the far end (200 units).
	stepFor(s, 6*time.Second, 50*time.Millisecond)
	if got := only(t, s); got.State != StateAtStation {
		t.Fatalf("state at S-1 = %q, want %q", got.State, StateAtStation)
	}
}

// --- determinism -----------------------------------------------------------

func TestDeterminism(t *testing.T) {
	build := func() *Sim {
		w, err := world.Generate(world.GenParams{
			Seed: 42, Bounds: world.Bounds{W: 1000, H: 1000},
			Stations: 30, Lines: 6, Trains: 40,
		})
		if err != nil {
			t.Fatalf("Generate: %v", err)
		}
		return New(w, DefaultOptions(42))
	}

	a, b := build(), build()
	for i := 0; i < 400; i++ {
		a.Step(50 * time.Millisecond)
		b.Step(50 * time.Millisecond)
	}

	sa, sb := a.Latest(), b.Latest()
	if len(sa.Trains) != len(sb.Trains) {
		t.Fatalf("train counts differ: %d vs %d", len(sa.Trains), len(sb.Trains))
	}
	for i := range sa.Trains {
		x, y := sa.Trains[i], sb.Trains[i]
		if x.ID != y.ID || x.X != y.X || x.Y != y.Y || x.Heading != y.Heading ||
			x.Speed != y.Speed || x.State != y.State {
			t.Fatalf("train %s diverged:\n a = %+v\n b = %+v", x.ID, x, y)
		}
	}
}

func TestDifferentSeedsDiverge(t *testing.T) {
	build := func(seed int64) *Sim {
		w, err := world.Generate(world.GenParams{
			Seed: seed, Bounds: world.Bounds{W: 1000, H: 1000},
			Stations: 30, Lines: 6, Trains: 20,
		})
		if err != nil {
			t.Fatalf("Generate: %v", err)
		}
		return New(w, DefaultOptions(seed))
	}
	a, b := build(42), build(43)
	for i := 0; i < 100; i++ {
		a.Step(50 * time.Millisecond)
		b.Step(50 * time.Millisecond)
	}
	if a.Latest().Trains[0] == b.Latest().Trains[0] {
		t.Fatal("different seeds produced an identical leading train")
	}
}

// --- acceleration ----------------------------------------------------------

func TestAccelRampsDownIntoStations(t *testing.T) {
	w := straightWorld(world.KindShuttle,
		[]world.Station{station("S-0", 0, 0), station("S-1", 400, 0)},
		[]world.Point{{X: 0, Y: 0}, {X: 400, Y: 0}},
		20)
	opts := fixedDwell(1, 2*time.Second)
	opts.Accel = true
	opts.AccelRate = 4
	s := newSim(t, w, opts)

	var departSpeed, midSpeed, arriveSpeed float64
	for i := 0; i < 400; i++ {
		s.Step(50 * time.Millisecond)
		got := only(t, s)
		switch {
		case got.X < 10:
			departSpeed = got.Speed
		case math.Abs(got.X-200) < 10:
			midSpeed = got.Speed
		case got.X > 390 && got.State == StateRunning:
			arriveSpeed = got.Speed
		}
		if got.State == StateAtStation && got.X > 390 {
			break
		}
	}
	if !(departSpeed < midSpeed) {
		t.Fatalf("speed did not ramp up leaving the station: depart=%g mid=%g", departSpeed, midSpeed)
	}
	if !(arriveSpeed < midSpeed) {
		t.Fatalf("speed did not ramp down approaching the station: mid=%g arrive=%g", midSpeed, arriveSpeed)
	}
	if midSpeed > 20+eps {
		t.Fatalf("speed %g exceeded maxSpeed", midSpeed)
	}
}

func TestNoAccelHoldsConstantSpeed(t *testing.T) {
	w := straightWorld(world.KindShuttle,
		[]world.Station{station("S-0", 0, 0), station("S-1", 400, 0)},
		[]world.Point{{X: 0, Y: 0}, {X: 400, Y: 0}},
		20)
	s := newSim(t, w, fixedDwell(1, 2*time.Second))
	for i := 0; i < 300; i++ {
		s.Step(50 * time.Millisecond)
		got := only(t, s)
		if got.State == StateRunning && math.Abs(got.Speed-20) > eps {
			t.Fatalf("speed = %g while running, want a constant 20", got.Speed)
		}
	}
}

// --- runner ---------------------------------------------------------------

func TestRunPublishesSnapshots(t *testing.T) {
	w, err := world.Generate(world.GenParams{
		Seed: 9, Bounds: world.Bounds{W: 1000, H: 1000},
		Stations: 30, Lines: 6, Trains: 10,
	})
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	s := New(w, DefaultOptions(9))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		s.Run(ctx, 5*time.Millisecond)
		close(done)
	}()

	first := s.Latest()
	deadline := time.After(2 * time.Second)
	for {
		if s.Latest().Tick > first.Tick+5 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("the runner did not publish new snapshots")
		case <-time.After(5 * time.Millisecond):
		}
	}

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}
}
