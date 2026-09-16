/**
 * The HUD: a stats readout plus the controls from spec §4.
 *
 * Plain DOM, no framework. Values are written into pre-created nodes rather
 * than re-rendering, so updating sixty times a second costs nothing.
 */
import type { StatsSnapshot } from "../store/stats";

/** Everything the HUD displays. */
export interface HudModel extends StatsSnapshot {
  /** Lines reconstructed so far. */
  inferredLines: number;
  /** Stations inferred so far. */
  inferredStations: number;
  /** Connection state, as reported by the worker. */
  connection: string;
  /** Points held across all trails, a proxy for client memory. */
  trailPoints: number;
}

/** What the controls can ask the app to do. */
export interface HudHandlers {
  onRateChange: (rate: number) => void;
  onFormatChange: (format: "json" | "bin") => void;
  onTrailsToggle: (show: boolean) => void;
  onTruthToggle: (show: boolean) => void;
}

/** Initial control values. */
export interface HudState {
  rate: number;
  format: "json" | "bin";
  trails: boolean;
  truth: boolean;
}

interface Row {
  label: string;
  key: keyof HudModel;
  /** Optional formatter; defaults to a plain number with thousands separators. */
  format?: (v: number | string) => string;
}

const ROWS: Row[] = [
  { label: "msgs/sec", key: "msgsPerSec" },
  { label: "KiB/sec", key: "bytesPerSec", format: (v) => (Number(v) / 1024).toFixed(1) },
  { label: "dropped", key: "dropped" },
  { label: "seq gaps", key: "gaps" },
  { label: "FPS", key: "fps" },
  { label: "trains", key: "trains" },
  { label: "lines", key: "inferredLines" },
  { label: "stations", key: "inferredStations" },
  { label: "latency", key: "latencyMs", format: (v) => `${String(v)} ms` },
  { label: "trail pts", key: "trailPoints" },
  { label: "link", key: "connection", format: (v) => String(v) },
];

const NUMBER = new Intl.NumberFormat();

export class Hud {
  readonly #root: HTMLElement;
  readonly #values = new Map<keyof HudModel, HTMLElement>();
  #rateInput: HTMLInputElement | null = null;

  constructor(root: HTMLElement, state: HudState, handlers: HudHandlers) {
    this.#root = root;
    root.classList.add("hud");
    root.append(this.#buildStats(), this.#buildControls(state, handlers));
  }

  /**
   * Shows a rate the app did not choose, such as the server's own default
   * arriving in the hello frame. Skipped while the field has focus so it cannot
   * overwrite something being typed.
   */
  setRate(rate: number): void {
    const input = this.#rateInput;
    if (input === null || input === document.activeElement) return;
    input.value = String(rate);
  }

  /** Writes a new model into the existing nodes. */
  update(model: HudModel): void {
    for (const row of ROWS) {
      const node = this.#values.get(row.key);
      if (node === undefined) continue;
      const raw = model[row.key];
      node.textContent = row.format ? row.format(raw) : NUMBER.format(Number(raw));
    }
  }

  /** The element, so callers can hide or move it. */
  get element(): HTMLElement {
    return this.#root;
  }

  #buildStats(): HTMLElement {
    const table = document.createElement("dl");
    table.className = "hud-stats";
    for (const row of ROWS) {
      const dt = document.createElement("dt");
      dt.textContent = row.label;
      const dd = document.createElement("dd");
      dd.textContent = "–";
      this.#values.set(row.key, dd);
      table.append(dt, dd);
    }
    return table;
  }

  #buildControls(state: HudState, handlers: HudHandlers): HTMLElement {
    const box = document.createElement("div");
    box.className = "hud-controls";

    const rate = document.createElement("input");
    rate.type = "number";
    rate.min = "0";
    rate.step = "100";
    rate.value = String(state.rate);
    rate.id = "hud-rate";
    this.#rateInput = rate;
    // Commit on change, not on every keystroke.
    rate.addEventListener("change", () => {
      const n = Number(rate.value);
      if (Number.isFinite(n) && n >= 0) handlers.onRateChange(Math.round(n));
    });
    box.append(labelled("rate", rate));

    const format = document.createElement("select");
    format.id = "hud-format";
    for (const value of ["json", "bin"] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      option.selected = value === state.format;
      format.append(option);
    }
    format.addEventListener("change", () => {
      handlers.onFormatChange(format.value === "bin" ? "bin" : "json");
    });
    box.append(labelled("format", format));

    box.append(
      checkbox("trails", state.trails, handlers.onTrailsToggle),
      checkbox("compare with /world", state.truth, handlers.onTruthToggle),
    );
    return box;
  }
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "hud-field";
  const span = document.createElement("span");
  span.textContent = text;
  wrap.append(span, control);
  return wrap;
}

function checkbox(text: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const wrap = document.createElement("label");
  wrap.className = "hud-field hud-check";
  const span = document.createElement("span");
  span.textContent = text;
  wrap.append(input, span);
  return wrap;
}
