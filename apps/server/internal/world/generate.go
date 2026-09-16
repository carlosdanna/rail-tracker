package world

import (
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
)

// Generation limits from spec §1.
const (
	// MinStops is the fewest stations a generated line serves. MaxStops is the
	// default ceiling; GenParams.MaxStops overrides it, which is how a world
	// gets many stations without needing proportionally many lines.
	MinStops = 3
	MaxStops = 8
	// MaxWaypoints is the most intermediate curve points placed between two
	// consecutive stops.
	MaxWaypoints = 3

	// defaultMaxSpeed is the top train speed on a world of referenceSpan across.
	// Bigger worlds scale it up: the point of a larger map is more room, not
	// longer journeys, and a line that took an hour to run would never be
	// reconstructed by a client.
	defaultMaxSpeed = 50.0
	referenceSpan   = 1000.0
	// slowestFraction sets the bottom of the per-train speed range.
	slowestFraction = 0.6

	// RelaxFloor is the fraction of MinStationDistance below which the
	// generator gives up rather than packing stations closer together.
	RelaxFloor = 0.5
)

// linePalette is cycled to colour generated lines.
var linePalette = []string{
	"#e6194b", "#3cb44b", "#4363d8", "#f58231",
	"#911eb4", "#46f0f0", "#f032e6", "#bcf60c",
}

var (
	namePrefixes = []string{
		"Ash", "Birch", "Cedar", "Dover", "Elm", "Fenn", "Granite", "Harrow",
		"Ivory", "Juniper", "Kestrel", "Laurel", "Marsh", "Norfolk", "Orchard",
		"Pine", "Quarry", "Ridge", "Stone", "Thorn", "Union", "Vale", "Willow", "Yarrow",
	}
	nameSuffixes = []string{
		"Gate", "Cross", "Park", "Bridge", "Field", "Hill", "End", "Yard",
		"Wharf", "Green", "Halt", "Junction",
	}
)

// GenParams configures deterministic world generation.
type GenParams struct {
	Seed     int64
	Bounds   Bounds
	Stations int
	Lines    int
	Trains   int
	// MaxStops caps the stations on one line. Zero means MaxStops.
	MaxStops int
	// MaxSpeed is the fastest a train may run, in units/sec. Zero scales
	// DefaultMaxSpeed to the world size.
	MaxSpeed float64
}

// maxStops returns the effective per-line stop ceiling.
func (p GenParams) maxStops() int {
	if p.MaxStops <= 0 {
		return MaxStops
	}
	return p.MaxStops
}

// DefaultMaxSpeed returns the top train speed for a world of the given size:
// defaultMaxSpeed on a reference 1000x1000 world, scaled by the shorter side so
// that a lap takes about as long however big the map is.
func DefaultMaxSpeed(b Bounds) float64 {
	span := math.Min(b.W, b.H)
	if span <= 0 {
		return defaultMaxSpeed
	}
	return defaultMaxSpeed * span / referenceSpan
}

// maxSpeed returns the effective top train speed.
func (p GenParams) maxSpeed() float64 {
	if p.MaxSpeed <= 0 {
		return DefaultMaxSpeed(p.Bounds)
	}
	return p.MaxSpeed
}

// MinStationDistance is the minimum spacing the generator enforces between two
// stations, scaled so that n stations fit comfortably in the bounds.
func MinStationDistance(b Bounds, n int) float64 {
	if n < 2 {
		return 0
	}
	return 0.55 * math.Sqrt(b.W*b.H/float64(n))
}

// Generate builds a world deterministically from p. The same params always
// produce the same world, down to the JSON bytes.
func Generate(p GenParams) (*World, error) {
	if p.Bounds.W <= 0 || p.Bounds.H <= 0 {
		return nil, fmt.Errorf("bounds must be positive, got %gx%g", p.Bounds.W, p.Bounds.H)
	}
	if p.Stations < MinStops {
		return nil, fmt.Errorf("need at least %d stations, got %d", MinStops, p.Stations)
	}
	if p.Lines < 1 {
		return nil, fmt.Errorf("need at least 1 line, got %d", p.Lines)
	}
	if p.Trains < 1 {
		return nil, fmt.Errorf("need at least 1 train, got %d", p.Trains)
	}
	if p.Stations > p.Lines*p.maxStops() {
		return nil, fmt.Errorf("cannot serve %d stations with %d lines of at most %d stops each",
			p.Stations, p.Lines, p.maxStops())
	}

	// A fixed second stream value keeps the sequence tied to the seed alone.
	rng := rand.New(rand.NewPCG(uint64(p.Seed), 0x9e3779b97f4a7c15))

	w := &World{Seed: p.Seed, Bounds: p.Bounds}
	stations, err := genStations(rng, p)
	if err != nil {
		return nil, err
	}
	w.Stations = stations
	w.Lines = genLines(rng, p, w.Stations)
	trains, err := genTrains(rng, p, w.Lines)
	if err != nil {
		return nil, err
	}
	w.Trains = trains

	if err := w.index(); err != nil {
		return nil, fmt.Errorf("generated world is inconsistent: %w", err)
	}
	if err := w.Validate(); err != nil {
		return nil, fmt.Errorf("generated world is invalid: %w", err)
	}
	if err := validateGenerated(w, p.maxStops()); err != nil {
		return nil, fmt.Errorf("generated world is invalid: %w", err)
	}
	return w, nil
}

