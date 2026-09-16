/**
 * A canvas stand-in that records what was drawn.
 *
 * The renderer is pure geometry on top of the 2D API, so recording the calls is
 * enough to assert the things that actually matter: that the static layer is
 * repainted only when the reconstruction changes, that trains are batched into
 * one path per colour, and that positions land where the viewport says.
 */
export interface Call {
  op: string;
  args: unknown[];
}

export class FakeContext {
  readonly calls: Call[] = [];
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  lineJoin = "miter";
  lineCap = "butt";

  #record(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args });
  }

  save(): void {
    this.#record("save");
  }
  restore(): void {
    this.#record("restore");
  }
  setTransform(...a: number[]): void {
    this.#record("setTransform", ...a);
  }
  clearRect(...a: number[]): void {
    this.#record("clearRect", ...a);
  }
  fillRect(...a: number[]): void {
    this.#record("fillRect", ...a);
  }
  strokeRect(...a: number[]): void {
    this.#record("strokeRect", ...a);
  }
  beginPath(): void {
    this.#record("beginPath");
  }
  closePath(): void {
    this.#record("closePath");
  }
  moveTo(x: number, y: number): void {
    this.#record("moveTo", x, y);
  }
  lineTo(x: number, y: number): void {
    this.#record("lineTo", x, y);
  }
  arc(...a: number[]): void {
    this.#record("arc", ...a);
  }
  fill(): void {
    this.#record("fill", this.fillStyle);
  }
  stroke(): void {
    this.#record("stroke", this.strokeStyle);
  }
  drawImage(...a: unknown[]): void {
    this.#record("drawImage", ...a);
  }
  setLineDash(pattern: number[]): void {
    this.#record("setLineDash", pattern.length);
  }

  /** Calls matching an operation name. */
  ops(op: string): Call[] {
    return this.calls.filter((c) => c.op === op);
  }

  /** Forgets everything recorded so far. */
  reset(): void {
    this.calls.length = 0;
  }
}

export interface FakeCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  style: { width: string; height: string };
  ctx: FakeContext;
  getContext: () => FakeContext;
}

export function makeCanvas(cssWidth = 800, cssHeight = 600): FakeCanvas {
  const ctx = new FakeContext();
  return {
    width: 0,
    height: 0,
    clientWidth: cssWidth,
    clientHeight: cssHeight,
    style: { width: "", height: "" },
    ctx,
    getContext: () => ctx,
  };
}

/**
 * Installs the globals the renderer reaches for. Returns the offscreen canvases
 * handed out by document.createElement, in order, and a restore function.
 */
export function installDom(dpr = 2): { offscreen: FakeCanvas[]; restore: () => void } {
  const offscreen: FakeCanvas[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const prevDocument = g["document"];
  const prevDpr = g["devicePixelRatio"];

  g["document"] = {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`unexpected element ${tag}`);
      const c = makeCanvas();
      offscreen.push(c);
      return c;
    },
  };
  g["devicePixelRatio"] = dpr;

  return {
    offscreen,
    restore: () => {
      g["document"] = prevDocument;
      g["devicePixelRatio"] = prevDpr;
    },
  };
}
