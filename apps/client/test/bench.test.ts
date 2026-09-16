/**
 * Client ingest benchmark.
 *
 * Spec §5.1 asks for ~60 FPS and flat memory at 10,000 updates/sec with 500
 * trains. The frame rate itself needs a browser, but everything that competes
 * with it for CPU — decoding frames, coalescing, applying to the store and
 * feeding the inference — runs here, so this measures how much of a 16.7 ms
 * frame budget the data path actually costs, and whether it holds steady.
 *
 *   RAIL_BENCH=1 npx vitest run bench
 *   RAIL_BENCH=1 RAIL_BENCH_SECONDS=600 NODE_OPTIONS=--expose-gc npx vitest run bench
 */
import { describe, expect, it } from "vitest";
import { HEADER_SIZE, RECORD_SIZE, parseBinaryBatch, parseJsonBatch } from "../src/protocol";
import { Ingest } from "../src/worker/ingest";
import { Store } from "../src/store/store";
import { LineInference } from "../src/infer/lines";
import { StationInference } from "../src/infer/stations";
import { line, simulate } from "./synthsim";
import type { TrainUpdate } from "../src/protocol";

const ENABLED = process.env["RAIL_BENCH"] === "1";
const SECONDS = Number(process.env["RAIL_BENCH_SECONDS"] ?? "60");

/** Spec §5.1 conditions. */
const TRAINS = 500;
const RATE = 10_000;
const EMIT_TICK_MS = 20;
const FRAME_MS = 1000 / 60;
const RECORDS_PER_FRAME = Math.round((RATE * EMIT_TICK_MS) / 1000);

/** Starting offsets are spread over this many samples; see Fleet. */
const PHASE_WINDOW = 1000;

/**
 * Six lines of varied shape, the way a generated world looks. The streams are
 * rolled out far enough that no train reaches the end of one during the run.
 */
function buildLines(seconds: number): TrainUpdate[][] {
  const shapes = [
    line("loop", [
      { x: 120, y: 120 },
      { x: 520, y: 140 },
      { x: 540, y: 460 },
      { x: 150, y: 430 },
    ]),
    line("loop", [
      { x: 600, y: 100 },
      { x: 900, y: 200 },
      { x: 850, y: 500 },
      { x: 620, y: 420 },
    ]),
    line("loop", [
      { x: 100, y: 600 },
      { x: 400, y: 620 },
      { x: 380, y: 900 },
      { x: 120, y: 880 },
    ]),
    line("shuttle", [
      { x: 500, y: 700 },
      { x: 700, y: 750 },
      { x: 900, y: 700 },
    ]),
    line(
      "loop",
      [
        { x: 200, y: 300 },
        { x: 700, y: 320 },
        { x: 680, y: 700 },
        { x: 220, y: 680 },
      ],
      [2, 2, 2, 2],
    ),
    line("shuttle", [
      { x: 100, y: 100 },
      { x: 700, y: 500 },
      { x: 120, y: 160 },
    ]),
  ];

  // 50 ms per sample is exactly the per-train update interval at 500 trains and
  // 10,000 updates/sec, so a train advances one sample per update.
  const duration = seconds + PHASE_WINDOW * 0.05 + 10;
  return shapes.map((shape) =>
    simulate({ line: shape, duration, speed: 35, dwell: 3, interval: 0.05 }),
  );
}

/** A fleet that reads positions out of the pre-rolled per-line streams. */
class Fleet {
  readonly #streams: TrainUpdate[][];
  readonly #lineOf: number[] = [];
  readonly #phase: number[] = [];
  #step = 0;
  #seq = 1;
  #cursor = 0;

  constructor(streams: TrainUpdate[][], trains: number) {
    this.#streams = streams;
    // Phases are spread over the first part of each stream only. A train that
    // ran off the end would wrap round to the start and appear to teleport,
    // which is not something a real server does and would corrupt the
    // reconstruction this benchmark also reports on.
    for (let i = 0; i < trains; i++) {
      const l = i % streams.length;
      const stream = streams[l];
      this.#lineOf.push(l);
      this.#phase.push(stream === undefined ? 0 : (i * 37) % PHASE_WINDOW);
    }
  }

