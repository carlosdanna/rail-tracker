package sim

import "time"

// dwellFor returns the dwell time for a train arriving at the given stop.
//
// Dwell is drawn from the seed rather than from a running RNG so that it
// depends only on (seed, line, stop): the same stop always holds trains for the
// same time, which is what makes trajectories reproducible across runs and
// across the number of trains in play.
func (s *Sim) dwellFor(t *train, stop int) float64 {
	span := s.opts.MaxDwell - s.opts.MinDwell
	if span <= 0 {
		return s.opts.MinDwell.Seconds()
	}
	u := unitFloat(mix(uint64(s.opts.Seed), uint64(t.lineNo), uint64(stop)))
	return (s.opts.MinDwell + time.Duration(u*float64(span))).Seconds()
}

// mix folds its arguments into a single well-distributed 64-bit value using
// splitmix64 finalisation. It is stable across runs, platforms and Go versions.
func mix(vals ...uint64) uint64 {
	var h uint64 = 0x9e3779b97f4a7c15
	for _, v := range vals {
		h ^= v + 0x9e3779b97f4a7c15 + (h << 6) + (h >> 2)
		h ^= h >> 30
		h *= 0xbf58476d1ce4e5b9
		h ^= h >> 27
		h *= 0x94d049bb133111eb
		h ^= h >> 31
	}
	return h
}

// unitFloat maps a 64-bit hash into [0, 1).
func unitFloat(h uint64) float64 {
	return float64(h>>11) / float64(uint64(1)<<53)
}
