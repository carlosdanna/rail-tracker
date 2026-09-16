import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Renderer } from "../src/render/renderer";
import type { Scene } from "../src/render/renderer";
import { Store } from "../src/store/store";
import { COLORS, lineColor } from "../src/render/palette";
import { toScreenX, toScreenY } from "../src/render/viewport";
import { allocArrays } from "../src/worker/arrays";
import { installDom, makeCanvas } from "./fakecanvas";
import type { FakeCanvas } from "./fakecanvas";

const BOUNDS = { w: 1000, h: 1000 };

let dom: ReturnType<typeof installDom>;

beforeEach(() => {
  dom = installDom(2);
});

afterEach(() => {
  dom.restore();
});

/** A renderer over a fake canvas, plus the fakes behind it. */
function setup(): { renderer: Renderer; canvas: FakeCanvas; offscreen: FakeCanvas } {
  const canvas = makeCanvas(800, 600);
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement, BOUNDS);
  const offscreen = dom.offscreen[0];
  if (offscreen === undefined) throw new Error("no offscreen canvas was created");
  return { renderer, canvas, offscreen };
}

/** A store holding trains at the given positions. */
function storeWith(
  trains: { index: number; x: number; y: number; heading?: number; speed?: number }[],
): Store {
  const store = new Store();
  const arrays = allocArrays(Math.max(1, trains.length));
  trains.forEach((t, i) => {
    arrays.index[i] = t.index;
    arrays.x[i] = t.x;
    arrays.y[i] = t.y;
    arrays.heading[i] = t.heading ?? 0;
    arrays.speed[i] = t.speed ?? 0;
    arrays.state[i] = 0;
    arrays.seq[i] = i;
  });
  store.applyArrays(arrays, trains.length, 1000);
  return store;
}

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    bounds: BOUNDS,
    lines: [],
    stations: [],
    staticVersion: 1,
    truth: null,
    ...overrides,
  };
}

describe("canvas sizing", () => {
  it("sizes the backing store in device pixels and the element in CSS pixels", () => {
    const { canvas } = setup();
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(canvas.style.width).toBe("800px");
    expect(canvas.style.height).toBe("600px");
  });

  it("fits the world without distorting it", () => {
    const { renderer } = setup();
    const v = renderer.viewport;
    // 600 tall minus a 16px margin each side, over 1000 world units.
    expect(v.scale).toBeCloseTo(568 / 1000, 6);
    expect(v.dpr).toBe(2);
  });

  it("re-fits on resize", () => {
    const { renderer } = setup();
    renderer.resize(BOUNDS, 400, 400, 1);
    expect(renderer.viewport.scale).toBeCloseTo(368 / 1000, 6);
    expect(renderer.viewport.dpr).toBe(1);
  });
});

describe("static layer", () => {
  it("is repainted only when the reconstruction changes", () => {
    const { renderer, offscreen } = setup();
    const store = storeWith([{ index: 0, x: 100, y: 100 }]);

    renderer.draw(store, scene({ staticVersion: 1 }), 1000);
    const first = offscreen.ctx.ops("clearRect").length;
    expect(first).toBe(1);

    // Same version: three more frames must not repaint it.
    renderer.draw(store, scene({ staticVersion: 1 }), 1016);
    renderer.draw(store, scene({ staticVersion: 1 }), 1032);
    renderer.draw(store, scene({ staticVersion: 1 }), 1048);
    expect(offscreen.ctx.ops("clearRect")).toHaveLength(first);

    // A new version repaints once.
    renderer.draw(store, scene({ staticVersion: 2 }), 1064);
    expect(offscreen.ctx.ops("clearRect")).toHaveLength(first + 1);
  });

  it("is invalidated by a resize", () => {
    const { renderer, offscreen } = setup();
    const store = storeWith([{ index: 0, x: 0, y: 0 }]);
    renderer.draw(store, scene(), 0);
    const before = offscreen.ctx.ops("clearRect").length;

    renderer.resize(BOUNDS, 1200, 900, 2);
    renderer.draw(store, scene(), 16);
    expect(offscreen.ctx.ops("clearRect").length).toBe(before + 1);
  });

  it("draws inferred lines in their palette colour and stations as discs", () => {
    const { renderer, offscreen } = setup();
    const store = storeWith([]);
    renderer.draw(
      store,
      scene({
        lines: [
          {
            id: "inferred-0",
            kind: "loop",
            colorIndex: 0,
            trainIds: ["T-0"],
            points: [
              { x: 100, y: 100 },
              { x: 200, y: 100 },
              { x: 200, y: 200 },
            ],
          },
        ],
        stations: [{ id: "station-0", x: 100, y: 100, stops: 4, trains: 2 }],
      }),
      0,
    );

    const strokes = offscreen.ctx.ops("stroke").map((c) => c.args[0]);
    expect(strokes).toContain(lineColor(0));
    // A loop is closed; a shuttle would not be.
    expect(offscreen.ctx.ops("closePath").length).toBeGreaterThan(0);

    const arcs = offscreen.ctx.ops("arc");
    expect(arcs).toHaveLength(1);
    const v = renderer.viewport;
    expect(arcs[0]?.args[0]).toBeCloseTo(toScreenX(v, 100), 6);
    expect(arcs[0]?.args[1]).toBeCloseTo(toScreenY(v, 100), 6);
  });

  it("draws the truth overlay only when it is switched on", () => {
    const { renderer, offscreen } = setup();
    const store = storeWith([]);
    const truth = {
      stations: [{ x: 500, y: 500 }],
      lines: [
        {
          kind: "shuttle" as const,
          track: [
            { x: 100, y: 100 },
            { x: 900, y: 900 },
          ],
        },
      ],
    };

    renderer.draw(store, scene({ truth, staticVersion: 1 }), 0);
    expect(offscreen.ctx.ops("setLineDash")).toHaveLength(0);

    renderer.setOptions({ showTruth: true });
    renderer.draw(store, scene({ truth, staticVersion: 1 }), 16);
    // Dashed strokes for the track, crosses for the stations.
    expect(offscreen.ctx.ops("setLineDash").length).toBeGreaterThan(0);
    const strokes = offscreen.ctx.ops("stroke").map((c) => c.args[0]);
    expect(strokes).toContain(COLORS.truthLine);
    expect(strokes).toContain(COLORS.truthStation);
  });
});

