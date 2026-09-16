# Rail Tracker: Specification

A Go server simulates trains running on fixed lines between stations and streams their positions at a configurable rate. A TypeScript client consumes the stream and draws the network map, train positions, and reconstructed lines.

**Core design principle:** decouple generation rate from rendering rate on both sides. The server simulates at a fixed tick and emits at a configurable rate. The client ingests as fast as messages arrive and renders on its own frame loop.

---

## 1. World model (shared)

### Coordinate space
- Flat Cartesian plane, default bounds `0–1000 × 0–1000`, resizable with
  `--width` and `--height`. No lat/lon or projection.
- Y axis points down, matching canvas coordinates.
- The plane is arbitrary, so a world may be far larger than the default. Two
  things follow and the implementation must honour both:
  - **Speed scales with the world.** Trains keep the default `--speed 0`
    behaviour of scaling to the shorter side, so a lap takes a comparable time
    however big the map is. A fixed speed on a 200,000-unit map would mean laps
    of nearly an hour and no client would ever reconstruct a line.
  - **Client thresholds scale with the world.** Every distance the client infers
    with — trail thinning, path matching, stop clustering — is derived from the
    `bounds` in `hello` rather than fixed, since a threshold only discriminates
    at the size it was tuned for.

### Limits
- `--trains` may not exceed **65,535**: the binary record addresses trains with
  a `u16` (§2), so beyond that they would alias on the wire.
- `--stations` may not exceed `--lines × --stops-per-line`, since every station
  must be served by at least one line.
- Binary `x`/`y` are `f32`, giving roughly seven significant digits. At a
  1,000,000-unit span that is still sub-0.1-unit precision.

### Stations
- Fields: `{ id: string, name: string, x: number, y: number }`.
- Loaded from `world.json` or generated deterministically from a seed.

### Lines
- Fields: `{ id, name, color, kind, stops: StationId[], track: Point[] }`.
- `kind` is one of two values:
  - `loop`: the train runs A → B → C → A → ….
  - `shuttle`: the train runs A → B → C, then reverses C → B → A, and repeats.
- `track` is the polyline the train follows. It includes every station position plus intermediate **waypoints** (curves). As a result, a heading change does *not* necessarily mean a station, which makes station inference a real problem.

### Trains
- Fields: `{ id, lineId, maxSpeed, segmentIndex, progress, direction, dwellRemaining }`.
- Movement follows the track polyline at up to `maxSpeed` units/sec.
- **Dwell:** a train stops at every station on its line for a configurable dwell time (default 2–5 s, randomized per stop from the seed).
- **Acceleration (optional, `--accel`):** trains ramp speed down approaching a station and up when departing. When disabled, speed is constant between stations and 0 while dwelling.
- **Stagger:** multiple trains per line start at staggered offsets.

### Heading
- Degrees, where 0 = north (up, −Y) and angles increase clockwise.
- The server also sends an 8-way compass enum (`N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`) derived from the heading.

### Train state
- `running`: moving between stations.
- `at_station`: dwelling. Speed is 0.
- `--hide-state` removes this field from the stream (hard mode). The client must then infer stops from speed ≈ 0 across consecutive updates.

---

## 2. Protocol

Transport: WebSocket at `/stream`.

### Query parameters
- `format=json|bin` (default `json`).
- `rate=<int>`: messages/sec for this connection. It overrides the server default.

### Server → client: `hello` (always JSON, sent first)
```json
{ "type": "hello", "version": 1,
  "bounds": { "w": 1000, "h": 1000 },
  "trainCount": 500, "rate": 10000, "format": "json",
  "hideState": false }
```
Stations and lines are **not** sent. The client must reconstruct them from updates.

### Server → client: `batch` (JSON)
Updates are batched per emit tick. One WebSocket frame per update does not scale.
```json
{ "type": "batch", "t": 1726400000123,
  "updates": [
    { "seq": 10423, "train": "T-17", "x": 412.5, "y": 88.2,
      "heading": 135, "compass": "SE", "speed": 4.2, "state": "running" }
  ] }
```
- `seq` is monotonic per connection across all updates. Gaps mean dropped updates.
- `t` is the server wall-clock time in ms at emit.

### Server → client: binary frame (`format=bin`)
All values are little-endian.

**Header (12 bytes)**

| Offset | Type | Field |
|---|---|---|
| 0 | u8 | version (1) |
| 1 | u8 | frame type (1 = batch) |
| 2 | u16 | record count |
| 4 | f64 | t (ms since epoch) |

**Record (21 bytes each)**

| Offset | Type | Field |
|---|---|---|
| 0 | u16 | train index (`T-<index>`) |
| 2 | f32 | x |
| 6 | f32 | y |
| 10 | u16 | heading (degrees ×10) |
| 12 | f32 | speed |
| 16 | u8 | state (0 = running, 1 = at_station, 255 = hidden) |
| 17 | u32 | seq |

