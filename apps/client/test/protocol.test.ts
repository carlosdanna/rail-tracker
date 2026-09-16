import { describe, expect, it } from "vitest";
import {
  HEADER_SIZE,
  RECORD_SIZE,
  compassOf,
  parseBinaryBatch,
  parseHello,
  parseJsonBatch,
  trainIndex,
  ProtocolError,
} from "../src/protocol";
import type { TrainUpdate } from "../src/protocol";
import { readBinary, readText } from "./fixtures";

/**
 * How far apart the two formats may legitimately be for the same value.
 *
 * JSON rounds x, y and speed to three decimals, which costs up to 5e-4. The
 * binary format stores them as f32, which costs about 1.2e-7 of the magnitude.
 * Heading is exempt: both sides quantise to a tenth of a degree, so it matches
 * exactly.
 */
function tolerance(value: number): number {
  return 5e-4 + Math.abs(value) * 1.2e-7;
}

function expectSameUpdates(a: TrainUpdate[], b: TrainUpdate[]): void {
  expect(a).toHaveLength(b.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    expect(x, `update ${i}`).toBeDefined();
    expect(y, `update ${i}`).toBeDefined();
    if (x === undefined || y === undefined) return;

    expect(x.seq, `update ${i} seq`).toBe(y.seq);
    expect(x.id, `update ${i} id`).toBe(y.id);
    expect(x.index, `update ${i} index`).toBe(y.index);
    expect(x.state, `update ${i} state`).toBe(y.state);
    expect(x.heading, `update ${i} heading`).toBe(y.heading);
    expect(Math.abs(x.x - y.x), `update ${i} x`).toBeLessThanOrEqual(tolerance(y.x));
    expect(Math.abs(x.y - y.y), `update ${i} y`).toBeLessThanOrEqual(tolerance(y.y));
    expect(Math.abs(x.speed - y.speed), `update ${i} speed`).toBeLessThanOrEqual(
      tolerance(y.speed),
    );
  }
}

describe("hello", () => {
  it("parses the golden hello frame", () => {
    const hello = parseHello(JSON.parse(readText("hello.json")));
    expect(hello).toEqual({
      type: "hello",
      version: 1,
      bounds: { w: 1000, h: 1000 },
      trainCount: 12,
      rate: 10000,
      format: "json",
      hideState: false,
    });
  });

  it("rejects a frame that is not a hello", () => {
    expect(() => parseHello({ type: "batch" })).toThrow(ProtocolError);
    expect(() => parseHello(null)).toThrow(ProtocolError);
    expect(() => parseHello({ type: "hello", version: 1 })).toThrow(ProtocolError);
  });
});

describe("cross-language contract", () => {
  it("decodes batch.json and batch.bin to identical updates", () => {
    const fromJson = parseJsonBatch(readText("batch.json"));
    const fromBin = parseBinaryBatch(readBinary("batch.bin"));

    expect(fromJson.t).toBe(fromBin.t);
    expect(fromJson.updates).toHaveLength(8);
    expectSameUpdates(fromJson.updates, fromBin.updates);
  });

  it("decodes the hide-state fixtures to identical updates", () => {
    const fromJson = parseJsonBatch(readText("batch-hidden.json"));
    const fromBin = parseBinaryBatch(readBinary("batch-hidden.bin"));

    expectSameUpdates(fromJson.updates, fromBin.updates);
    // Neither format reveals the state.
    for (const u of fromJson.updates) expect(u.state).toBe("unknown");
    for (const u of fromBin.updates) expect(u.state).toBe("unknown");
  });

  it("agrees with the visible-state fixtures on train identity", () => {
    const visible = parseJsonBatch(readText("batch.json"));
    const hidden = parseJsonBatch(readText("batch-hidden.json"));
    expect(hidden.updates.map((u) => u.id)).toEqual(visible.updates.map((u) => u.id));
    expect(visible.updates.some((u) => u.state !== "unknown")).toBe(true);
  });

  it("sizes the binary fixture exactly as the layout requires", () => {
    const buf = readBinary("batch.bin");
    const view = new DataView(buf);
    expect(view.getUint8(0)).toBe(1); // version
    expect(view.getUint8(1)).toBe(1); // frame type = batch
    const count = view.getUint16(2, true);
    expect(count).toBe(8);
    expect(buf.byteLength).toBe(HEADER_SIZE + count * RECORD_SIZE);
  });
});

