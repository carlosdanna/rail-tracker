/**
 * Wires everything together: the worker feeds the store, the store feeds the
 * inference and the renderer, and the HUD drives the controls.
 *
 * The render loop is deliberately independent of the ingest rate. Each frame it
 * asks the worker for whatever has arrived, applies it, and draws; the server
 * can be sending ten updates a second or ten thousand and the loop does not
 * change.
 */
import { trainId } from "./protocol";
import type { Hello } from "./protocol";
import { WorkerClient } from "./net/workerclient";
import { Store } from "./store/store";
import { LineInference } from "./infer/lines";
import { StationInference } from "./infer/stations";
import { Renderer } from "./render/renderer";
import type { Scene, TruthOverlay } from "./render/renderer";
import { Hud } from "./hud/hud";
import { stateFromCode } from "./worker/ingest";
import type { IngestStats } from "./worker/ingest";
import type { UpdateArrays } from "./worker/arrays";

/** Query parameters the client itself understands. */
export interface AppOptions {
  /** Starting rate; also what the HUD input shows. */
  rate: number;
  format: "json" | "bin";
  /** Log FPS and memory every 10 s, for the performance runs. */
  perf: boolean;
}

/** Reads the client's own options off the page URL. */
export function optionsFromSearch(search: string): AppOptions {
  const params = new URLSearchParams(search);
  const rate = Number(params.get("rate") ?? "2000");
  const format = params.get("format") === "bin" ? "bin" : "json";
  return {
    rate: Number.isFinite(rate) && rate >= 0 ? Math.round(rate) : 2000,
    format,
    perf: params.has("perf"),
  };
}

