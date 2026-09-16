// Package sim advances trains along their lines at a fixed step and publishes
// immutable snapshots for the streaming layer to read. See spec §1 and §3.
package sim

import (
	"math"
	"sync/atomic"
	"time"

	"github.com/carlosdanna/rail-tracker/server/internal/world"
)

// State is a train's observable state, matching the stream fields in spec §2.
type State string

const (
	// StateRunning means the train is moving between stations.
	StateRunning State = "running"
	// StateAtStation means the train is dwelling; its speed is 0.
	StateAtStation State = "at_station"
)

// Compass is the 8-way direction enum derived from a heading.
type Compass string

// The eight compass points, in heading order starting at north.
const (
	N  Compass = "N"
	NE Compass = "NE"
	E  Compass = "E"
	SE Compass = "SE"
	S  Compass = "S"
	SW Compass = "SW"
	W  Compass = "W"
	NW Compass = "NW"
)

var compassPoints = [8]Compass{N, NE, E, SE, S, SW, W, NW}

// TrainState is one train's position at a point in simulated time. It is
// copied into snapshots and never mutated afterwards.
type TrainState struct {
	ID      string
	Index   int // the n in "T-n", used by the binary encoder
	LineID  string
	X       float64
	Y       float64
	Heading float64 // degrees, 0 = north, increasing clockwise
	Compass Compass
	Speed   float64
	State   State
}

// Snapshot is an immutable view of every train at one simulated instant.
type Snapshot struct {
	// Tick counts simulation steps since start.
	Tick int64
	// SimTime is the simulated time elapsed since start.
	SimTime time.Duration
	// Wall is the wall-clock time the snapshot was published.
	Wall time.Time
	// Trains is sorted by train index and must not be modified.
	Trains []TrainState
}

// Options tunes the simulation.
type Options struct {
	// Accel enables the ramp-down/ramp-up model near stations.
	Accel bool
	// AccelRate is the acceleration magnitude in units/s². Zero picks a
	// default derived from the train speeds.
	AccelRate float64
	// MinDwell and MaxDwell bound the per-stop dwell time drawn from the seed.
	// Both zero means trains never dwell, which is what the unit tests use.
	MinDwell time.Duration
	MaxDwell time.Duration
	// Seed drives the per-stop dwell times. It is normally the world seed.
	Seed int64
}

// DefaultOptions returns the spec defaults: no acceleration, 2-5 s dwells.
func DefaultOptions(seed int64) Options {
	return Options{
		Accel:     false,
		AccelRate: 0,
		MinDwell:  2 * time.Second,
		MaxDwell:  5 * time.Second,
		Seed:      seed,
	}
}

// train is the simulation's mutable per-train record.
type train struct {
	id     string
	index  int
	line   *world.Line
	lineNo int

	maxSpeed float64
	speed    float64

	seg      int     // current track segment
	progress float64 // distance into seg, always measured from Segment(seg).from
	dir      int     // +1 along the track, -1 against it

	dwell float64 // seconds of dwell left

	x, y    float64
	heading float64
}

// Sim owns the world and advances it. Step is not safe for concurrent use;
// Latest is.
type Sim struct {
	w    *world.World
	opts Options

	trains []train
	tick   int64
	simT   time.Duration

	snap atomic.Pointer[Snapshot]

	// tickDur is the fixed step size, recorded for /metrics.
	tickDur atomic.Int64
}

// New builds a simulation over w. The world is not modified.
func New(w *world.World, opts Options) *Sim {
	if opts.MinDwell < 0 {
		opts.MinDwell = 0
	}
	if opts.MaxDwell < opts.MinDwell {
		opts.MaxDwell = opts.MinDwell
	}

	s := &Sim{w: w, opts: opts}
	s.trains = make([]train, len(w.Trains))
	for i := range w.Trains {
		wt := &w.Trains[i]
		line, _ := w.Line(wt.LineID)
		t := &s.trains[i]
		t.id = wt.ID
		t.index = i
		t.line = line
		t.lineNo = lineOrdinal(w, wt.LineID)
		t.maxSpeed = wt.MaxSpeed
		t.speed = wt.MaxSpeed
		t.seg = wt.SegmentIndex
		t.progress = wt.Progress
		t.dir = wt.Direction
		t.dwell = wt.DwellRemaining
		if t.dwell > 0 {
			t.speed = 0
		}
		t.place()
	}
	s.publish(time.Time{})
	return s
}

