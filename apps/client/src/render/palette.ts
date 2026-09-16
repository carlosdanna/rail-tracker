/** Colours for inferred lines, and the few fixed colours the scene needs. */
export const LINE_COLORS = [
  "#4dabf7",
  "#51cf66",
  "#ff922b",
  "#e599f7",
  "#ffd43b",
  "#63e6be",
  "#ff8787",
  "#a9e34b",
] as const;

/** Colour for a line by its index, cycling through the palette. */
export function lineColor(index: number): string {
  return LINE_COLORS[
    ((index % LINE_COLORS.length) + LINE_COLORS.length) % LINE_COLORS.length
  ] as string;
}

export const COLORS = {
  background: "#0e1116",
  grid: "#1b2230",
  /** Trains whose line has not been reconstructed yet. */
  unknownTrain: "#8b98a9",
  station: "#e9ecef",
  stationRing: "#0e1116",
  trail: "rgba(139, 152, 169, 0.35)",
  /** The "compare with /world" overlay, deliberately contrasting. */
  truthLine: "rgba(255, 110, 180, 0.85)",
  truthStation: "rgba(255, 110, 180, 0.95)",
} as const;
