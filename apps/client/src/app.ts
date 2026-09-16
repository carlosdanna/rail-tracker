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
import { lineOptionsFor, stationOptionsFor, trailOptionsFor, worldScale } from "./scale";
import { stateFromCode } from "./worker/ingest";
import type { IngestStats } from "./worker/ingest";
import type { UpdateArrays } from "./worker/arrays";

/** Query parameters the client itself understands. */
export interface AppOptions {
  /**
   * Updates/sec to ask for, or null to take whatever the server was started
   * with. Asking for a rate pins the connection against `POST /config`, so the
   * client only does it when the page was actually told to.
   */
  rate: number | null;
  format: "json" | "bin";
  /** Log FPS and memory every 10 s, for the performance runs. */
  perf: boolean;
}

/** Reads the client's own options off the page URL. */
export function optionsFromSearch(search: string): AppOptions {
  const params = new URLSearchParams(search);
  const raw = params.get("rate");
  const rate = raw === null ? Number.NaN : Number(raw);
  const format = params.get("format") === "bin" ? "bin" : "json";
  return {
    rate: Number.isFinite(rate) && rate >= 0 ? Math.round(rate) : null,
    format,
    perf: params.has("perf"),
  };
}

/** Builds the `/stream` URL for the current options. */
export function streamUrl(location: Location, options: AppOptions): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ format: options.format });
  // Leaving `rate` out is what lets the server's --rate through.
  if (options.rate !== null) query.set("rate", String(options.rate));
  return `${scheme}//${location.host}/stream?${query.toString()}`;
}

export class App {
  // Not readonly: the thresholds these are built with depend on how big the
  // world turns out to be, which the client only learns from `hello`.
  #store = new Store();
  #lines = new LineInference();
  #stations = new StationInference();
  #scale = 1;
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
      // Until hello arrives the real rate is whatever the server decided.
      { rate: options.rate ?? 0, format: options.format, trails: true, truth: false },
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
    const bounds = { w: hello.bounds.w, h: hello.bounds.h };
    const scale = worldScale(bounds);

    // A different world means every distance threshold is wrong and everything
    // gathered against the old ones is meaningless, so rebuild rather than
    // carry it over. An ordinary reconnect to the same world keeps its state.
    if (scale !== this.#scale || bounds.w !== this.#store.bounds.w) {
      this.#scale = scale;
      this.#store = new Store({ trail: trailOptionsFor(scale) });
      this.#lines = new LineInference(lineOptionsFor(scale));
      this.#stations = new StationInference(stationOptionsFor(scale));
      this.#renderer.setLineColors([]);
      this.#staticVersion += 1;
    }

    this.#store.bounds = bounds;
    this.#store.hideState = hello.hideState;
    this.#connection = "open";

    // The server states the rate it is actually sending at, which is the one
    // to show — the page may not have asked for any.
    this.#options = { ...this.#options, rate: hello.rate };
    this.#hud.setRate(hello.rate);

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
