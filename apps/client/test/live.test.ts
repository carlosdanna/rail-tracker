/**
 * Scratch verification: connect to a running railsim, collect updates until the
 * trains have gone round once, then compare the reconstruction with /world.
 * Run with: RAIL_LIVE=1 npx vitest run live.check
 */
import { describe, expect, it } from "vitest";
import { parseBinaryBatch } from "../src/protocol";
import { LineInference } from "../src/infer/lines";
import { StationInference } from "../src/infer/stations";
import { distToPath } from "../src/infer/geometry";
import { lineOptionsFor, stationOptionsFor, trailOptionsFor, worldScale } from "../src/scale";

const ADDR = process.env["RAIL_ADDR"] ?? "127.0.0.1:8080";
const SECONDS = Number(process.env["RAIL_SECONDS"] ?? "180");
const RATE = process.env["RAIL_RATE"] ?? "10000";
const HIDE = process.env["RAIL_HIDE"] === "1";

interface WorldStation {
  id: string;
  x: number;
  y: number;
}
interface WorldLine {
  id: string;
  kind: "loop" | "shuttle";
  track: { x: number; y: number }[];
}
interface World {
  bounds: { w: number; h: number };
  stations: WorldStation[];
  lines: WorldLine[];
}

describe.runIf(process.env["RAIL_LIVE"] === "1")("live reconstruction", () => {
  it(
    "matches /world after one cycle",
    async () => {
      const world = (await (await fetch(`http://${ADDR}/world`)).json()) as World;

      // Thresholds are world-relative, exactly as the app derives them from
      // the hello frame, so this check works at any map size.
      const scale = worldScale(world.bounds);
      const lines = new LineInference(lineOptionsFor(scale));
      const stations = new StationInference(stationOptionsFor(scale));
      void trailOptionsFor(scale);

      const ws = new WebSocket(`ws://${ADDR}/stream?rate=${RATE}&format=bin`);
      ws.binaryType = "arraybuffer";
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("connect failed"));
      });

      ws.onmessage = (ev: MessageEvent<unknown>) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const batch = parseBinaryBatch(ev.data);
        for (const u of batch.updates) {
          lines.observe(u.id, u.x, u.y, u.heading, u.speed);
          // RAIL_HIDE forces the hard mode even against a server that is
          // reporting state, so both paths can be checked in one run.
          stations.observe(u.id, u.x, u.y, u.speed, HIDE ? "unknown" : u.state);
        }
      };

      await new Promise((r) => setTimeout(r, SECONDS * 1000));
      ws.close();

      const found = stations.stations();
      console.log(
        `bounds=${String(world.bounds.w)}x${String(world.bounds.h)} scale=${scale.toFixed(1)} ` +
          `rate=${RATE} hideState=${String(HIDE)} | ` +
          `inferred ${lines.lines.length} lines (truth ${world.lines.length}), ` +
          `${found.length} stations (truth ${world.stations.length})`,
      );
      for (const l of lines.lines) {
        console.log(`  ${l.id} kind=${l.kind} trains=${l.trainIds.length}`);
      }

      // Every real station has an inferred one near it.
      let worstStation = 0;
      for (const s of world.stations) {
        const d = Math.min(...found.map((f) => Math.hypot(f.x - s.x, f.y - s.y)));
        if (d > worstStation) worstStation = d;
      }
      console.log(`worst station error: ${worstStation.toFixed(2)}`);

      // Every inferred line lies on a real line.
      let worstLine = 0;
      for (const inferred of lines.lines) {
        let best = Infinity;
        for (const truth of world.lines) {
          let worst = 0;
          for (const p of inferred.points) {
            const d = distToPath(p, truth.track, truth.kind === "loop");
            if (d > worst) worst = d;
          }
          if (worst < best) best = worst;
        }
        if (best > worstLine) worstLine = best;
      }
      console.log(`worst line error: ${worstLine.toFixed(2)}`);

      expect(found.length).toBe(world.stations.length);
      expect(worstStation).toBeLessThan(15 * scale);
      expect(worstLine).toBeLessThan(20 * scale);
      expect(lines.lines.length).toBe(world.lines.length);
    },
    (SECONDS + 30) * 1000,
  );
});