// validateGenerated enforces the shape constraints that apply to generated
// worlds only: 3-8 stops per line and at most MaxWaypoints between stops.
func validateGenerated(w *World, maxStops int) error {
	var errs error
	for i := range w.Lines {
		l := &w.Lines[i]
		if n := len(l.Stops); n < MinStops || n > maxStops {
			errs = errors.Join(errs, fmt.Errorf("line %q has %d stops, want %d-%d",
				l.ID, n, MinStops, maxStops))
		}
		for j := 0; j+1 < len(l.stopAt); j++ {
			if gap := l.stopAt[j+1] - l.stopAt[j] - 1; gap < 0 || gap > MaxWaypoints {
				errs = errors.Join(errs, fmt.Errorf("line %q has %d waypoints between stops %d and %d, want 0-%d",
					l.ID, gap, j, j+1, MaxWaypoints))
			}
		}
		if l.Kind == KindLoop {
			// The closing gap runs from the last stop to the end of the track
			// and then back to Track[0].
			if gap := len(l.Track) - 1 - l.stopAt[len(l.stopAt)-1]; gap < 0 || gap > MaxWaypoints {
				errs = errors.Join(errs, fmt.Errorf("line %q has %d waypoints on the closing gap, want 0-%d",
					l.ID, gap, MaxWaypoints))
			}
		}
	}
	return errs
}

// genStations places stations by rejection sampling, keeping them at least
// MinStationDistance apart. If that spacing proves unreachable it relaxes in
// fixed 10% steps, deterministically, and gives up below RelaxFloor of target.
func genStations(rng *rand.Rand, p GenParams) ([]Station, error) {
	margin := 0.04 * math.Min(p.Bounds.W, p.Bounds.H)
	target := MinStationDistance(p.Bounds, p.Stations)
	minDist := target

	pts := make([]Point, 0, p.Stations)
	for len(pts) < p.Stations {
		if minDist < target*RelaxFloor {
			return nil, fmt.Errorf("cannot place %d stations in %gx%g at least %g apart",
				p.Stations, p.Bounds.W, p.Bounds.H, target*RelaxFloor)
		}
		placed := false
		for attempt := 0; attempt < 512; attempt++ {
			c := Point{
				X: margin + rng.Float64()*(p.Bounds.W-2*margin),
				Y: margin + rng.Float64()*(p.Bounds.H-2*margin),
			}
			ok := true
			for _, q := range pts {
				if c.Dist(q) < minDist {
					ok = false
					break
				}
			}
			if ok {
				pts = append(pts, c)
				placed = true
				break
			}
		}
		if !placed {
			minDist *= 0.9
		}
	}

	used := make(map[string]int, p.Stations)
	out := make([]Station, p.Stations)
	for i, c := range pts {
		base := namePrefixes[rng.IntN(len(namePrefixes))] + " " + nameSuffixes[rng.IntN(len(nameSuffixes))]
		name := base
		if n := used[base]; n > 0 {
			name = fmt.Sprintf("%s %d", base, n+1)
		}
		used[base]++
		out[i] = Station{
			ID:   StationID(fmt.Sprintf("S-%d", i)),
			Name: name,
			X:    c.X,
			Y:    c.Y,
		}
	}
	return out, nil
}

// chunkSizes splits n stations into l contiguous groups, each within
// [MinStops, maxStops]. The caller has already checked n <= l*maxStops, so only
// the lower bound may need padding, which is reported as a shortfall.
func chunkSizes(n, l, maxStops int) []int {
	sizes := make([]int, l)
	per, rem := n/l, n%l
	for i := range sizes {
		sizes[i] = per
		if i < rem {
			sizes[i]++
		}
		if sizes[i] > maxStops {
			sizes[i] = maxStops
		}
	}
	return sizes
}

// genLines assigns every station to at least one line, orders each line's stops
// into a short tour, and lays a curved track through them.
func genLines(rng *rand.Rand, p GenParams, stations []Station) []Line {
	order := rng.Perm(len(stations))
	maxStops := p.maxStops()
	sizes := chunkSizes(len(stations), p.Lines, maxStops)

	lines := make([]Line, p.Lines)
	pos := 0
	for i := range lines {
		// Take this line's slice of the permutation, then top up to MinStops
		// with stations from elsewhere if the slice is too small.
		idx := make([]int, 0, maxStops)
		for j := 0; j < sizes[i] && pos < len(order); j++ {
			idx = append(idx, order[pos])
			pos++
		}
		for len(idx) < MinStops {
			cand := rng.IntN(len(stations))
			if !containsInt(idx, cand) {
				idx = append(idx, cand)
			}
		}

		idx = nearestNeighbourTour(stations, idx)

		kind := KindLoop
		// Roughly one line in three is a shuttle.
		if rng.IntN(3) == 0 {
			kind = KindShuttle
		}

		stops := make([]StationID, len(idx))
		pts := make([]Point, len(idx))
		for j, si := range idx {
			stops[j] = stations[si].ID
			pts[j] = stations[si].Pos()
		}

		lines[i] = Line{
			ID:    fmt.Sprintf("L-%d", i),
			Name:  fmt.Sprintf("Line %d", i+1),
			Color: linePalette[i%len(linePalette)],
			Kind:  kind,
			Stops: stops,
			Track: genTrack(rng, p.Bounds, pts, kind),
		}
	}
	return lines
}

