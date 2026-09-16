/**
 * Maps world coordinates onto the canvas.
 *
 * The world is a fixed box (1000×1000 by default) and the canvas is whatever
 * the browser gives us, so the transform is a uniform scale plus a letterbox
 * offset. Keeping it uniform matters: a non-uniform scale would distort the
 * oriented train markers.
 */
export interface Viewport {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  /** Device pixel ratio the backing store was sized for. */
  dpr: number;
  /** World units to CSS pixels. */
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface WorldBounds {
  w: number;
  h: number;
}

/** Fits `bounds` into a `width`×`height` canvas with a margin, centred. */
export function fit(
  bounds: WorldBounds,
  width: number,
  height: number,
  dpr: number,
  margin = 16,
): Viewport {
  const usableW = Math.max(1, width - margin * 2);
  const usableH = Math.max(1, height - margin * 2);
  const scale = Math.min(usableW / bounds.w, usableH / bounds.h);
  return {
    width,
    height,
    dpr,
    scale,
    offsetX: (width - bounds.w * scale) / 2,
    offsetY: (height - bounds.h * scale) / 2,
  };
}

/** World x to canvas x. */
export function toScreenX(v: Viewport, x: number): number {
  return v.offsetX + x * v.scale;
}

/** World y to canvas y. Y already points down in both spaces. */
export function toScreenY(v: Viewport, y: number): number {
  return v.offsetY + y * v.scale;
}

/** Two viewports are equal if nothing about the transform changed. */
export function sameViewport(a: Viewport, b: Viewport): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.dpr === b.dpr &&
    a.scale === b.scale &&
    a.offsetX === b.offsetX &&
    a.offsetY === b.offsetY
  );
}

/**
 * Sizes a canvas for the current device pixel ratio and returns the viewport.
 * The backing store is in device pixels; the context is scaled so that all
 * drawing can stay in CSS pixels.
 */
export function resizeCanvas(
  canvas: HTMLCanvasElement,
  bounds: WorldBounds,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): Viewport {
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  return fit(bounds, cssWidth, cssHeight, dpr);
}
