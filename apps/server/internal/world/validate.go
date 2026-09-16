package world

import (
	"errors"
	"fmt"
)

// Validate checks the structural invariants a simulated world must satisfy.
// It runs on generated worlds and on anything loaded from world.json.
//
// It deliberately does not enforce the generator's shape constraints (3-8 stops
// per line, at most 3 waypoints per gap) — a hand-written world.json is free to
// ignore those. validateGenerated covers them for generated worlds.
func (w *World) Validate() error {
	var errs error
	add := func(format string, args ...any) {
		errs = errors.Join(errs, fmt.Errorf(format, args...))
	}

	if w.Bounds.W <= 0 || w.Bounds.H <= 0 {
		add("bounds must be positive, got %gx%g", w.Bounds.W, w.Bounds.H)
	}
	if len(w.Stations) == 0 {
		add("world has no stations")
	}
	if len(w.Lines) == 0 {
		add("world has no lines")
	}
	if len(w.Trains) == 0 {
		add("world has no trains")
	}

	seenStation := make(map[StationID]bool, len(w.Stations))
	for _, s := range w.Stations {
		if s.ID == "" {
			add("station with empty id")
			continue
		}
		if seenStation[s.ID] {
			add("duplicate station id %q", s.ID)
		}
		seenStation[s.ID] = true
		if s.X < 0 || s.X > w.Bounds.W || s.Y < 0 || s.Y > w.Bounds.H {
			add("station %q at (%g, %g) is outside bounds", s.ID, s.X, s.Y)
		}
	}

	served := make(map[StationID]bool, len(w.Stations))
	seenLine := make(map[string]bool, len(w.Lines))
	for i := range w.Lines {
		l := &w.Lines[i]
		if l.ID == "" {
			add("line with empty id")
		}
		if seenLine[l.ID] {
			add("duplicate line id %q", l.ID)
		}
		seenLine[l.ID] = true

		if !l.Kind.Valid() {
			add("line %q has invalid kind %q", l.ID, l.Kind)
		}
		if n := len(l.Stops); n < 2 {
			add("line %q has %d stops, want at least 2", l.ID, n)
		}
		for _, sid := range l.Stops {
			if !seenStation[sid] {
				add("line %q references unknown station %q", l.ID, sid)
				continue
			}
			served[sid] = true
		}
		if len(l.stopAt) == len(l.Stops) && l.Kind == KindShuttle {
			if last := l.stopAt[len(l.stopAt)-1]; last != len(l.Track)-1 {
				add("line %q is a shuttle whose track continues past its last stop", l.ID)
			}
		}
	}
	for _, s := range w.Stations {
		if !served[s.ID] {
			add("station %q is not served by any line", s.ID)
		}
	}

	seenTrain := make(map[string]bool, len(w.Trains))
	for _, t := range w.Trains {
		if seenTrain[t.ID] {
			add("duplicate train id %q", t.ID)
		}
		seenTrain[t.ID] = true

		l, ok := w.Line(t.LineID)
		if !ok {
			add("train %q references unknown line %q", t.ID, t.LineID)
			continue
		}
		if t.MaxSpeed <= 0 {
			add("train %q has non-positive maxSpeed %g", t.ID, t.MaxSpeed)
		}
		if t.Direction != 1 && t.Direction != -1 {
			add("train %q has direction %d, want +1 or -1", t.ID, t.Direction)
		}
		if t.Direction == -1 && l.Kind == KindLoop {
			add("train %q runs backwards on loop line %q", t.ID, l.ID)
		}
		if t.SegmentIndex < 0 || t.SegmentIndex >= l.NumSegments() {
			add("train %q has segmentIndex %d, want 0-%d", t.ID, t.SegmentIndex, l.NumSegments()-1)
			continue
		}
		if len(l.segLen) == l.NumSegments() {
			if t.Progress < 0 || t.Progress > l.segLen[t.SegmentIndex] {
				add("train %q has progress %g outside segment %d of length %g",
					t.ID, t.Progress, t.SegmentIndex, l.segLen[t.SegmentIndex])
			}
		}
		if t.DwellRemaining < 0 {
			add("train %q has negative dwellRemaining %g", t.ID, t.DwellRemaining)
		}
	}

	return errs
}

// MinStationSpacing returns the smallest distance between any two stations.
func (w *World) MinStationSpacing() float64 {
	best := -1.0
	for i := range w.Stations {
		for j := i + 1; j < len(w.Stations); j++ {
			if d := w.Stations[i].Pos().Dist(w.Stations[j].Pos()); best < 0 || d < best {
				best = d
			}
		}
	}
	return best
}