// genTrack lays the polyline through pts, inserting 0-3 curve waypoints in each
// gap. For a loop the gap from the last stop back to the first is included, so
// the track closes without repeating the first point.
func genTrack(rng *rand.Rand, b Bounds, pts []Point, kind Kind) []Point {
	gaps := len(pts) - 1
	if kind == KindLoop {
		gaps = len(pts)
	}
	track := make([]Point, 0, len(pts)+gaps*MaxWaypoints)
	margin := 0.02 * math.Min(b.W, b.H)

	for g := 0; g < gaps; g++ {
		from := pts[g]
		to := pts[(g+1)%len(pts)]
		track = append(track, from)

		n := rng.IntN(MaxWaypoints + 1)
		if n == 0 {
			continue
		}
		// Bow the gap out to one side so the waypoints read as a curve rather
		// than noise on a straight line.
		d := to.Sub(from)
		length := math.Hypot(d.X, d.Y)
		if length == 0 {
			continue
		}
		perp := Point{X: -d.Y / length, Y: d.X / length}
		amp := length * (0.08 + 0.12*rng.Float64())
		if rng.IntN(2) == 0 {
			amp = -amp
		}
		for i := 1; i <= n; i++ {
			t := float64(i) / float64(n+1)
			bulge := amp * math.Sin(math.Pi*t)
			track = append(track, Point{
				X: clamp(from.X+d.X*t+perp.X*bulge, margin, b.W-margin),
				Y: clamp(from.Y+d.Y*t+perp.Y*bulge, margin, b.H-margin),
			})
		}
	}
	if kind == KindShuttle {
		track = append(track, pts[len(pts)-1])
	}
	return track
}

// genTrains spreads trains round-robin over the lines and staggers each line's
// trains evenly along its track.
func genTrains(rng *rand.Rand, p GenParams, lines []Line) ([]Train, error) {
	// Derived fields are needed to turn an arc offset into segment+progress.
	for i := range lines {
		if err := lines[i].measure(); err != nil {
			return nil, err
		}
	}

	perLine := make([]int, len(lines))
	assign := make([]int, p.Trains)
	for i := 0; i < p.Trains; i++ {
		l := i % len(lines)
		assign[i] = l
		perLine[l]++
	}

	top := p.maxSpeed()
	slowest := top * slowestFraction

	seen := make([]int, len(lines))
	trains := make([]Train, p.Trains)
	for i := 0; i < p.Trains; i++ {
		l := assign[i]
		line := &lines[l]
		offset := float64(seen[l]) / float64(perLine[l]) * line.TotalLen()
		seen[l]++

		seg, into := line.ArcToSegment(offset)
		trains[i] = Train{
			ID:             fmt.Sprintf("T-%d", i),
			LineID:         line.ID,
			MaxSpeed:       slowest + rng.Float64()*(top-slowest),
			SegmentIndex:   seg,
			Progress:       into,
			Direction:      1,
			DwellRemaining: 0,
		}
	}
	return trains, nil
}

// measure fills in only the length-derived fields, for use before the world is
// fully assembled.
func (l *Line) measure() error {
	n := l.NumSegments()
	l.segLen = make([]float64, n)
	l.cumLen = make([]float64, len(l.Track))
	l.total = 0
	for i := 0; i < n; i++ {
		from, to := l.Segment(i)
		l.segLen[i] = from.Dist(to)
		if l.segLen[i] <= 0 {
			return fmt.Errorf("line %s: segment %d has zero length", l.ID, i)
		}
		if i+1 < len(l.cumLen) {
			l.cumLen[i+1] = l.cumLen[i] + l.segLen[i]
		}
		l.total += l.segLen[i]
	}
	return nil
}

// nearestNeighbourTour orders the station indices into a short tour, starting
// from the first one given.
func nearestNeighbourTour(stations []Station, idx []int) []int {
	if len(idx) < 3 {
		return idx
	}
	remaining := append([]int(nil), idx[1:]...)
	tour := []int{idx[0]}
	cur := stations[idx[0]].Pos()
	for len(remaining) > 0 {
		best, bestD := 0, math.Inf(1)
		for i, si := range remaining {
			if d := cur.Dist(stations[si].Pos()); d < bestD {
				best, bestD = i, d
			}
		}
		pick := remaining[best]
		tour = append(tour, pick)
		cur = stations[pick].Pos()
		remaining = append(remaining[:best], remaining[best+1:]...)
	}
	return tour
}

func containsInt(xs []int, v int) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
