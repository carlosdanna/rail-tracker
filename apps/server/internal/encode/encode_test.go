package encode

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/carlosdanna/rail-tracker/server/internal/sim"
)

func sampleUpdates() []Update {
	return []Update{
		{Seq: 10423, Train: "T-17", Index: 17, X: 412.5, Y: 88.25, Heading: 135, Compass: sim.SE, Speed: 4.25, State: sim.StateRunning},
		{Seq: 10424, Train: "T-3", Index: 3, X: 0, Y: 1000, Heading: 359.94, Compass: sim.N, Speed: 0, State: sim.StateAtStation},
	}
}

func TestBinaryLayout(t *testing.T) {
	updates := sampleUpdates()
	got := BinaryBatch(nil, 1726400000123, updates, false)

	if len(got) != HeaderSize+len(updates)*RecordSize {
		t.Fatalf("frame is %d bytes, want %d", len(got), HeaderSize+len(updates)*RecordSize)
	}
	if got[0] != Version {
		t.Fatalf("version = %d, want %d", got[0], Version)
	}
	if got[1] != FrameBatch {
		t.Fatalf("frame type = %d, want %d", got[1], FrameBatch)
	}
	if n := binary.LittleEndian.Uint16(got[2:4]); int(n) != len(updates) {
		t.Fatalf("record count = %d, want %d", n, len(updates))
	}
	if ts := math.Float64frombits(binary.LittleEndian.Uint64(got[4:12])); ts != 1726400000123 {
		t.Fatalf("t = %v, want 1726400000123", ts)
	}

	rec := got[HeaderSize : HeaderSize+RecordSize]
	if idx := binary.LittleEndian.Uint16(rec[0:2]); idx != 17 {
		t.Fatalf("train index = %d, want 17", idx)
	}
	if x := math.Float32frombits(binary.LittleEndian.Uint32(rec[2:6])); x != 412.5 {
		t.Fatalf("x = %v, want 412.5", x)
	}
	if y := math.Float32frombits(binary.LittleEndian.Uint32(rec[6:10])); y != 88.25 {
		t.Fatalf("y = %v, want 88.25", y)
	}
	if h := binary.LittleEndian.Uint16(rec[10:12]); h != 1350 {
		t.Fatalf("heading = %d, want 1350 (135.0 degrees x10)", h)
	}
	if sp := math.Float32frombits(binary.LittleEndian.Uint32(rec[12:16])); sp != 4.25 {
		t.Fatalf("speed = %v, want 4.25", sp)
	}
	if rec[16] != StateRunning {
		t.Fatalf("state = %d, want %d", rec[16], StateRunning)
	}
	if seq := binary.LittleEndian.Uint32(rec[17:21]); seq != 10423 {
		t.Fatalf("seq = %d, want 10423", seq)
	}

	second := got[HeaderSize+RecordSize:]
	if second[16] != StateAtStation {
		t.Fatalf("second record state = %d, want %d", second[16], StateAtStation)
	}
	// 359.94 degrees rounds to 3599 tenths, not 3600.
	if h := binary.LittleEndian.Uint16(second[10:12]); h != 3599 {
		t.Fatalf("heading = %d, want 3599", h)
	}
}

func TestBinaryHideState(t *testing.T) {
	got := BinaryBatch(nil, 0, sampleUpdates(), true)
	for i := 0; i < 2; i++ {
		rec := got[HeaderSize+i*RecordSize:]
		if rec[16] != StateHidden {
			t.Fatalf("record %d state = %d, want %d when hidden", i, rec[16], StateHidden)
		}
	}
}

func TestBinaryReusesBuffer(t *testing.T) {
	buf := make([]byte, 0, 4096)
	first := BinaryBatch(buf, 1, sampleUpdates(), false)
	if &first[0] != &buf[:1][0] {
		t.Fatal("a large enough buffer should be reused, not reallocated")
	}
	// A frame bigger than the buffer must allocate rather than overflow.
	big := make([]Update, 300)
	out := BinaryBatch(make([]byte, 0, 8), 1, big, false)
	if len(out) != HeaderSize+300*RecordSize {
		t.Fatalf("frame is %d bytes, want %d", len(out), HeaderSize+300*RecordSize)
	}
}

