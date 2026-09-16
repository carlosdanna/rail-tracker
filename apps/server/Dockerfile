# Build the server, then ship only the binary.
#
# The build context is the repository root, so that the client bundle can be
# copied in for the single-container deployment:
#   docker build -f apps/server/Dockerfile -t rail-tracker .
FROM golang:1.26-alpine AS build
WORKDIR /src

# Dependencies first, so a source-only change does not re-download them.
COPY apps/server/go.mod apps/server/go.sum ./
RUN go mod download

COPY apps/server/ ./
# CGO off keeps the binary static, so it runs on a scratch image.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/railsim ./cmd/railsim

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/railsim /railsim
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/railsim"]
# Flags are also readable as RAIL_* environment variables; see docs/SPEC.md §3.
CMD ["--addr", ":8080"]