### Client → server messages (JSON)
- `{ "type": "setRate", "rate": 5000 }` changes this connection's rate without reconnecting.
- `{ "type": "ping", "id": 1 }` is answered with `{ "type": "pong", "id": 1, "t": ... }` for latency measurement.

### HTTP endpoints
- `GET /world` (debug): the full stations, lines, and trains. Used for verification only.
- `GET /metrics`: JSON with `clients`, `sentTotal`, `droppedTotal`, per-client rate/sent/dropped, and `simTickMs`.
- `POST /config`: `{ "rate": n }` changes the default rate for all clients that haven't overridden it.
- `GET /healthz`.

---

## 3. Go server

### Configuration
Flags, each overridable by an environment variable with the `RAIL_` prefix:

| Flag | Default | Meaning |
|---|---|---|
| `--addr` | `:8080` | Listen address |
| `--rate` | `1000` | Total updates/sec per client |
| `--trains` | `100` | Number of trains |
| `--lines` | `6` | Number of generated lines |
| `--stations` | `30` | Number of generated stations |
| `--width` | `1000` | World width in units |
| `--height` | `1000` | World height in units |
| `--stops-per-line` | `8` | Most stations one generated line serves |
| `--speed` | `0` | Top train speed in units/sec; `0` scales it to the world |
| `--seed` | `42` | World seed |
| `--tick` | `50ms` | Simulation step |
| `--emit-tick` | `20ms` | Emitter batch interval |
| `--world` | (empty) | Path to `world.json` (overrides generation) |
| `--accel` | `false` | Enable acceleration model |
| `--hide-state` | `false` | Omit train state from the stream |
| `--format` | `json` | Default wire format |

### Architecture
- **Simulation goroutine**
  - Advances all trains every `tick`.
  - Publishes an immutable snapshot (`[]TrainState`) via `atomic.Pointer`.
  - Never blocks on clients.
- **Client emitter (one goroutine per connection)**
  - Runs a ticker at `emit-tick`.
  - Each tick sends `batch = rate × emitTick` updates, carrying the fractional remainder forward so the long-run rate is exact.
  - Round-robins through trains in the latest snapshot. When `rate > trains / tick`, the same train is sent repeatedly with fresh snapshots, which is fine.
- **Writer (one goroutine per connection)**
  - Reads from a bounded channel of encoded frames.
  - If the channel is full, the emitter drops the frame and increments the `dropped` counter. The emitter never blocks.
- **Reader (one goroutine per connection)**
  - Handles `setRate` and `ping`.
  - Stores the new rate in an `atomic.Int64`.
- **Shutdown:** graceful on SIGINT/SIGTERM using context cancellation.
- **Library:** `github.com/coder/websocket` for WebSockets. Otherwise use the standard library only (`log/slog` for logging).
- **Determinism:** the same seed and flags produce an identical world and identical train trajectories.

---

## 4. TypeScript client

- **Stack:** Vite and TypeScript (strict). No UI framework is required; plain DOM for the HUD is fine.
- **Connection layer**
  - WebSocket wrapper with exponential backoff reconnect.
  - Parsing (JSON and binary) happens in a **Web Worker**.
  - The worker posts compact batches to the main thread at most once per animation frame.
- **State store**
  - `Map<trainId, TrainState>` holds the latest update per train.
  - `Map<trainId, Point[]>` holds trails.
    - Append a point only if the train moved more than ε or its heading changed more than δ.
    - Stop appending once the train's line is reconstructed.
    - Hard cap per train.
- **Line reconstruction**
  - A train's line is known once its trail closes (loop) or it reverses along its own path (shuttle).
  - Trains whose reconstructed paths match within tolerance are grouped into the same line.
- **Station inference**
  - A stop is where `state === at_station`. In hide-state mode, a stop is where speed ≈ 0 for at least N consecutive updates.
  - Cluster stop points across all trains using radius `r` to produce stations.
  - Waypoints (heading changes without stopping) are **not** stations.
- **Rendering**
  - Canvas 2D on a `requestAnimationFrame` loop.
  - Static layer: an offscreen canvas holding lines and stations, redrawn only when they change.
  - Dynamic layer: trains drawn as oriented markers colored by inferred line.
  - Dead-reckon between updates using heading and speed, clamped to a short horizon.
- **HUD**
  - Stats: messages/sec in, dropped (from `seq` gaps), render FPS, train count, inferred lines and stations, latency (ping).
  - Controls: rate input (sends `setRate`), format toggle (reconnects), trails toggle, "compare with /world" overlay toggle.

---

## 5. Acceptance criteria

1. At 10,000 msgs/sec with 500 trains:
   - the client holds ~60 FPS;
   - client memory stays flat over 10 minutes.
2. After each train completes one full line cycle, reconstructed lines and inferred stations match `/world` within tolerance.
   - This includes hide-state mode.
   - Waypoints are not misclassified as stations.
3. `setRate` takes effect within one second, without a reconnect.
4. A slow or stalled client never slows the simulation or other clients. Its drops show up in `/metrics`.
5. The same seed produces an identical `/world` and identical trajectories.