/** Builds the `/stream` URL for the current options. */
export function streamUrl(location: Location, options: AppOptions): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/stream?rate=${options.rate}&format=${options.format}`;
}

export class App {
  readonly #store = new Store();
  readonly #lines = new LineInference();
  readonly #stations = new StationInference();
  readonly #renderer: Renderer;
  readonly #hud: Hud;
  readonly #client: WorkerClient;
  readonly #canvas: HTMLCanvasElement;

  #options: AppOptions;
  #staticVersion = 0;
  #truth: TruthOverlay | null = null;
  #connection = "connecting";
  #showTruth = false;
  #frame = 0;
  #perfTimer: ReturnType<typeof setInterval> | null = null;

  constructor(root: HTMLElement, worker: Worker, options: AppOptions) {
    this.#options = options;

    this.#canvas = document.createElement("canvas");
    this.#canvas.id = "stage";
    root.append(this.#canvas);

    const hudRoot = document.createElement("div");
    root.append(hudRoot);

    this.#renderer = new Renderer(this.#canvas, this.#store.bounds);
    this.#client = new WorkerClient(worker);

    this.#hud = new Hud(
      hudRoot,
      { rate: options.rate, format: options.format, trails: true, truth: false },
      {
        onRateChange: (rate) => this.setRate(rate),
        onFormatChange: (format) => this.setFormat(format),
        onTrailsToggle: (show) => {
          this.#renderer.setOptions({ showTrails: show });
        },
        onTruthToggle: (show) => {
          void this.setTruth(show);
        },
      },
    );

    this.#client.on("hello", (hello) => this.#onHello(hello));
    this.#client.on("batch", (batch) => this.#onBatch(batch));
    this.#client.on("status", ({ state }) => {
      this.#connection = state;
    });
    this.#client.on("latency", ({ ms }) => this.#store.stats.recordLatency(ms));
    this.#client.on("error", ({ message }) => {
      console.warn("stream error:", message);
    });
  }

  /** Connects and starts the render loop. */
  start(): void {
    this.#resize();
    window.addEventListener("resize", () => this.#resize());

    this.#client.connect(streamUrl(window.location, this.#options));
    this.#client.startPings();

    if (this.#options.perf) this.#startPerfLog();

    const loop = (): void => {
      this.#frame = requestAnimationFrame(loop);
      this.#client.flush();
      this.#tick();
    };
    this.#frame = requestAnimationFrame(loop);
  }

  /** Stops everything; used by tests and hot reload. */
  stop(): void {
    cancelAnimationFrame(this.#frame);
    if (this.#perfTimer !== null) clearInterval(this.#perfTimer);
    this.#client.terminate();
  }

  /** Changes the rate in place, without reconnecting. */
  setRate(rate: number): void {
    this.#options = { ...this.#options, rate };
    this.#client.setRate(rate);
  }

  /** Changing the wire format needs a new connection. */
  setFormat(format: "json" | "bin"): void {
    if (format === this.#options.format) return;
    this.#options = { ...this.#options, format };
    this.#client.connect(streamUrl(window.location, this.#options));
  }

  /** Fetches /world the first time the overlay is switched on. */
  async setTruth(show: boolean): Promise<void> {
    this.#showTruth = show;
    if (show && this.#truth === null) {
      try {
        this.#truth = await fetchTruth();
      } catch (err) {
        console.warn("could not load /world:", err);
        this.#truth = null;
      }
    }
    this.#staticVersion += 1;
    this.#renderer.setOptions({ showTruth: show });
  }

  #onHello(hello: Hello): void {
    this.#store.bounds = { w: hello.bounds.w, h: hello.bounds.h };
    this.#store.hideState = hello.hideState;
    this.#connection = "open";
    this.#resize();
  }

  #onBatch(batch: { arrays: UpdateArrays; count: number; t: number; stats: IngestStats }): void {
    const now = performance.now();
    const before = this.#store.stats.snapshot(now).totalUpdates;

    this.#store.applyArrays(batch.arrays, batch.count, now);
    this.#store.stats.recordIngest(
      Math.max(0, batch.stats.updates - before),
      0,
      { dropped: batch.stats.dropped, gaps: batch.stats.gaps, updates: batch.stats.updates },
      now,
    );

    // Feed the inference from the same arrays before giving them back.
    let changed = false;
    for (let i = 0; i < batch.count; i++) {
      const index = batch.arrays.index[i] ?? 0;
      const id = trainId(index);
      const x = batch.arrays.x[i] ?? 0;
      const y = batch.arrays.y[i] ?? 0;
      const heading = batch.arrays.heading[i] ?? 0;
      const speed = batch.arrays.speed[i] ?? 0;
      const state = stateFromCode(batch.arrays.state[i] ?? 255);

      const lineId = this.#lines.observe(id, x, y, heading, speed);
      if (lineId !== null) {
        this.#store.assignLine(id, lineId);
        changed = true;
      }
      if (this.#stations.observe(id, x, y, speed, state)) changed = true;
    }

    if (changed) {
      this.#renderer.setLineColors(this.#lines.lines);
      this.#staticVersion += 1;
    }

    this.#client.recycle(batch.arrays);
  }

  /** One frame: draw, then refresh the HUD. */
  #tick(): void {
    const now = performance.now();
    this.#store.stats.recordFrame(now);

    const scene: Scene = {
      bounds: this.#store.bounds,
      lines: this.#lines.lines,
      stations: this.#stations.stations(),
      staticVersion: this.#staticVersion,
      truth: this.#showTruth ? this.#truth : null,
    };
    this.#renderer.draw(this.#store, scene, now);

    const stats = this.#store.stats.snapshot(now);
    this.#hud.update({
      ...stats,
      inferredLines: this.#lines.lines.length,
      inferredStations: scene.stations.length,
      connection: this.#connection,
      trailPoints: this.#store.trails.totalPoints(),
    });
  }

  #resize(): void {
    const rect = this.#canvas.getBoundingClientRect();
    this.#renderer.resize(
      this.#store.bounds,
      rect.width || window.innerWidth,
      rect.height || window.innerHeight,
      window.devicePixelRatio || 1,
    );
    this.#staticVersion += 1;
  }

  /** `?perf` mode: a line every 10 s with FPS and, where available, memory. */
  #startPerfLog(): void {
    this.#perfTimer = setInterval(() => {
      const stats = this.#store.stats.snapshot();
      const mem = memoryUsage();
      console.log(
        `[perf] fps=${stats.fps} msgs/sec=${stats.msgsPerSec} trains=${stats.trains} ` +
          `dropped=${stats.dropped} trailPts=${this.#store.trails.totalPoints()}` +
          (mem === null ? "" : ` heapMiB=${(mem / (1024 * 1024)).toFixed(1)}`),
      );
    }, 10_000);
  }
}

/** Chrome-only heap size, in bytes, or null where it is unavailable. */
export function memoryUsage(): number | null {
  const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
  const used = perf.memory?.usedJSHeapSize;
  return typeof used === "number" ? used : null;
}

/** Loads the ground truth for the comparison overlay. */
async function fetchTruth(): Promise<TruthOverlay> {
  const res = await fetch("/world");
  if (!res.ok) throw new Error(`/world returned ${res.status}`);
  const body = (await res.json()) as {
    stations?: { x: number; y: number }[];
    lines?: { kind?: string; track?: { x: number; y: number }[] }[];
  };
  return {
    stations: body.stations ?? [],
    lines: (body.lines ?? []).map((l) => ({
      kind: l.kind === "loop" ? "loop" : "shuttle",
      track: l.track ?? [],
    })),
  };
}