describe("binary parsing", () => {
  it("rejects a truncated frame", () => {
    expect(() => parseBinaryBatch(new ArrayBuffer(4))).toThrow(/at least 12/);
  });

  it("rejects a record count the frame cannot hold", () => {
    const buf = new ArrayBuffer(HEADER_SIZE);
    const view = new DataView(buf);
    view.setUint8(0, 1);
    view.setUint8(1, 1);
    view.setUint16(2, 5, true);
    expect(() => parseBinaryBatch(buf)).toThrow(/need 117/);
  });

  it("rejects an unknown version or frame type", () => {
    const make = (version: number, frameType: number): ArrayBuffer => {
      const buf = new ArrayBuffer(HEADER_SIZE);
      const view = new DataView(buf);
      view.setUint8(0, version);
      view.setUint8(1, frameType);
      return buf;
    };
    expect(() => parseBinaryBatch(make(2, 1))).toThrow(/version 2/);
    expect(() => parseBinaryBatch(make(1, 9))).toThrow(/frame type 9/);
  });

  it("reads a view into a larger buffer", () => {
    const original = readBinary("batch.bin");
    const padded = new ArrayBuffer(original.byteLength + 16);
    new Uint8Array(padded).set(new Uint8Array(original), 8);

    const direct = parseBinaryBatch(original);
    const offset = parseBinaryBatch(padded, 8, original.byteLength);
    expect(offset.updates).toEqual(direct.updates);
  });
});

describe("json parsing", () => {
  it("rejects malformed frames", () => {
    expect(() => parseJsonBatch(`{"type":"nope"}`)).toThrow(ProtocolError);
    expect(() => parseJsonBatch(`{"type":"batch","t":1}`)).toThrow(/updates must be an array/);
    expect(() => parseJsonBatch(`{"type":"batch","t":"soon","updates":[]}`)).toThrow(
      /t must be a finite number/,
    );
    expect(() =>
      parseJsonBatch(`{"type":"batch","t":1,"updates":[{"seq":1,"train":"T-1","x":1,"y":1,
        "heading":0,"speed":0,"state":"exploded"}]}`),
    ).toThrow(/unknown state/);
  });

  it("treats a missing state as unknown", () => {
    const b = parseJsonBatch(
      `{"type":"batch","t":1,"updates":[{"seq":1,"train":"T-1","x":1,"y":2,"heading":3,"speed":4}]}`,
    );
    expect(b.updates[0]?.state).toBe("unknown");
    expect(b.updates[0]?.index).toBe(1);
  });
});

describe("helpers", () => {
  it("maps headings to compass points", () => {
    expect(compassOf(0)).toBe("N");
    expect(compassOf(22)).toBe("N");
    expect(compassOf(23)).toBe("NE");
    expect(compassOf(90)).toBe("E");
    expect(compassOf(180)).toBe("S");
    expect(compassOf(270)).toBe("W");
    expect(compassOf(359)).toBe("N");
    expect(compassOf(-45)).toBe("NW");
    expect(compassOf(720)).toBe("N");
  });

  it("extracts train indices", () => {
    expect(trainIndex("T-0")).toBe(0);
    expect(trainIndex("T-17")).toBe(17);
    expect(trainIndex("X-1")).toBe(-1);
    expect(trainIndex("T-abc")).toBe(-1);
    expect(trainIndex("T--1")).toBe(-1);
  });
});