func lineOrdinal(w *world.World, id string) int {
	for i := range w.Lines {
		if w.Lines[i].ID == id {
			return i
		}
	}
	return -1
}

// World returns the world the simulation runs on.
func (s *Sim) World() *world.World { return s.w }

// Latest returns the most recently published snapshot. It never returns nil
// once New has run, and the returned value must be treated as read-only.
func (s *Sim) Latest() *Snapshot { return s.snap.Load() }

// TickDuration reports the last step size passed to Step, for /metrics.
func (s *Sim) TickDuration() time.Duration { return time.Duration(s.tickDur.Load()) }

// Step advances every train by dt and publishes a new snapshot.
func (s *Sim) Step(dt time.Duration) {
	if dt <= 0 {
		return
	}
	s.tickDur.Store(int64(dt))
	secs := dt.Seconds()
	for i := range s.trains {
		s.advance(&s.trains[i], secs)
	}
	s.tick++
	s.simT += dt
	s.publish(time.Now())
}

// publish snapshots the current train states behind an atomic pointer.
func (s *Sim) publish(wall time.Time) {
	states := make([]TrainState, len(s.trains))
	for i := range s.trains {
		t := &s.trains[i]
		st := StateRunning
		if t.dwell > 0 {
			st = StateAtStation
		}
		states[i] = TrainState{
			ID:      t.id,
			Index:   t.index,
			LineID:  t.line.ID,
			X:       t.x,
			Y:       t.y,
			Heading: t.heading,
			Compass: CompassOf(t.heading),
			Speed:   t.speed,
			State:   st,
		}
	}
	if wall.IsZero() {
		wall = time.Now()
	}
	s.snap.Store(&Snapshot{Tick: s.tick, SimTime: s.simT, Wall: wall, Trains: states})
}

// advance moves one train forward by secs seconds of simulated time.
func (s *Sim) advance(t *train, secs float64) {
	// Dwelling: burn the clock first, then spend any leftover time moving.
	if t.dwell > 0 {
		if t.dwell > secs {
			t.dwell -= secs
			t.speed = 0
			t.place()
			return
		}
		secs -= t.dwell
		t.dwell = 0
	}

	remaining := secs
	// Guard against pathological dt values producing an unbounded loop.
	for iter := 0; remaining > 1e-12 && iter < 1000; iter++ {
		t.speed = s.speedFor(t)
		if t.speed <= 0 {
			// Only possible with acceleration enabled and a zero-length ramp;
			// nudge forward at a crawl rather than stalling.
			t.speed = t.maxSpeed * 0.01
		}
		step := t.speed * remaining

		segLen := t.line.SegmentLen(t.seg)
		var toEnd float64
		if t.dir > 0 {
			toEnd = segLen - t.progress
		} else {
			toEnd = t.progress
		}

		if step < toEnd {
			t.progress += float64(t.dir) * step
			remaining = 0
			break
		}

		// Reached the end of this segment: consume the time it took and cross.
		used := toEnd / t.speed
		remaining -= used
		if s.crossBoundary(t) {
			// Arrived at a station and started dwelling. Any time left over is
			// spent standing still.
			if t.dwell > remaining {
				t.dwell -= remaining
				remaining = 0
			} else {
				remaining -= t.dwell
				t.dwell = 0
			}
		}
	}

	if t.dwell > 0 {
		t.speed = 0
	}
	t.place()
}

