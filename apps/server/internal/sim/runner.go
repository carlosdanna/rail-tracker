package sim

import (
	"context"
	"time"
)

// Run advances the simulation on a fixed tick until ctx is cancelled. It is
// meant to be the body of a dedicated goroutine and never blocks on clients:
// readers pick up whatever Latest returns.
//
// Each wake-up advances by exactly one tick of simulated time, so the world
// stays deterministic even if the host stalls; real time and simulated time
// drift apart instead.
func (s *Sim) Run(ctx context.Context, tick time.Duration) {
	if tick <= 0 {
		panic("sim: tick must be positive")
	}
	tk := time.NewTicker(tick)
	defer tk.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
			s.Step(tick)
		}
	}
}