  /** Highest sample index any train has reached, to check for wrap-around. */
  get reach(): number {
    return PHASE_WINDOW + this.#step;
  }

  /** Builds one binary frame, round-robinning through the fleet like the server. */
  frame(records: number): ArrayBuffer {
    const buf = new ArrayBuffer(HEADER_SIZE + records * RECORD_SIZE);
    const view = new DataView(buf);
    view.setUint8(0, 1);
    view.setUint8(1, 1);
    view.setUint16(2, records, true);
    view.setFloat64(4, Date.now(), true);

    for (let i = 0; i < records; i++) {
      const train = this.#cursor;
      this.#cursor = (this.#cursor + 1) % this.#lineOf.length;
      if (this.#cursor === 0) this.#step++;

      const stream = this.#streams[this.#lineOf[train] ?? 0];
      const u = stream?.[((this.#phase[train] ?? 0) + this.#step) % (stream.length || 1)];
      const off = HEADER_SIZE + i * RECORD_SIZE;
      view.setUint16(off, train, true);
      view.setFloat32(off + 2, u?.x ?? 0, true);
      view.setFloat32(off + 6, u?.y ?? 0, true);
      view.setUint16(off + 10, Math.round((u?.heading ?? 0) * 10) % 3600, true);
      view.setFloat32(off + 12, u?.speed ?? 0, true);
      view.setUint8(off + 16, (u?.speed ?? 0) > 0 ? 0 : 1);
      view.setUint32(off + 17, this.#seq++, true);
    }
    return buf;
  }
}

function heapMiB(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function collectGarbage(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
}

describe.runIf(ENABLED)("client ingest benchmark", () => {
  it(
    `keeps up with ${String(RATE)} updates/sec and ${String(TRAINS)} trains`,
    () => {
      const streams = buildLines(SECONDS);
      const fleet = new Fleet(streams, TRAINS);

      const ingest = new Ingest();
      const store = new Store();
      const lines = new LineInference();
      const stations = new StationInference();

      const framesPerSecond = 1000 / EMIT_TICK_MS;
      const flushEvery = Math.round(FRAME_MS / EMIT_TICK_MS) || 1;

      let parseMs = 0;
      let applyMs = 0;
      let inferMs = 0;
      let linesMs = 0;
      let stationsMs = 0;
      let updates = 0;
      let flushes = 0;

      collectGarbage();
      const heapStart = heapMiB();
      const samples: { at: number; heap: number }[] = [];
      const started = performance.now();

      const totalFrames = Math.round(SECONDS * framesPerSecond);
      for (let f = 0; f < totalFrames; f++) {
        const raw = fleet.frame(RECORDS_PER_FRAME);

        let t0 = performance.now();
        ingest.add(parseBinaryBatch(raw), raw.byteLength);
        parseMs += performance.now() - t0;
        updates += RECORDS_PER_FRAME;

        if (f % flushEvery !== 0) continue;
        const drained = ingest.drain();
        if (drained === null) continue;
        flushes++;

        t0 = performance.now();
        store.applyArrays(drained.arrays, drained.count, f * EMIT_TICK_MS);
        applyMs += performance.now() - t0;

        t0 = performance.now();
        for (let i = 0; i < drained.count; i++) {
          const index = drained.arrays.index[i] ?? 0;
          const id = `T-${index}`;
          const x = drained.arrays.x[i] ?? 0;
          const y = drained.arrays.y[i] ?? 0;
          const heading = drained.arrays.heading[i] ?? 0;
          const speed = drained.arrays.speed[i] ?? 0;

          const l0 = performance.now();
          const lineId = lines.observe(id, x, y, heading, speed);
          linesMs += performance.now() - l0;
          if (lineId !== null) store.assignLine(id, lineId);

          const s0 = performance.now();
          stations.observe(id, x, y, speed, speed > 0 ? "running" : "at_station");
          stationsMs += performance.now() - s0;
        }
        inferMs += performance.now() - t0;

        // Hand the arrays back, exactly as the main thread does.
        ingest.recycle(drained.arrays);

        if (f % Math.round(framesPerSecond * 10) === 0) {
          samples.push({ at: f / framesPerSecond, heap: heapMiB() });
        }
      }

      const wallMs = performance.now() - started;
      collectGarbage();
      const heapEnd = heapMiB();

      const perFlushMs = (parseMs * flushEvery + applyMs + inferMs) / flushes;
      const budgetPct = (perFlushMs / FRAME_MS) * 100;

      // A wrap would make trains jump, so the reconstruction figures below
      // would stop meaning anything.
      const shortest = Math.min(...streams.map((s2) => s2.length));
      expect(fleet.reach).toBeLessThan(shortest);

      console.log(
        [
          `stream            ${String(SECONDS)} s at ${String(RATE)} updates/sec, ${String(TRAINS)} trains`,
          `updates           ${updates.toLocaleString()} in ${String(totalFrames)} frames`,
          `wall time         ${wallMs.toFixed(0)} ms for ${String(SECONDS)} s of stream ` +
            `(${((wallMs / (SECONDS * 1000)) * 100).toFixed(1)}% of real time)`,
          `parse             ${parseMs.toFixed(0)} ms total, ` +
            `${((parseMs / updates) * 1e6).toFixed(0)} ns/update`,
          `store apply       ${applyMs.toFixed(0)} ms total`,
          `inference         ${inferMs.toFixed(0)} ms total ` +
            `(lines ${linesMs.toFixed(0)} ms, stations ${stationsMs.toFixed(0)} ms, ` +
            `timer overhead included)`,
          `per frame         ${perFlushMs.toFixed(2)} ms (${budgetPct.toFixed(1)}% of a 16.7 ms budget)`,
          `heap              ${heapStart.toFixed(1)} -> ${heapEnd.toFixed(1)} MiB`,
          `lines/stations    ${String(lines.lines.length)} / ${String(stations.stations().length)}`,
          `trail points      ${String(store.trails.totalPoints())}`,
        ].join("\n"),
      );
      if (samples.length > 2) {
        console.log(
          "heap samples      " +
            samples.map((s) => `${String(s.at)}s:${s.heap.toFixed(0)}MiB`).join("  "),
        );
      }

      // The data path must leave the frame with time to spare.
      expect(perFlushMs).toBeLessThan(FRAME_MS);
      // And it must not be quietly accumulating: trails are capped and frozen,
      // so the heap should not grow with stream length.
      expect(heapEnd - heapStart).toBeLessThan(200);
    },
    Math.max(120, SECONDS * 4) * 1000,
  );

  it("decodes JSON frames fast enough to matter", () => {
    const streams = buildLines(30);
    const fleet = new Fleet(streams, TRAINS);
    const batch = parseBinaryBatch(fleet.frame(RECORDS_PER_FRAME));
    const text = JSON.stringify({
      type: "batch",
      t: Date.now(),
      updates: batch.updates.map((u) => ({
        seq: u.seq,
        train: u.id,
        x: u.x,
        y: u.y,
        heading: u.heading,
        speed: u.speed,
        state: u.state,
      })),
    });

    const iterations = 500;
    const started = performance.now();
    for (let i = 0; i < iterations; i++) parseJsonBatch(text);
    const perFrame = (performance.now() - started) / iterations;

    console.log(
      `json parse        ${perFrame.toFixed(3)} ms per ${String(RECORDS_PER_FRAME)}-record frame ` +
        `(${(perFrame * 50).toFixed(2)} ms/sec of stream), frame is ${String(text.length)} bytes`,
    );
    expect(perFrame).toBeLessThan(FRAME_MS);
  });
});
