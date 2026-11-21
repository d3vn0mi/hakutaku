// The drawing calls the sky map makes. A browser canvas adapter provides them, and so does the
// recorder the tests use, so nothing under src/sky/ needs a browser.
export interface Canvas {
  readonly width: number;
  readonly height: number;
  clear(color: string): void;
  dot(x: number, y: number, radius: number, color: string): void;
  line(points: ReadonlyArray<[number, number]>, color: string): void;
  label(x: number, y: number, text: string): void;
}

export const BACKGROUND = "#020814";
