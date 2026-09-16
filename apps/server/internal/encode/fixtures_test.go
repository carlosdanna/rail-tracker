package encode

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/carlosdanna/rail-tracker/server/internal/sim"
	"github.com/carlosdanna/rail-tracker/server/internal/world"
)

// update regenerates the golden files instead of asserting against them:
//
//	go test ./internal/encode -update
var update = flag.Bool("update", false, "rewrite the golden fixtures in protocol/fixtures")

// fixtureTime is a fixed wall-clock stamp so the fixtures never change between
// runs. It is the value used in the spec's example batch.
const fixtureTime = int64(1726400000123)

// fixtureDir locates protocol/fixtures from this package.
func fixtureDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "protocol", "fixtures"))
	if err != nil {
		t.Fatalf("resolve fixture dir: %v", err)
	}
	return dir
}

// fixtureUpdates builds a deterministic batch: seed 42, twelve trains, two
// seconds of simulated time, then the first eight trains in index order.
func fixtureUpdates(t *testing.T) ([]Update, *world.World) {
	t.Helper()
	w, err := world.Generate(world.GenParams{
		Seed: 42, Bounds: world.Bounds{W: 1000, H: 1000},
		Stations: 30, Lines: 6, Trains: 12,
	})
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	s := sim.New(w, sim.DefaultOptions(42))
	for i := 0; i < 40; i++ {
		s.Step(50 * time.Millisecond)
	}

	snap := s.Latest()
	updates := make([]Update, 0, 8)
	for i, ts := range snap.Trains {
		if i == 8 {
			break
		}
		updates = append(updates, Update{
			Seq:     uint32(1000 + i),
			Train:   ts.ID,
			Index:   ts.Index,
			X:       ts.X,
			Y:       ts.Y,
			Heading: ts.Heading,
			Compass: ts.Compass,
			Speed:   ts.Speed,
			State:   ts.State,
		})
	}
	return updates, w
}

// goldenFile compares got against the fixture at name, or rewrites it when
// -update is set.
func goldenFile(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join(fixtureDir(t), name)
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		t.Logf("updated %s (%d bytes)", name, len(got))
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (run `go test ./internal/encode -update` to create it)", name, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s does not match the golden fixture (%d bytes vs %d); "+
			"re-run with -update if the change is intended", name, len(got), len(want))
	}
}

// indentJSON pretty-prints so the fixtures stay readable in diffs and in the
// TypeScript test suite.
func indentJSON(t *testing.T, raw []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err != nil {
		t.Fatalf("indent: %v", err)
	}
	buf.WriteByte('\n')
	return buf.Bytes()
}

func TestGoldenHello(t *testing.T) {
	_, w := fixtureUpdates(t)
	raw, err := MarshalHello(Hello{
		Bounds:     Bounds{W: w.Bounds.W, H: w.Bounds.H},
		TrainCount: len(w.Trains),
		Rate:       10000,
		Format:     "json",
		HideState:  false,
	})
	if err != nil {
		t.Fatalf("MarshalHello: %v", err)
	}
	goldenFile(t, "hello.json", indentJSON(t, raw))
}

func TestGoldenBatchJSON(t *testing.T) {
	updates, _ := fixtureUpdates(t)
	raw, err := JSONBatch(fixtureTime, updates, false)
	if err != nil {
		t.Fatalf("JSONBatch: %v", err)
	}
	goldenFile(t, "batch.json", indentJSON(t, raw))
}

func TestGoldenBatchBinary(t *testing.T) {
	updates, _ := fixtureUpdates(t)
	got := BinaryBatch(nil, float64(fixtureTime), updates, false)
	goldenFile(t, "batch.bin", got)
}

func TestGoldenBatchHiddenState(t *testing.T) {
	updates, _ := fixtureUpdates(t)

	raw, err := JSONBatch(fixtureTime, updates, true)
	if err != nil {
		t.Fatalf("JSONBatch: %v", err)
	}
	goldenFile(t, "batch-hidden.json", indentJSON(t, raw))

	goldenFile(t, "batch-hidden.bin", BinaryBatch(nil, float64(fixtureTime), updates, true))
}
