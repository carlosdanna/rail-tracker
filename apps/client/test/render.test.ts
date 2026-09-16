import { describe, expect, it } from "vitest";
import { fit, sameViewport, toScreenX, toScreenY } from "../src/render/viewport";
import { reckon } from "../src/render/deadreckon";
import { lineColor, LINE_COLORS } from "../src/render/palette";
import { optionsFromSearch, streamUrl } from "../src/app";

describe("viewport", () => {
  it("fits a square world into a wide canvas without distorting it", () => {
    const v = fit({ w: 1000, h: 1000 }, 1600, 900, 1, 0);
    // The short side decides the scale.
    expect(v.scale).toBeCloseTo(0.9, 6);
    // And the world is centred horizontally.
    expect(v.offsetX).toBeCloseTo((1600 - 900) / 2, 6);
    expect(v.offsetY).toBeCloseTo(0, 6);
  });

  it("fits into a tall canvas the same way", () => {
    const v = fit({ w: 1000, h: 1000 }, 600, 1200, 1, 0);
    expect(v.scale).toBeCloseTo(0.6, 6);
    expect(v.offsetY).toBeCloseTo((1200 - 600) / 2, 6);
  });

  it("leaves the requested margin", () => {
    const v = fit({ w: 1000, h: 1000 }, 500, 500, 1, 50);
    expect(v.scale).toBeCloseTo(0.4, 6);
    expect(toScreenX(v, 0)).toBeCloseTo(50, 6);
    expect(toScreenX(v, 1000)).toBeCloseTo(450, 6);
  });

  it("maps world corners onto canvas corners", () => {
    const v = fit({ w: 1000, h: 500 }, 1000, 500, 2, 0);
    expect(toScreenX(v, 0)).toBeCloseTo(0, 6);
    expect(toScreenY(v, 0)).toBeCloseTo(0, 6);
    expect(toScreenX(v, 1000)).toBeCloseTo(1000, 6);
    expect(toScreenY(v, 500)).toBeCloseTo(500, 6);
  });

  it("keeps Y pointing down", () => {
    const v = fit({ w: 100, h: 100 }, 100, 100, 1, 0);
    expect(toScreenY(v, 10)).toBeLessThan(toScreenY(v, 90));
  });

  it("compares viewports by their transform", () => {
    const a = fit({ w: 1000, h: 1000 }, 800, 600, 1);
    const b = fit({ w: 1000, h: 1000 }, 800, 600, 1);
    const c = fit({ w: 1000, h: 1000 }, 800, 601, 1);
    expect(sameViewport(a, b)).toBe(true);
    expect(sameViewport(a, c)).toBe(false);
  });
});

describe("dead reckoning", () => {
  const base = { x: 100, y: 100, heading: 0, speed: 10, updatedAt: 1000 };

  it("does not move a stopped train", () => {
    expect(reckon({ ...base, speed: 0 }, 5000)).toEqual({ x: 100, y: 100 });
  });

  it("extrapolates north as −Y", () => {
    const p = reckon({ ...base, heading: 0 }, 1100, { horizonMs: 1000 });
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.y).toBeCloseTo(99, 6);
  });

  it("extrapolates the four cardinal directions correctly", () => {
    const at = (heading: number): { x: number; y: number } =>
      reckon({ ...base, heading }, 2000, { horizonMs: 1000 });
    expect(at(0).y).toBeCloseTo(90, 6);
    expect(at(90).x).toBeCloseTo(110, 6);
    expect(at(180).y).toBeCloseTo(110, 6);
    expect(at(270).x).toBeCloseTo(90, 6);
  });

  it("clamps to the horizon so a stale update cannot run away", () => {
    const near = reckon(base, 1250, { horizonMs: 250 });
    const far = reckon(base, 60_000, { horizonMs: 250 });
    expect(far).toEqual(near);
    expect(far.y).toBeCloseTo(97.5, 6);
  });

  it("ignores a timestamp from the future", () => {
    expect(reckon(base, 500)).toEqual({ x: 100, y: 100 });
  });
});

describe("palette", () => {
  it("cycles through the colours", () => {
    expect(lineColor(0)).toBe(LINE_COLORS[0]);
    expect(lineColor(LINE_COLORS.length)).toBe(LINE_COLORS[0]);
    expect(lineColor(LINE_COLORS.length + 2)).toBe(LINE_COLORS[2]);
  });

  it("handles a negative index", () => {
    expect(lineColor(-1)).toBe(LINE_COLORS[LINE_COLORS.length - 1]);
  });
});

describe("app options", () => {
  it("leaves the rate to the server when the URL says nothing", () => {
    // null, not a number: the page has no business overriding --rate unless it
    // was actually asked to, and a pinned rate ignores POST /config.
    expect(optionsFromSearch("")).toEqual({ rate: null, format: "json", perf: false });
  });

  it("reads rate, format and perf", () => {
    expect(optionsFromSearch("?rate=10000&format=bin&perf")).toEqual({
      rate: 10000,
      format: "bin",
      perf: true,
    });
  });

  it("accepts rate=0, which means pause rather than unset", () => {
    expect(optionsFromSearch("?rate=0").rate).toBe(0);
  });

  it("falls back to the server rate on a nonsense value", () => {
    expect(optionsFromSearch("?rate=soon").rate).toBeNull();
    expect(optionsFromSearch("?rate=-5").rate).toBeNull();
  });

  it("treats any format but bin as json", () => {
    expect(optionsFromSearch("?format=protobuf").format).toBe("json");
  });

  it("builds the stream URL for the page's scheme and host", () => {
    const http = { protocol: "http:", host: "localhost:5173" } as Location;
    const https = { protocol: "https:", host: "rail.example" } as Location;
    const opts = { rate: 500, format: "bin" as const, perf: false };
    expect(streamUrl(http, opts)).toBe("ws://localhost:5173/stream?format=bin&rate=500");
    expect(streamUrl(https, opts)).toBe("wss://rail.example/stream?format=bin&rate=500");
  });

  it("omits rate entirely when the server should decide", () => {
    const http = { protocol: "http:", host: "localhost:5173" } as Location;
    expect(streamUrl(http, { rate: null, format: "json", perf: false })).toBe(
      "ws://localhost:5173/stream?format=json",
    );
  });
});
