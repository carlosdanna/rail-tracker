package world

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// Load reads and validates a world from a world.json file.
func Load(path string) (*World, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open world: %w", err)
	}
	defer f.Close()
	w, err := Decode(f)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return w, nil
}

// Decode reads a world from r, rebuilds its derived fields and validates it.
func Decode(r io.Reader) (*World, error) {
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()

	var w World
	if err := dec.Decode(&w); err != nil {
		return nil, fmt.Errorf("decode world: %w", err)
	}
	if err := dec.Decode(new(json.RawMessage)); err != io.EOF {
		return nil, fmt.Errorf("decode world: trailing data after the top-level object")
	}
	if err := w.index(); err != nil {
		return nil, err
	}
	if err := w.Validate(); err != nil {
		return nil, err
	}
	return &w, nil
}

// Encode writes the world as indented JSON. The output is stable for a given
// world, which is what the determinism tests compare.
func (w *World) Encode(out io.Writer) error {
	enc := json.NewEncoder(out)
	enc.SetIndent("", "  ")
	return enc.Encode(w)
}

// JSON returns the world's canonical JSON encoding.
func (w *World) JSON() ([]byte, error) {
	return json.MarshalIndent(w, "", "  ")
}
