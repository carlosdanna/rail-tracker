/**
 * Canvas rendering.
 *
 * Two layers: the static one holds reconstructed lines and stations and is
 * redrawn only when the reconstruction changes, and the dynamic one holds the
 * trains and is redrawn every frame. At 500 trains the static layer is by far
 * the more expensive of the two, so not repainting it is what keeps the frame
 * budget.
 */
import { reckon } from "./deadreckon";
import { COLORS, lineColor } from "./palette";
import { resizeCanvas, sameViewport, toScreenX, toScreenY } from "./viewport";
import type { Viewport, WorldBounds } from "./viewport";
import type { Store, Train } from "../store/store";
import type { InferredLine } from "../infer/lines";
import type { InferredStation } from "../infer/stations";
import type { Point } from "../infer/geometry";

/** The ground truth from /world, drawn by the comparison overlay. */
export interface TruthOverlay {
  stations: { x: number; y: number }[];
  lines: { kind: "loop" | "shuttle"; track: Point[] }[];
}

export interface RenderOptions {
  /** Draw per-train trails. */
  showTrails?: boolean;
  /** Draw the /world overlay on top. */
  showTruth?: boolean;
  /** Extrapolation horizon in ms. */
  horizonMs?: number;
}

/** What the renderer needs for one frame. */
export interface Scene {
  bounds: WorldBounds;
  lines: readonly InferredLine[];
  stations: readonly InferredStation[];
  /** Bumped by the caller whenever lines or stations change. */
  staticVersion: number;
  truth: TruthOverlay | null;
}

