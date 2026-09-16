package world

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mutate decodes a generated world into a generic map, lets fn edit it, and
// returns the re-encoded bytes. This keeps the bad-input cases short.
func mutate(t *testing.T, fn func(m map[string]any)) []byte {
	t.Helper()
	b := mustJSON(t, mustGenerate(t, defaultParams(3)))
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	fn(m)
	out, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return out
}

func TestDecodeRejectsInvalidWorlds(t *testing.T) {
	cases := []struct {
		name string
		body []byte
		want string
	}{
		{
			name: "not json",
			body: []byte("{nope"),
			want: "decode world",
		},
		{
			name: "unknown field",
			body: []byte(`{"bounds":{"w":1,"h":1},"nonsense":true}`),
			want: "unknown field",
		},
		{
			name: "trailing data",
			body: []byte(`{"bounds":{"w":1,"h":1}} {"bounds":{"w":1,"h":1}}`),
			want: "trailing data",
		},
		{
			name: "unknown station on a line",
			body: mutate(t, func(m map[string]any) {
				lines := m["lines"].([]any)
				l := lines[0].(map[string]any)
				stops := l["stops"].([]any)
				stops[0] = "S-does-not-exist"
			}),
			want: "unknown station",
		},
		{
			name: "station missing from the track",
			body: mutate(t, func(m map[string]any) {
				l := m["lines"].([]any)[0].(map[string]any)
				track := l["track"].([]any)
				l["track"] = track[1:]
			}),
			want: "is not on the track",
		},
		{
			name: "train on an unknown line",
			body: mutate(t, func(m map[string]any) {
				m["trains"].([]any)[0].(map[string]any)["lineId"] = "L-nope"
			}),
			want: "unknown line",
		},
		{
			name: "train off the end of its line",
			body: mutate(t, func(m map[string]any) {
				m["trains"].([]any)[0].(map[string]any)["segmentIndex"] = 9999
			}),
			want: "segmentIndex",
		},
		{
			name: "bad line kind",
			body: mutate(t, func(m map[string]any) {
				m["lines"].([]any)[0].(map[string]any)["kind"] = "spiral"
			}),
			want: "invalid kind",
		},
		{
			name: "orphan station",
			body: mutate(t, func(m map[string]any) {
				stations := m["stations"].([]any)
				m["stations"] = append(stations, map[string]any{
					"id": "S-orphan", "name": "Orphan", "x": 10.0, "y": 10.0,
				})
			}),
			want: "not served by any line",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Decode(bytes.NewReader(tc.body))
			if err == nil {
				t.Fatal("want an error, got nil")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

func TestLoadFromFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "world.json")
	want := mustGenerate(t, defaultParams(11))
	if err := os.WriteFile(path, mustJSON(t, want), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !bytes.Equal(mustJSON(t, want), mustJSON(t, got)) {
		t.Fatal("loaded world differs from the one written")
	}

	if _, err := Load(filepath.Join(dir, "missing.json")); err == nil {
		t.Fatal("loading a missing file should fail")
	}
}
