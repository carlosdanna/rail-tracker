// Package world holds the shared world model from spec §1: stations, lines and
// trains, plus deterministic generation and world.json loading.
package world

import (
	"fmt"
	"math"
)

// Tolerance used when matching a station position against a track vertex.
const posEpsilon = 1e-9

// Point is a position on the flat Cartesian plane. Y points down, matching
// canvas coordinates.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Sub returns p - q.
func (p Point) Sub(q Point) Point { return Point{p.X - q.X, p.Y - q.Y} }

// Dist returns the Euclidean distance between p and q.
func (p Point) Dist(q Point) float64 { return math.Hypot(p.X-q.X, p.Y-q.Y) }

// nearly reports whether p and q are the same position within posEpsilon.
func (p Point) nearly(q Point) bool {
	return math.Abs(p.X-q.X) <= posEpsilon && math.Abs(p.Y-q.Y) <= posEpsilon
}

// Bounds is the world extent; the origin is always (0, 0).
type Bounds struct {
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// StationID identifies a station within a world.
type StationID string

// Station is a stop on one or more lines.
type Station struct {
	ID   StationID `json:"id"`
	Name string    `json:"name"`
	X    float64   `json:"x"`
	Y    float64   `json:"y"`
}

// Pos returns the station position as a Point.
func (s Station) Pos() Point { return Point{s.X, s.Y} }

// Kind distinguishes the two line topologies.
type Kind string

const (
	// KindLoop runs A -> B -> C -> A -> ... forever in one direction.
	KindLoop Kind = "loop"
	// KindShuttle runs A -> B -> C then reverses back to A, and repeats.
	KindShuttle Kind = "shuttle"
)

// Valid reports whether k is one of the two defined kinds.
func (k Kind) Valid() bool { return k == KindLoop || k == KindShuttle }

// Line is a route: an ordered list of stops plus the polyline the train
// actually follows. Track contains every stop position and, between them,
// intermediate waypoints that curve the route. A heading change therefore does
// not imply a station.
//
// For a loop the track is open: the closing segment runs from the last track
// point back to Track[0]. For a shuttle the track ends at the last stop.
type Line struct {
	ID    string      `json:"id"`
	Name  string      `json:"name"`
	Color string      `json:"color"`
	Kind  Kind        `json:"kind"`
	Stops []StationID `json:"stops"`
	Track []Point     `json:"track"`

	// stopAt[i] is the index in Track of Stops[i]. Derived, never serialized.
	stopAt []int
	// segLen[i] is the length of the segment starting at Track[i]. Derived.
	segLen []float64
	// cumLen[i] is the distance from Track[0] to Track[i] along the track.
	cumLen []float64
	total  float64
}

// NumSegments returns the number of segments a train can occupy. A loop has one
// more than a shuttle because of the closing segment.
func (l *Line) NumSegments() int {
	if l.Kind == KindLoop {
		return len(l.Track)
	}
	return len(l.Track) - 1
}

// Segment returns the endpoints of segment i, wrapping for loops.
func (l *Line) Segment(i int) (from, to Point) {
	return l.Track[i], l.Track[(i+1)%len(l.Track)]
}

// SegmentLen returns the length of segment i.
func (l *Line) SegmentLen(i int) float64 { return l.segLen[i] }

// TotalLen returns the length of one full traversal: the whole loop, or a
// one-way shuttle run.
func (l *Line) TotalLen() float64 { return l.total }

// StopTrackIndex returns the Track index of the i'th stop.
func (l *Line) StopTrackIndex(i int) int { return l.stopAt[i] }

// StopAtTrackIndex returns the stop ordinal at track index t, or -1 if t is a
// waypoint rather than a station.
func (l *Line) StopAtTrackIndex(t int) int {
	for i, at := range l.stopAt {
		if at == t {
			return i
		}
	}
	return -1
}

// ArcToSegment converts a distance along the track into a segment index and the
// distance travelled into that segment.
func (l *Line) ArcToSegment(arc float64) (seg int, into float64) {
	if l.total <= 0 {
		return 0, 0
	}
	arc = math.Mod(arc, l.total)
	if arc < 0 {
		arc += l.total
	}
	for i := 0; i < l.NumSegments(); i++ {
		if arc < l.segLen[i] || i == l.NumSegments()-1 {
			return i, arc
		}
		arc -= l.segLen[i]
	}
	return 0, 0
}

// Train is a vehicle running along a line.
type Train struct {
	ID       string  `json:"id"`
	LineID   string  `json:"lineId"`
	MaxSpeed float64 `json:"maxSpeed"`
	// SegmentIndex is the track segment the train is on.
	SegmentIndex int `json:"segmentIndex"`
	// Progress is the distance travelled into SegmentIndex, in world units.
	Progress float64 `json:"progress"`
	// Direction is +1 along the track or -1 against it (shuttles only).
	Direction int `json:"direction"`
	// DwellRemaining is the seconds left of the current station stop.
	DwellRemaining float64 `json:"dwellRemaining"`
}

// World is the complete simulated network.
type World struct {
	Seed     int64     `json:"seed"`
	Bounds   Bounds    `json:"bounds"`
	Stations []Station `json:"stations"`
	Lines    []Line    `json:"lines"`
	Trains   []Train   `json:"trains"`
}

// Station returns the station with the given id.
func (w *World) Station(id StationID) (Station, bool) {
	for _, s := range w.Stations {
		if s.ID == id {
			return s, true
		}
	}
	return Station{}, false
}

// Line returns the line with the given id.
func (w *World) Line(id string) (*Line, bool) {
	for i := range w.Lines {
		if w.Lines[i].ID == id {
			return &w.Lines[i], true
		}
	}
	return nil, false
}

// index rebuilds every derived field on the world's lines. It must be called
// after generating or decoding a world, and it fails if a line's track does not
// contain its stops in order.
func (w *World) index() error {
	byID := make(map[StationID]Station, len(w.Stations))
	for _, s := range w.Stations {
		byID[s.ID] = s
	}
	for i := range w.Lines {
		if err := w.Lines[i].index(byID); err != nil {
			return err
		}
	}
	return nil
}

func (l *Line) index(stations map[StationID]Station) error {
	if len(l.Track) < 2 {
		return fmt.Errorf("line %s: track needs at least 2 points, has %d", l.ID, len(l.Track))
	}

	// Walk the track once, matching each stop in order.
	l.stopAt = make([]int, 0, len(l.Stops))
	next := 0
	for si, sid := range l.Stops {
		st, ok := stations[sid]
		if !ok {
			return fmt.Errorf("line %s: stop %d references unknown station %q", l.ID, si, sid)
		}
		found := -1
		for t := next; t < len(l.Track); t++ {
			if l.Track[t].nearly(st.Pos()) {
				found = t
				break
			}
		}
		if found < 0 {
			return fmt.Errorf("line %s: station %q is not on the track at or after point %d", l.ID, sid, next)
		}
		l.stopAt = append(l.stopAt, found)
		next = found + 1
	}
	if len(l.stopAt) > 0 && l.stopAt[0] != 0 {
		return fmt.Errorf("line %s: track must start at the first stop, found it at point %d", l.ID, l.stopAt[0])
	}

	return l.measure()
}