export class Renderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  /** Offscreen layer for lines and stations. */
  readonly #static: HTMLCanvasElement;
  readonly #staticCtx: CanvasRenderingContext2D;

  /** Line id to palette index, kept in step with the inference. */
  readonly #lineIndex = new Map<string, number>();

  #viewport: Viewport;
  #staticVersion = -1;
  #staticTruth = false;
  #options: Required<RenderOptions> = {
    showTrails: true,
    showTruth: false,
    horizonMs: 250,
  };

  constructor(canvas: HTMLCanvasElement, bounds: WorldBounds) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (ctx === null) throw new Error("2d canvas context is unavailable");
    this.#canvas = canvas;
    this.#ctx = ctx;

    this.#static = document.createElement("canvas");
    const staticCtx = this.#static.getContext("2d");
    if (staticCtx === null) throw new Error("offscreen 2d context is unavailable");
    this.#staticCtx = staticCtx;

    this.#viewport = resizeCanvas(
      canvas,
      bounds,
      canvas.clientWidth || 800,
      canvas.clientHeight || 600,
      devicePixelRatio || 1,
    );
  }

  get viewport(): Viewport {
    return this.#viewport;
  }

  setOptions(options: RenderOptions): void {
    this.#options = { ...this.#options, ...options };
    // The truth overlay lives on the static layer, so toggling it invalidates.
    if (options.showTruth !== undefined && options.showTruth !== this.#staticTruth) {
      this.#staticVersion = -1;
    }
  }

  /** Re-fits the canvas to its container; invalidates the static layer. */
  resize(bounds: WorldBounds, cssWidth: number, cssHeight: number, dpr: number): void {
    const next = resizeCanvas(this.#canvas, bounds, cssWidth, cssHeight, dpr);
    if (!sameViewport(this.#viewport, next)) {
      this.#viewport = next;
      this.#staticVersion = -1;
    }
  }

  /** Draws one frame. `now` is the client clock in ms. */
  draw(store: Store, scene: Scene, now: number): void {
    const v = this.#viewport;
    const ctx = this.#ctx;

    if (this.#staticVersion !== scene.staticVersion) {
      this.#redrawStatic(scene);
      this.#staticVersion = scene.staticVersion;
    }

    ctx.save();
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, v.width, v.height);

    // Static layer is already at device resolution; blit it 1:1.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.#static, 0, 0);
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);

    if (this.#options.showTrails) this.#drawTrails(ctx, store);
    this.#drawTrains(ctx, store, now);

    ctx.restore();
  }

  /** Repaints lines, stations and the optional truth overlay. */
  #redrawStatic(scene: Scene): void {
    const v = this.#viewport;
    const canvas = this.#static;
    const w = Math.max(1, Math.round(v.width * v.dpr));
    const h = Math.max(1, Math.round(v.height * v.dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = this.#staticCtx;
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    ctx.clearRect(0, 0, v.width, v.height);

    this.#drawFrame(ctx, scene.bounds);

    for (const line of scene.lines) {
      ctx.strokeStyle = lineColor(line.colorIndex);
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      this.#strokePath(ctx, line.points, line.kind === "loop");
    }

    for (const station of scene.stations) {
      const x = toScreenX(v, station.x);
      const y = toScreenY(v, station.y);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.station;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.stationRing;
      ctx.stroke();
    }

    this.#staticTruth = this.#options.showTruth;
    if (this.#options.showTruth && scene.truth !== null) {
      this.#drawTruth(ctx, scene.truth);
    }
  }

  /** The world's outer rectangle, so the empty canvas still reads as a map. */
  #drawFrame(ctx: CanvasRenderingContext2D, bounds: WorldBounds): void {
    const v = this.#viewport;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      toScreenX(v, 0) + 0.5,
      toScreenY(v, 0) + 0.5,
      bounds.w * v.scale,
      bounds.h * v.scale,
    );
  }

  /** Ground truth in a contrasting dashed style, for the comparison toggle. */
  #drawTruth(ctx: CanvasRenderingContext2D, truth: TruthOverlay): void {
    const v = this.#viewport;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = COLORS.truthLine;
    ctx.lineWidth = 1.5;
    for (const line of truth.lines) {
      this.#strokePath(ctx, line.track, line.kind === "loop");
    }
    ctx.setLineDash([]);

    ctx.strokeStyle = COLORS.truthStation;
    ctx.lineWidth = 1.5;
    for (const s of truth.stations) {
      const x = toScreenX(v, s.x);
      const y = toScreenY(v, s.y);
      ctx.beginPath();
      ctx.moveTo(x - 6, y - 6);
      ctx.lineTo(x + 6, y + 6);
      ctx.moveTo(x + 6, y - 6);
      ctx.lineTo(x - 6, y + 6);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** One path for all trails, so the whole set costs a single stroke. */
  #drawTrails(ctx: CanvasRenderingContext2D, store: Store): void {
    const v = this.#viewport;
    ctx.strokeStyle = COLORS.trail;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const id of store.trails.ids()) {
      const points = store.trail(id);
      if (points.length < 2) continue;
      const first = points[0];
      if (first === undefined) continue;
      ctx.moveTo(toScreenX(v, first.x), toScreenY(v, first.y));
      for (let i = 1; i < points.length; i++) {
        const p = points[i];
        if (p !== undefined) ctx.lineTo(toScreenX(v, p.x), toScreenY(v, p.y));
      }
    }
    ctx.stroke();
  }

  /**
   * Trains, grouped by colour so the whole fleet costs one path per line rather
   * than one per train.
   */
  #drawTrains(ctx: CanvasRenderingContext2D, store: Store, now: number): void {
    const byColor = new Map<string, Train[]>();
    for (const train of store.trains()) {
      const color = this.#colorFor(train.lineId);
      let group = byColor.get(color);
      if (group === undefined) {
        group = [];
        byColor.set(color, group);
      }
      group.push(train);
    }

    const v = this.#viewport;
    const horizonMs = this.#options.horizonMs;
    for (const [color, group] of byColor) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const train of group) {
        const at = reckon(train, now, { horizonMs });
        const x = toScreenX(v, at.x);
        const y = toScreenY(v, at.y);
        // A short triangle pointing along the heading. 0 = north = −Y.
        const rad = (train.heading * Math.PI) / 180;
        const dx = Math.sin(rad);
        const dy = -Math.cos(rad);
        const nose = 6;
        const tail = 4;
        ctx.moveTo(x + dx * nose, y + dy * nose);
        ctx.lineTo(x - dx * tail + dy * tail, y - dy * tail - dx * tail);
        ctx.lineTo(x - dx * tail - dy * tail, y - dy * tail + dx * tail);
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  /** The colour for a train, grey until its line has been reconstructed. */
  #colorFor(lineId: string | null): string {
    if (lineId === null) return COLORS.unknownTrain;
    const index = this.#lineIndex.get(lineId);
    return index === undefined ? COLORS.unknownTrain : lineColor(index);
  }

  /** Tells the renderer which palette index each inferred line uses. */
  setLineColors(lines: readonly InferredLine[]): void {
    this.#lineIndex.clear();
    for (const line of lines) this.#lineIndex.set(line.id, line.colorIndex);
  }

  #strokePath(ctx: CanvasRenderingContext2D, points: readonly Point[], closed: boolean): void {
    if (points.length < 2) return;
    const v = this.#viewport;
    const first = points[0];
    if (first === undefined) return;

    ctx.beginPath();
    ctx.moveTo(toScreenX(v, first.x), toScreenY(v, first.y));
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      if (p !== undefined) ctx.lineTo(toScreenX(v, p.x), toScreenY(v, p.y));
    }
    if (closed) ctx.closePath();
    ctx.stroke();
  }
}
