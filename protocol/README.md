# Wire protocol

This directory is the shared contract between `apps/server` and `apps/client`.
The normative definition is [`docs/SPEC.md`](../docs/SPEC.md) §2; this file is the
byte-level summary, and `fixtures/` holds golden frames that **both** test suites
assert against.

Transport is a WebSocket at `/stream`. Everything numeric in the binary format is
**little-endian**.

## Query parameters

| Parameter | Values | Default | Meaning |
|---|---|---|---|
| `format` | `json`, `bin` | server `--format` | wire format for batch frames |
| `rate` | integer ≥ 0 | server `--rate` | updates/sec for this connection |

## Server → client

### `hello` (always JSON, always first)

```json
{ "type": "hello", "version": 1,
  "bounds": { "w": 1000, "h": 1000 },
  "trainCount": 500, "rate": 10000, "format": "json",
  "hideState": false }
```

Stations and lines are deliberately **not** sent. The client reconstructs them
from the position stream.

### `batch` (JSON)

```json
{ "type": "batch", "t": 1726400000123,
  "updates": [
    { "seq": 10423, "train": "T-17", "x": 412.5, "y": 88.2,
      "heading": 135, "compass": "SE", "speed": 4.2, "state": "running" }
  ] }
```

- `t` — server wall-clock milliseconds at emit.
- `seq` — monotonic per connection across all updates; a gap means the server
  dropped a frame for this client.
- `state` — `running` or `at_station`. With `--hide-state` the key is **absent**.
- `x`, `y` and `speed` are rounded to 3 decimal places, `heading` to 1.

### Binary frame (`format=bin`)

One WebSocket binary message per batch: a 12-byte header followed by
`recordCount` fixed-size 21-byte records.

**Header — 12 bytes**

| Offset | Size | Type | Field | Notes |
|---|---|---|---|---|
| 0 | 1 | u8 | version | always `1` |
| 1 | 1 | u8 | frame type | `1` = batch |
| 2 | 2 | u16 | record count | ≤ 65535 |
| 4 | 8 | f64 | `t` | ms since the Unix epoch |

**Record — 21 bytes, repeated `recordCount` times**

| Offset | Size | Type | Field | Notes |
|---|---|---|---|---|
| 0 | 2 | u16 | train index | the `n` in `T-<n>` |
| 2 | 4 | f32 | x | world units |
| 6 | 4 | f32 | y | world units, Y down |
| 10 | 2 | u16 | heading | degrees × 10, `0`–`3599` |
| 12 | 4 | f32 | speed | units/sec |
| 16 | 1 | u8 | state | `0` running, `1` at_station, `255` hidden |
| 17 | 4 | u32 | seq | monotonic per connection |

Total frame size is `12 + 21 × recordCount` bytes.

## Client → server (always JSON)

| Message | Effect |
|---|---|
| `{ "type": "setRate", "rate": 5000 }` | changes this connection's rate, no reconnect |
| `{ "type": "ping", "id": 1 }` | answered with `{ "type": "pong", "id": 1, "t": <ms> }` |

## Coordinates and heading

- Flat Cartesian plane, default bounds `0–1000 × 0–1000`, **Y points down** to
  match canvas coordinates.
- `heading` is degrees where **0 = north (−Y)** and angles increase **clockwise**,
  so 90 = east, 180 = south, 270 = west.
- `compass` is the same heading snapped to the nearest of `N NE E SE S SW W NW`
  (each bucket is 45° wide and centred on its cardinal value).

## Fixtures

| File | Contents |
|---|---|
| `fixtures/hello.json` | the `hello` frame |
| `fixtures/batch.json` | a `batch` frame in JSON |
| `fixtures/batch.bin` | the same eight updates in binary |
| `fixtures/batch-hidden.json` | the same batch with `--hide-state` |
| `fixtures/batch-hidden.bin` | the same batch in binary with `--hide-state` |

All five come from one deterministic source: world seed 42 with 30 stations,
6 lines and 12 trains, advanced 40 steps of 50 ms, then the first eight trains
in index order with `seq` starting at 1000 and `t` pinned to `1726400000123`.

`batch.json` and `batch.bin` describe the **same** eight updates, which is what
makes them a cross-language contract: the Go encoder tests assert the bytes, and
the client's parser tests assert that both decode to identical `TrainUpdate[]`.

One caveat when comparing the two: the binary format stores `x`, `y` and `speed`
as **f32** while JSON carries them rounded to 3 decimals, so the decoded values
agree to about 1e-3 rather than exactly. `heading` matches exactly, since both
sides quantise to a tenth of a degree.

Regenerate after any encoder change:

```sh
cd apps/server && go test ./internal/encode -update
```
