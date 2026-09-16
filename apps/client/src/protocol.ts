/**
 * The wire contract shared with the Go server. See `protocol/README.md` for the
 * byte layout and `docs/SPEC.md` §2 for the normative definition.
 *
 * This module is the parsing boundary: everything that crosses it from the
 * network is `unknown` until it has been checked here.
 */

/** Binary header and record sizes, and the frame markers inside them. */
export const PROTOCOL_VERSION = 1;
export const FRAME_BATCH = 1;
export const HEADER_SIZE = 12;
export const RECORD_SIZE = 21;

/** Binary state codes. 255 means the server is running with `--hide-state`. */
export const STATE_RUNNING = 0;
export const STATE_AT_STATION = 1;
export const STATE_HIDDEN = 255;

/**
 * A train's reported state. `unknown` covers hide-state mode, where the client
 * has to infer stops from speed instead.
 */
export type TrainState = "running" | "at_station" | "unknown";

/** The eight compass points, in heading order starting at north. */
export const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type Compass = (typeof COMPASS_POINTS)[number];

/**
 * One train position, normalised so that JSON and binary frames produce exactly
 * the same shape.
 *
 * `compass` is deliberately absent: the binary format does not carry it, so it
 * is derived from `heading` where it is needed.
 */
export interface TrainUpdate {
  /** Monotonic per connection; gaps mean the server dropped updates. */
  seq: number;
  /** The `n` in `T-<n>`, which is what the binary format sends. */
  index: number;
  /** The full train id, `T-<index>`. */
  id: string;
  x: number;
  y: number;
  /** Degrees, 0 = north, increasing clockwise, quantised to 0.1°. */
  heading: number;
  speed: number;
  state: TrainState;
}

/** A decoded batch frame. */
export interface Batch {
  /** Server wall-clock milliseconds at emit. */
  t: number;
  updates: TrainUpdate[];
}

/** The hello frame that opens every connection. */
export interface Hello {
  type: "hello";
  version: number;
  bounds: { w: number; h: number };
  trainCount: number;
  rate: number;
  format: "json" | "bin";
  hideState: boolean;
}

/** The server's answer to a ping, used for latency. */
export interface Pong {
  type: "pong";
  id: number;
  t: number;
}