describe("trains", () => {
  it("draws one path per colour rather than one per train", () => {
    const { renderer, canvas } = setup();
    const store = storeWith(
      Array.from({ length: 50 }, (_, i) => ({ index: i, x: i * 10, y: 100 })),
    );
    renderer.draw(store, scene(), 1000);

    // Every train is unassigned, so they share one colour and one fill.
    const fills = canvas.ctx.ops("fill").filter((c) => c.args[0] === COLORS.unknownTrain);
    expect(fills).toHaveLength(1);
    // Three vertices each.
    expect(canvas.ctx.ops("moveTo").length).toBe(50);
    expect(canvas.ctx.ops("lineTo").length).toBe(100);
  });

  it("colours trains by their inferred line", () => {
    const { renderer, canvas } = setup();
    const store = storeWith([
      { index: 0, x: 100, y: 100 },
      { index: 1, x: 200, y: 200 },
    ]);
    const lines = [
      {
        id: "inferred-0",
        kind: "loop" as const,
        colorIndex: 3,
        trainIds: ["T-0"],
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    ];
    store.assignLine("T-0", "inferred-0");
    renderer.setLineColors(lines);
    renderer.draw(store, scene({ lines }), 1000);

    const fills = canvas.ctx.ops("fill").map((c) => c.args[0]);
    expect(fills).toContain(lineColor(3));
    expect(fills).toContain(COLORS.unknownTrain);
  });

  it("dead-reckons a moving train and leaves a stopped one alone", () => {
    const { renderer, canvas } = setup();
    const store = storeWith([{ index: 0, x: 500, y: 500, heading: 90, speed: 100 }]);
    const v = renderer.viewport;

    // At the update's own timestamp the train sits where it was reported.
    renderer.draw(store, scene(), 1000);
    const still = canvas.ctx.ops("moveTo")[0];
    expect(still?.args[0]).toBeCloseTo(toScreenX(v, 500) + 6, 6);

    // 200 ms later, moving east at 100 units/sec: 20 units further on.
    canvas.ctx.reset();
    renderer.draw(store, scene(), 1200);
    const moved = canvas.ctx.ops("moveTo")[0];
    expect(moved?.args[0]).toBeCloseTo(toScreenX(v, 520) + 6, 6);

    // Beyond the horizon it stops extrapolating rather than running away.
    canvas.ctx.reset();
    renderer.draw(store, scene(), 9000);
    const clamped = canvas.ctx.ops("moveTo")[0];
    expect(clamped?.args[0]).toBeCloseTo(toScreenX(v, 525) + 6, 6);
  });
});

describe("trails", () => {
  it("draws every trail in a single path and can be switched off", () => {
    const { renderer, canvas } = setup();
    const store = new Store({ trail: { epsilon: 1, delta: 5, cap: 100 } });
    for (let i = 0; i < 20; i++) {
      const arrays = allocArrays(2);
      arrays.index[0] = 0;
      arrays.x[0] = i * 20;
      arrays.y[0] = 100;
      arrays.index[1] = 1;
      arrays.x[1] = i * 20;
      arrays.y[1] = 300;
      store.applyArrays(arrays, 2, i);
    }

    renderer.draw(store, scene(), 1000);
    const trailStrokes = canvas.ctx.ops("stroke").filter((c) => c.args[0] === COLORS.trail);
    expect(trailStrokes).toHaveLength(1);

    canvas.ctx.reset();
    renderer.setOptions({ showTrails: false });
    renderer.draw(store, scene(), 1016);
    expect(canvas.ctx.ops("stroke").filter((c) => c.args[0] === COLORS.trail)).toHaveLength(0);
  });
});
