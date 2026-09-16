# Rail Tracker

A Go server simulates trains running on fixed lines between stations and streams
their positions over WebSocket at a configurable rate. A TypeScript canvas client
consumes the stream and reconstructs the network — lines and stations are **not**
sent, only train positions, so the client has to infer the map.

The full specification lives in [`docs/SPEC.md`](docs/SPEC.md); the wire format is
summarised in [`protocol/README.md`](protocol/README.md).

## Layout

```
apps/server/     Go module: simulation, encoders, WebSocket streaming
apps/client/     Vite + TypeScript canvas client
protocol/        wire-format docs and golden fixtures shared by both test suites
docs/            specification and measured results
```

## Requirements

- Go ≥ 1.23
- Node ≥ 20 and pnpm ≥ 10

## Quick start

```sh
pnpm install     # or: make install
make dev         # runs railsim on :8080 and Vite on :5173
```

Then open http://localhost:5173. The Vite dev server proxies `/stream`, `/world`,
`/metrics` and `/healthz` to the Go server.

To push the system harder:

```sh
make dev RAIL_FLAGS="--trains 500 --rate 10000"
```

## Common tasks

| Command      | What it does                                          |
|--------------|-------------------------------------------------------|
| `make dev`   | Server and client together, Ctrl-C stops both          |
| `make build` | Builds `apps/server/bin/railsim` and the client bundle |
| `make test`  | `go test ./...` and `pnpm -r test`                     |
| `make lint`  | `go vet`, `gofmt -l`, ESLint and Prettier              |
| `make bench` | Drives the server with the load client                 |
| `make fmt`   | Formats Go and TypeScript in place                     |

## Server configuration

Every flag is also readable from an environment variable with a `RAIL_` prefix
(`--emit-tick` becomes `RAIL_EMIT_TICK`); an explicitly passed flag wins over the
environment. See spec §3 for the full table.

```sh
cd apps/server && go run ./cmd/railsim --help
```
