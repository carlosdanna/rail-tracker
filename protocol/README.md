# Wire protocol

This directory is the shared contract between `apps/server` and `apps/client`.
The normative definition is [`docs/SPEC.md`](../docs/SPEC.md) §2; this file is the
byte-level summary, and `fixtures/` holds golden frames that **both** test suites
assert against.

Filled in during phase 3.

## Fixtures

| File | Contents |
|---|---|
| `fixtures/hello.json` | the `hello` frame |
| `fixtures/batch.json` | a `batch` frame in JSON |
| `fixtures/batch.bin` | the same batch in binary |

Regenerate with `cd apps/server && go test ./internal/encode -update`.