// crossBoundary moves the train onto the next segment, reversing a shuttle at
// the end of its track. It reports whether the train arrived at a station and
// began dwelling.
func (s *Sim) crossBoundary(t *train) bool {
	nSeg := t.line.NumSegments()

	// The track vertex the train has just reached.
	var vertex int
	if t.dir > 0 {
		vertex = (t.seg + 1) % len(t.line.Track)
	} else {
		vertex = t.seg
	}

	reversed := false
	if t.line.Kind == world.KindShuttle {
		if t.dir > 0 && t.seg == nSeg-1 {
			t.dir = -1
			t.seg = nSeg - 1
			t.progress = t.line.SegmentLen(t.seg)
			reversed = true
		} else if t.dir < 0 && t.seg == 0 {
			t.dir = 1
			t.seg = 0
			t.progress = 0
			reversed = true
		}
	}
	if !reversed {
		if t.dir > 0 {
			t.seg = (t.seg + 1) % nSeg
			t.progress = 0
		} else {
			t.seg--
			if t.seg < 0 {
				t.seg = nSeg - 1
			}
			t.progress = t.line.SegmentLen(t.seg)
		}
	}

	// Waypoints change heading but never trigger a dwell.
	if stop := t.line.StopAtTrackIndex(vertex); stop >= 0 {
		t.dwell = s.dwellFor(t, stop)
		t.speed = 0
		return t.dwell > 0
	}
	return false
}

// place recomputes the cached position and heading from the segment state.
func (t *train) place() {
	from, to := t.line.Segment(t.seg)
	segLen := t.line.SegmentLen(t.seg)
	f := 0.0
	if segLen > 0 {
		f = t.progress / segLen
	}
	t.x = from.X + (to.X-from.X)*f
	t.y = from.Y + (to.Y-from.Y)*f

	dx, dy := to.X-from.X, to.Y-from.Y
	if t.dir < 0 {
		dx, dy = -dx, -dy
	}
	t.heading = HeadingOf(dx, dy)
}

// speedFor returns the speed to use for the next slice of movement.
func (s *Sim) speedFor(t *train) float64 {
	if !s.opts.Accel {
		return t.maxSpeed
	}
	a := s.opts.AccelRate
	if a <= 0 {
		// Reach full speed over roughly a third of a typical segment.
		a = t.maxSpeed * t.maxSpeed / (2 * 60)
	}
	// Distance the train needs to stop from full speed, and how far it is from
	// the next station and from the last one.
	brake := t.maxSpeed * t.maxSpeed / (2 * a)
	ahead := s.distToStation(t, +1)
	behind := s.distToStation(t, -1)

	v := t.maxSpeed
	if ahead < brake {
		v = math.Min(v, math.Sqrt(math.Max(0, 2*a*ahead)))
	}
	if behind < brake {
		v = math.Min(v, math.Sqrt(math.Max(0, 2*a*behind)))
	}
	// Never crawl so slowly that the train cannot make progress.
	return math.Max(v, t.maxSpeed*0.02)
}

// distToStation walks the track in the train's direction of travel (dirSign
// +1) or against it (-1) and returns the distance to the nearest station.
func (s *Sim) distToStation(t *train, dirSign int) float64 {
	step := t.dir * dirSign
	nSeg := t.line.NumSegments()
	seg := t.seg

	var d float64
	if step > 0 {
		d = t.line.SegmentLen(seg) - t.progress
	} else {
		d = t.progress
	}

	for i := 0; i <= nSeg; i++ {
		var vertex int
		if step > 0 {
			vertex = (seg + 1) % len(t.line.Track)
		} else {
			vertex = seg
		}
		if t.line.StopAtTrackIndex(vertex) >= 0 {
			return d
		}
		if step > 0 {
			seg = (seg + 1) % nSeg
		} else {
			seg--
			if seg < 0 {
				seg = nSeg - 1
			}
		}
		d += t.line.SegmentLen(seg)
	}
	return d
}

// HeadingOf converts a direction vector into a heading in degrees, where 0 is
// north (−Y) and angles increase clockwise. Y points down.
func HeadingOf(dx, dy float64) float64 {
	if dx == 0 && dy == 0 {
		return 0
	}
	// Screen-space clockwise-from-north: east is +X, north is −Y.
	deg := math.Atan2(dx, -dy) * 180 / math.Pi
	if deg < 0 {
		deg += 360
	}
	if deg >= 360 {
		deg -= 360
	}
	return deg
}

// CompassOf maps a heading to the nearest of the eight compass points.
func CompassOf(heading float64) Compass {
	h := math.Mod(heading, 360)
	if h < 0 {
		h += 360
	}
	i := int(math.Floor(h/45+0.5)) % 8
	return compassPoints[i]
}
