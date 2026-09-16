// Package encode turns simulation snapshots into the wire frames defined in
// spec §2: a JSON batch, a binary batch, and the JSON hello frame.
package encode

import (
	"encoding/binary"
	"encoding/json"
	"math"

	"github.com/carlosdanna/rail-tracker/server/internal/sim"
)

// Protocol constants from spec §2.
const (
	// Version is the protocol version carried by hello and by binary frames.
	Version = 1

	// FrameBatch is the binary frame type for a batch of updates.
	FrameBatch = 1

	// HeaderSize is the size of a binary frame header in bytes.
	HeaderSize = 12
	// RecordSize is the size of one binary update record in bytes.
	RecordSize = 21

	// StateRunning, StateAtStation and StateHidden are the binary state codes.
	StateRunning   = 0
	StateAtStation = 1
	StateHidden    = 255
)

// Update is one train position on the wire.
type Update struct {
	Seq     uint32
	Train   string
	Index   int
	X       float64
	Y       float64
	Heading float64
	Compass sim.Compass
	Speed   float64
	State   sim.State
}

// Hello is the first frame on every connection. It is always JSON.
type Hello struct {
	Type       string `json:"type"`
	Version    int    `json:"version"`
	Bounds     Bounds `json:"bounds"`
	TrainCount int    `json:"trainCount"`
	Rate       int    `json:"rate"`
	Format     string `json:"format"`
	HideState  bool   `json:"hideState"`
}

// Bounds is the world extent advertised in hello.
type Bounds struct {
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// MarshalHello encodes the hello frame.
func MarshalHello(h Hello) ([]byte, error) {
	h.Type = "hello"
	h.Version = Version
	return json.Marshal(h)
}

// jsonUpdate mirrors Update with the wire field names. State is a pointer so
// that hide-state mode omits it entirely rather than sending an empty string.
type jsonUpdate struct {
	Seq     uint32  `json:"seq"`
	Train   string  `json:"train"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Heading float64 `json:"heading"`
	Compass string  `json:"compass"`
	Speed   float64 `json:"speed"`
	State   *string `json:"state,omitempty"`
}

type jsonBatch struct {
	Type    string       `json:"type"`
	T       int64        `json:"t"`
	Updates []jsonUpdate `json:"updates"`
}

// JSONBatch encodes updates as a JSON batch frame. t is the server wall-clock
// time in milliseconds. When hideState is true the state field is omitted.
func JSONBatch(t int64, updates []Update, hideState bool) ([]byte, error) {
	b := jsonBatch{Type: "batch", T: t, Updates: make([]jsonUpdate, len(updates))}
	for i, u := range updates {
		ju := jsonUpdate{
			Seq:     u.Seq,
			Train:   u.Train,
			X:       round(u.X, 1000),
			Y:       round(u.Y, 1000),
			Heading: round(u.Heading, 10),
			Compass: string(u.Compass),
			Speed:   round(u.Speed, 1000),
		}
		if !hideState {
			s := string(u.State)
			ju.State = &s
		}
		b.Updates[i] = ju
	}
	return json.Marshal(b)
}

// BinaryBatch encodes updates using the layout in spec §2. It appends to dst,
// which lets callers reuse a buffer across emit ticks.
//
// Header (12 bytes): u8 version, u8 frame type, u16 record count, f64 t.
// Record (21 bytes): u16 train index, f32 x, f32 y, u16 heading×10, f32 speed,
// u8 state, u32 seq. Everything is little-endian.
func BinaryBatch(dst []byte, t float64, updates []Update, hideState bool) []byte {
	n := len(updates)
	if n > math.MaxUint16 {
		n = math.MaxUint16
	}

	need := HeaderSize + n*RecordSize
	if cap(dst) < need {
		dst = make([]byte, 0, need)
	}
	out := dst[:need]

	out[0] = Version
	out[1] = FrameBatch
	binary.LittleEndian.PutUint16(out[2:4], uint16(n))
	binary.LittleEndian.PutUint64(out[4:12], math.Float64bits(t))

	off := HeaderSize
	for _, u := range updates[:n] {
		rec := out[off : off+RecordSize]
		binary.LittleEndian.PutUint16(rec[0:2], uint16(u.Index))
		binary.LittleEndian.PutUint32(rec[2:6], math.Float32bits(float32(u.X)))
		binary.LittleEndian.PutUint32(rec[6:10], math.Float32bits(float32(u.Y)))
		binary.LittleEndian.PutUint16(rec[10:12], headingTenths(u.Heading))
		binary.LittleEndian.PutUint32(rec[12:16], math.Float32bits(float32(u.Speed)))
		rec[16] = stateByte(u.State, hideState)
		binary.LittleEndian.PutUint32(rec[17:21], u.Seq)
		off += RecordSize
	}
	return out
}

// headingTenths converts a heading in degrees to the u16 tenths-of-a-degree
// field, normalised into [0, 3600).
func headingTenths(h float64) uint16 {
	v := math.Mod(h, 360)
	if v < 0 {
		v += 360
	}
	t := int(math.Round(v * 10))
	if t >= 3600 {
		t -= 3600
	}
	return uint16(t)
}

// stateByte maps a train state to its binary code, or 255 when hidden.
func stateByte(s sim.State, hideState bool) byte {
	if hideState {
		return StateHidden
	}
	if s == sim.StateAtStation {
		return StateAtStation
	}
	return StateRunning
}

// round trims a float to a fixed number of decimal places so that JSON frames
// stay compact and byte-stable.
func round(v, scale float64) float64 {
	return math.Round(v*scale) / scale
}
