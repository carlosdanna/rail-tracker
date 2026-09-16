# Measured results

Every number here was measured on one machine, listed below, and every one has a
command next to it so you can reproduce it. The acceptance criteria are spec §5;
each is quoted with what was actually observed.

## Test machine

| | |
|---|---|
| CPU | AMD Ryzen 7 7800X3D, 8 cores / 16 threads |
| Memory | 128 GiB |
| OS | Fedora, Linux 7.1.13 |
| Go | 1.26.8 |
| Node | 24.20.0 |

## Summary

| Spec §5 criterion | Result |
|---|---|
| 1. 10,000 msgs/sec, 500 trains: ~60 FPS | **Partly verified.** The ingest path costs 0.11 ms of a 16.7 ms frame. Rendered FPS needs a browser; see [What is not verified](#what-is-not-verified). |
| 1. Client memory flat over 10 minutes | **Pass.** Retained heap 22.5 → 50.7 MiB over 6,000,000 updates, with a flat sawtooth floor. |
| 2. Reconstruction matches `/world` after one cycle | **Pass.** 6/6 lines, 30/30 stations, worst error 0.00 at 500 trains. |
| 2. Same in hide-state mode | **Pass.** Identical figures with the state field ignored. |
| 2. Waypoints are not stations | **Pass.** Exactly 30 clusters for 30 stations; a misclassified waypoint would add one. |
| 3. `setRate` within one second, no reconnect | **Pass.** 200 → 2000 updates/sec inside the following second. |
| 4. A stalled client slows nobody; drops show in `/metrics` | **Pass.** Simulation kept ticking, a second client held its full rate, drops counted. |
| 5. Same seed, identical `/world` and trajectories | **Pass.** Byte-identical `/world` across processes; identical states after 400 steps. |

---

## 1. Throughput and frame budget

### Server

Started with the acceptance configuration:

```sh
make build-server
./apps/server/bin/railsim --addr 127.0.0.1:18100 --trains 500 --rate 10000
```

One client at the full rate, both wire formats:

```sh
cd apps/server
go run ./cmd/loadclient -addr 127.0.0.1:18100 -conns 1 -rate 10000 -format bin  -duration 10s
go run ./cmd/loadclient -addr 127.0.0.1:18100 -conns 1 -rate 10000 -format json -duration 10s
```

| Format | Delivered | Bandwidth | `seq` gaps |
|---|---|---|---|
| `bin` | 9,980 updates/sec | 0.20 MiB/sec | 0 |
| `json` | 9,980 updates/sec | 1.11 MiB/sec | 0 |

The rate lands on target because the emitter carries the fractional remainder of
`rate × emitTick` forward. Binary is 5.5× smaller on the wire.

Eight clients at once, i.e. 80,000 updates/sec out of one process:

```sh
go run ./cmd/loadclient -addr 127.0.0.1:18100 -conns 8 -rate 10000 -format bin -duration 10s
```

```
connections   8 at 10000 updates/sec each (80000 requested total)
received      798400 updates in 4000 frames (16.0 MiB)
throughput    79840 updates/sec
seq gaps      0 (0 updates missing)
```

Server cost while serving those eight clients, sampled from `/proc/<pid>/stat`:

| Format | CPU | RSS |
|---|---|---|
| `bin` | 2.5% of one core | 15.5 MiB |
| `json` | 8.5% of one core | 17.1 MiB |

`make bench` runs this whole sequence, starting and stopping the server itself.

### Client ingest path

The frame rate itself needs a browser, but everything that competes with it for
main-thread time does not: decoding frames, coalescing to the latest update per
train, applying to the store, and running both inference passes. The benchmark
drives exactly the spec §5.1 shape — 500 trains, 10,000 updates/sec, 200-record
frames every 20 ms, flushed once per 16.7 ms frame — through the real modules.

```sh
cd apps/client
RAIL_BENCH=1 RAIL_BENCH_SECONDS=600 NODE_OPTIONS=--expose-gc npx vitest run bench
```

```
stream            600 s at 10000 updates/sec, 500 trains
updates           6,000,000 in 30000 frames
wall time         3822 ms for 600 s of stream (0.6% of real time)
parse             542 ms total, 90 ns/update
store apply       526 ms total
inference         2200 ms total (lines 1404 ms, stations 288 ms)
per frame         0.11 ms (0.7% of a 16.7 ms budget)
heap              22.5 -> 50.7 MiB
lines/stations    6 / 22
trail points      141565
```

So the data path leaves about 99% of the frame to rendering. Decoding a binary
frame costs 90 ns per update; the JSON path costs 0.077 ms per 200-record frame,
which is 3.8 ms per second of stream.

### Memory over ten minutes

The `heap` line above is measured after a forced collection at each end:
**22.5 MiB → 50.7 MiB** across six million updates. The ten-second samples show a
sawtooth between roughly 62 and 318 MiB whose floor does not drift — 62 MiB at
290 s, 83 MiB at 400 s, 70 MiB at 500 s — so the growth is collectable garbage,
not accumulation.

Two things keep it bounded, and both are load-bearing:

- **Trails stop growing.** `trail points` is 141,565 after ten minutes and was
  *the same* 141,565 after two. Once a train's line is reconstructed its trail is
  frozen, and until then a hard cap of 512 points per train applies.
- **Unresolved paths are bounded.** `TrainPath` keeps at most 4,096 points and
  then restarts from the train's current position. Without that cap a train whose
  line never resolves would grow a point list for as long as the page is open.

---

## 2. Reconstruction against `/world`

Against a live server at the full acceptance settings, collecting for 220 s —
long enough for every train to complete a cycle — then comparing with `GET
/world`:

```sh
./apps/server/bin/railsim --addr 127.0.0.1:18100 --trains 500 --rate 10000

cd apps/client
RAIL_LIVE=1 RAIL_ADDR=127.0.0.1:18100 RAIL_RATE=10000 RAIL_SECONDS=220 npx vitest run live
RAIL_LIVE=1 RAIL_ADDR=127.0.0.1:18100 RAIL_RATE=10000 RAIL_SECONDS=220 RAIL_HIDE=1 npx vitest run live
```

| | State visible | `hideState` |
|---|---|---|
| Lines inferred | 6 of 6 | 6 of 6 |
| Stations inferred | 30 of 30 | 30 of 30 |
| Worst station error | 0.00 units | 0.00 units |
| Worst line error | 0.00 units | 0.00 units |
| Trains unassigned | 0 of 500 | 0 of 500 |
| Kinds | 5 loop, 1 shuttle | 5 loop, 1 shuttle |

All 500 trains were placed (83 + 83 + 84 + 83 + 84 + 83), and the server reported
`droppedTotal: 0` after 2.3 million updates.

"Worst line error" is the largest distance from any point of a reconstructed path
to the true track it was matched against; "worst station error" is the largest
distance from any true station to the nearest inferred one.

**Waypoints are not stations.** The world has 30 stations and its lines carry
0–3 waypoints between consecutive stops. Exactly 30 clusters were produced; any
waypoint mistaken for a station would have made it 31 or more. This holds in
hide-state mode too, where stops are inferred from a run of near-zero speeds
rather than from the state field.

### Across seeds

Reconstruction was also checked offline against recorded simulations for seeds
1, 7, 42, 99, 1234 and 20260916, each with 60 trains over 300 simulated seconds,
with and without hide-state. Every run: 6/6 lines, 30/30 stations, no unresolved
trains, 0.0 error.

The regression tests distilled from that work live in
`apps/client/test/infer.test.ts` — in particular the `hairpins` group, which is
the case that generated worlds actually produce and that a naive detector fails.
See [Notes on what was hard](#notes-on-what-was-hard).

---

## 3, 4, 5. Behaviour under control and load

These are covered by the Go integration tests, which assert the criteria directly:

```sh
cd apps/server
go test ./internal/httpapi/ -run "SetRate|SlowClient|SimulationKeepsRunning" -v
go test ./internal/world/ ./internal/sim/ -run "Determinism|Deterministic" -v
```

| Criterion | Test | Observed |
|---|---|---|
| 3. `setRate` inside a second, no reconnect | `TestSetRateTakesEffectWithoutReconnecting` | 200/sec baseline, then 2000/sec measured in the second *after* the change, on the same socket |
| 4. A stalled client slows nobody | `TestSlowClientDoesNotSlowOthers` | A client that never reads accumulates drops; a client alongside it still receives 2000 updates in 2 s at `rate=1000` |
| 4. The simulation keeps running | `TestSimulationKeepsRunningWithAStalledClient` | Kept ticking with a stalled client attached |
| 4. Drops appear in `/metrics` | `TestSlowClientDoesNotSlowOthers` | Non-zero `dropped` and `droppedFrames` for the stalled client and in `droppedTotal` |
| 5. Deterministic world | `TestGenerateIsDeterministic` | Same seed, byte-identical JSON |
| 5. Deterministic trajectories | `TestDeterminism` | Two simulations identical after 400 steps |

Criterion 5 also checked end to end, across two separate processes:

```sh
./apps/server/bin/railsim --addr 127.0.0.1:18101 --trains 500 --seed 42 &
curl -s 127.0.0.1:18101/world > a.json
./apps/server/bin/railsim --addr 127.0.0.1:18102 --trains 500 --seed 42 &
curl -s 127.0.0.1:18102/world > b.json
cmp a.json b.json
```

Identical, 75,685 bytes.

---

## What is not verified

**Rendered frame rate.** Spec §5.1 asks for ~60 FPS in the browser. This session
had no browser available, so the figure was not measured. What *is* measured is
that the data path competing with rendering costs 0.11 ms per frame, and the
renderer is covered by unit tests against a recording canvas
(`apps/client/test/renderer.test.ts`) asserting the two properties the frame
budget depends on: the static layer repaints only when the reconstruction
changes, and trains are drawn as one path per colour rather than one per train.

To measure it:

```sh
make dev RAIL_FLAGS="--trains 500 --rate 10000"
# then open http://localhost:5173/?rate=10000&format=bin&perf
```

`?perf` logs a line to the console every 10 seconds with FPS, ingest rate, drops,
trail size and — on Chromium, where `performance.memory` exists — heap size.

The same session is what confirms the Phase 7 visual checks: that trains move
smoothly, that lines and stations appear after one cycle, and that the "compare
with /world" overlay lands on top of the reconstruction.

---

## Notes on what was hard

The interesting failure was line reconstruction, and it only showed up against
real generated worlds.

Generated lines tour their stations in nearest-neighbour order, which routinely
doubles a loop back on itself through 155–177°. Locally that is almost
indistinguishable from a shuttle turning round, and the two legs of such a
hairpin then run within a few units of each other for a long way. Detecting
reversals from the heading change alone reported 11 lines where there were 6, and
called most of the loops shuttles.

Three changes fixed it, and each has a test that fails without it:

1. **A sharp turn is only a candidate.** It is held open until the train has
   travelled 150 further units, and counts as a reversal only if the track after
   the turn lies within 5 units of the track before it. A hairpin diverges; a
   real reversal does not.
2. **Closing a loop requires a heading match.** Returning to within tolerance of
   the starting point is not enough, because a train that rounded a hairpin
   shortly after being first seen passes that test while pointing the other way.
3. **A blocked closure is remembered, not dropped.** A train whose starting point
   sits just past a hairpin meets the closure conditions while that turn is still
   under judgement, on every single lap. Recording the closure and applying it
   once the turn is judged is what resolved the last five of sixty trains.

Grouping was then the performance problem: matching a completed path against
every known line is O(points²), and with paths of several hundred points and 500
trains completing it cost most of the ingest budget. A bounding-box pre-filter
and a bounded number of probe points per path made it roughly 4× cheaper, which
is the difference between 1.08 ms and 0.11 ms per frame.
