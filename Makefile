# Rail Tracker — see docs/SPEC.md
SHELL := /bin/bash
SERVER := apps/server
CLIENT := apps/client
GO ?= go
PNPM ?= pnpm

# Flags used by `make dev` and `make bench`; override on the command line, e.g.
#   make dev RAIL_FLAGS="--trains 500 --rate 10000"
RAIL_FLAGS ?=
BENCH_FLAGS ?= -conns 8 -rate 1000 -duration 10s

.PHONY: all install dev dev-server dev-client build build-server build-client \
        test test-go test-ts lint lint-go lint-ts fmt bench clean

all: lint test build

install:
	$(PNPM) install

## dev: run the server and the client together; Ctrl-C stops both.
dev:
	@echo ">> starting railsim + vite (Ctrl-C to stop)"
	@trap 'kill 0' INT TERM EXIT; \
	$(MAKE) --no-print-directory dev-server & \
	$(MAKE) --no-print-directory dev-client & \
	wait

dev-server:
	cd $(SERVER) && $(GO) run ./cmd/railsim $(RAIL_FLAGS)

dev-client:
	$(PNPM) --filter @rail-tracker/client dev

## build: compile the server binary and bundle the client.
build: build-server build-client

build-server:
	cd $(SERVER) && $(GO) build -o bin/railsim ./cmd/railsim

build-client:
	$(PNPM) --filter @rail-tracker/client build

## test: Go tests plus every workspace package's tests.
test: test-go test-ts

test-go:
	cd $(SERVER) && $(GO) test ./...

test-ts:
	$(PNPM) -r test

## lint: go vet + gofmt check + eslint/prettier.
lint: lint-go lint-ts

lint-go:
	cd $(SERVER) && $(GO) vet ./...
	@out="$$(cd $(SERVER) && gofmt -l .)"; \
	if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi

lint-ts:
	$(PNPM) -r lint

fmt:
	cd $(SERVER) && gofmt -w .
	$(PNPM) --filter @rail-tracker/client format

## bench: drive the server with the load client and report throughput.
## Placeholder until cmd/loadclient lands in phase 4.
bench:
	@if [ -d "$(SERVER)/cmd/loadclient" ]; then \
	  cd $(SERVER) && $(GO) run ./cmd/loadclient $(BENCH_FLAGS); \
	else \
	  echo "bench: cmd/loadclient not built yet (phase 4)"; \
	fi

clean:
	rm -rf $(SERVER)/bin $(CLIENT)/dist
