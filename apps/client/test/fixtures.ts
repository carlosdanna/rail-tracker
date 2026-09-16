/**
 * Loads the golden frames in `protocol/fixtures`, which the Go encoder tests
 * assert against byte for byte. Both suites reading the same files is what
 * makes them a cross-language contract.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, "..", "..", "..", "protocol", "fixtures");

/** Reads a fixture as UTF-8 text. */
export function readText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

/** Reads a fixture as a standalone ArrayBuffer. */
export function readBinary(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIXTURE_DIR, name));
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}
