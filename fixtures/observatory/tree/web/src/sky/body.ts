// Anything the sky map can draw at a place that changes with time: a planet on its orbit, a
// comet, a spacecraft. Orbit, in ../orbits/kepler.ts, has this shape without naming it.
export interface Body {
  readonly name: string;
  position(t: number): [number, number];
}

// Whether a value has the shape of a Body, for data that arrives untyped.
export function isBody(value: unknown): value is Body {
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Record<string, unknown>;
  return typeof fields.name === "string" && typeof fields.position === "function";
}