/** Raised when a frame does not match the protocol. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Maps a heading in degrees to the nearest compass point. */
export function compassOf(heading: number): Compass {
  const h = ((heading % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(h / 45) % 8] as Compass;
}

/** Builds the canonical train id for an index. */
export function trainId(index: number): string {
  return `T-${index}`;
}

/** Extracts the index from a `T-<n>` id, or -1 if it is not in that form. */
export function trainIndex(id: string): number {
  if (!id.startsWith("T-")) return -1;
  const n = Number(id.slice(2));
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

// --- the parsing boundary ---------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(source: Record<string, unknown>, key: string, where: string): number {
  const v = source[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ProtocolError(`${where}: ${key} must be a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

/** Normalises the JSON `state` field, which is absent in hide-state mode. */
function parseState(v: unknown, where: string): TrainState {
  if (v === undefined || v === null) return "unknown";
  if (v === "running" || v === "at_station") return v;
  throw new ProtocolError(`${where}: unknown state ${JSON.stringify(v)}`);
}

/** Parses an already-JSON-decoded value as a batch frame. */
export function parseBatchValue(value: unknown): Batch {
  if (!isRecord(value)) throw new ProtocolError("batch: frame is not an object");
  if (value["type"] !== "batch") {
    throw new ProtocolError(`batch: type is ${JSON.stringify(value["type"])}, want "batch"`);
  }
  const t = num(value, "t", "batch");

  const raw = value["updates"];
  if (!Array.isArray(raw)) throw new ProtocolError("batch: updates must be an array");

  const updates: TrainUpdate[] = new Array<TrainUpdate>(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const u: unknown = raw[i];
    const where = `batch.updates[${i}]`;
    if (!isRecord(u)) throw new ProtocolError(`${where}: not an object`);

    const id = u["train"];
    if (typeof id !== "string") throw new ProtocolError(`${where}: train must be a string`);

    updates[i] = {
      seq: num(u, "seq", where),
      index: trainIndex(id),
      id,
      x: num(u, "x", where),
      y: num(u, "y", where),
      heading: num(u, "heading", where),
      speed: num(u, "speed", where),
      state: parseState(u["state"], where),
    };
  }
  return { t, updates };
}

/** Parses a JSON batch frame. */
export function parseJsonBatch(text: string): Batch {
  return parseBatchValue(JSON.parse(text) as unknown);
}

/** Parses the hello frame. */
export function parseHello(value: unknown): Hello {
  if (!isRecord(value)) throw new ProtocolError("hello: frame is not an object");
  if (value["type"] !== "hello") {
    throw new ProtocolError(`hello: type is ${JSON.stringify(value["type"])}, want "hello"`);
  }
  const bounds = value["bounds"];
  if (!isRecord(bounds)) throw new ProtocolError("hello: bounds must be an object");

  const format = value["format"];
  if (format !== "json" && format !== "bin") {
    throw new ProtocolError(`hello: unknown format ${JSON.stringify(format)}`);
  }

  return {
    type: "hello",
    version: num(value, "version", "hello"),
    bounds: { w: num(bounds, "w", "hello.bounds"), h: num(bounds, "h", "hello.bounds") },
    trainCount: num(value, "trainCount", "hello"),
    rate: num(value, "rate", "hello"),
    format,
    hideState: value["hideState"] === true,
  };
}

/** Maps a binary state byte onto the normalised state. */
function stateFromByte(b: number, where: string): TrainState {
  switch (b) {
    case STATE_RUNNING:
      return "running";
    case STATE_AT_STATION:
      return "at_station";
    case STATE_HIDDEN:
      return "unknown";
    default:
      throw new ProtocolError(`${where}: unknown state byte ${b}`);
  }
}

/**
 * Parses a binary batch frame.
 *
 * `byteOffset` and `byteLength` let callers hand in a view into a larger
 * buffer; they default to the whole buffer.
 */
export function parseBinaryBatch(buffer: ArrayBuffer, byteOffset = 0, byteLength?: number): Batch {
  const length = byteLength ?? buffer.byteLength - byteOffset;
  if (length < HEADER_SIZE) {
    throw new ProtocolError(`binary: frame is ${length} bytes, need at least ${HEADER_SIZE}`);
  }

  const view = new DataView(buffer, byteOffset, length);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolError(`binary: version ${version}, want ${PROTOCOL_VERSION}`);
  }
  const frameType = view.getUint8(1);
  if (frameType !== FRAME_BATCH) {
    throw new ProtocolError(`binary: frame type ${frameType}, want ${FRAME_BATCH}`);
  }

  const count = view.getUint16(2, true);
  const t = view.getFloat64(4, true);

  const need = HEADER_SIZE + count * RECORD_SIZE;
  if (length < need) {
    throw new ProtocolError(`binary: frame is ${length} bytes, need ${need} for ${count} records`);
  }

  const updates: TrainUpdate[] = new Array<TrainUpdate>(count);
  for (let i = 0; i < count; i++) {
    const off = HEADER_SIZE + i * RECORD_SIZE;
    const index = view.getUint16(off, true);
    updates[i] = {
      seq: view.getUint32(off + 17, true),
      index,
      id: trainId(index),
      x: view.getFloat32(off + 2, true),
      y: view.getFloat32(off + 6, true),
      // Stored as tenths of a degree; divide back and keep one decimal.
      heading: view.getUint16(off + 10, true) / 10,
      speed: view.getFloat32(off + 12, true),
      state: stateFromByte(view.getUint8(off + 16), `binary.records[${i}]`),
    };
  }
  return { t, updates };
}