func TestBinaryClampsRecordCount(t *testing.T) {
	// The count field is a u16, so a batch cannot exceed 65535 records.
	updates := make([]Update, math.MaxUint16+10)
	got := BinaryBatch(nil, 0, updates, false)
	if n := binary.LittleEndian.Uint16(got[2:4]); n != math.MaxUint16 {
		t.Fatalf("record count = %d, want %d", n, math.MaxUint16)
	}
	if len(got) != HeaderSize+math.MaxUint16*RecordSize {
		t.Fatalf("frame is %d bytes, want %d", len(got), HeaderSize+math.MaxUint16*RecordSize)
	}
}

func TestJSONBatchShape(t *testing.T) {
	raw, err := JSONBatch(1726400000123, sampleUpdates(), false)
	if err != nil {
		t.Fatalf("JSONBatch: %v", err)
	}

	var got struct {
		Type    string `json:"type"`
		T       int64  `json:"t"`
		Updates []struct {
			Seq     uint32  `json:"seq"`
			Train   string  `json:"train"`
			X       float64 `json:"x"`
			Y       float64 `json:"y"`
			Heading float64 `json:"heading"`
			Compass string  `json:"compass"`
			Speed   float64 `json:"speed"`
			State   *string `json:"state"`
		} `json:"updates"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Type != "batch" || got.T != 1726400000123 || len(got.Updates) != 2 {
		t.Fatalf("unexpected batch envelope: %+v", got)
	}
	u := got.Updates[0]
	if u.Seq != 10423 || u.Train != "T-17" || u.X != 412.5 || u.Y != 88.25 ||
		u.Heading != 135 || u.Compass != "SE" || u.Speed != 4.25 {
		t.Fatalf("unexpected first update: %+v", u)
	}
	if u.State == nil || *u.State != "running" {
		t.Fatalf("state = %v, want \"running\"", u.State)
	}
	if s := got.Updates[1].State; s == nil || *s != "at_station" {
		t.Fatalf("second state = %v, want \"at_station\"", s)
	}
}

func TestJSONHideStateOmitsTheField(t *testing.T) {
	raw, err := JSONBatch(0, sampleUpdates(), true)
	if err != nil {
		t.Fatalf("JSONBatch: %v", err)
	}
	if strings.Contains(string(raw), `"state"`) {
		t.Fatalf("hide-state JSON still contains a state field: %s", raw)
	}

	// Every other field survives.
	if !strings.Contains(string(raw), `"compass":"SE"`) {
		t.Fatalf("hide-state JSON dropped more than the state field: %s", raw)
	}
}

func TestHeadingTenths(t *testing.T) {
	cases := []struct {
		in   float64
		want uint16
	}{
		{0, 0},
		{359.99, 0}, // rounds to 3600, wraps to 0
		{360, 0},
		{45, 450},
		{135.04, 1350},
		{-90, 2700},
		{720.5, 5},
	}
	for _, tc := range cases {
		if got := headingTenths(tc.in); got != tc.want {
			t.Fatalf("headingTenths(%g) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestMarshalHelloAlwaysSetsTypeAndVersion(t *testing.T) {
	raw, err := MarshalHello(Hello{
		Type: "wrong", Version: 99,
		Bounds: Bounds{W: 1000, H: 1000}, TrainCount: 500,
		Rate: 10000, Format: "bin", HideState: true,
	})
	if err != nil {
		t.Fatalf("MarshalHello: %v", err)
	}
	var got Hello
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Type != "hello" || got.Version != Version {
		t.Fatalf("hello = %+v, want type \"hello\" and version %d", got, Version)
	}
	if !got.HideState || got.Format != "bin" || got.TrainCount != 500 || got.Rate != 10000 {
		t.Fatalf("hello lost fields: %+v", got)
	}
}
