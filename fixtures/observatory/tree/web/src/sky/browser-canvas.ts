import type { Canvas } from "./canvas";

// The calls the adapter makes on a browser's 2D drawing context.
export interface Context2D {
  readonly canvas: { width: number; height: number };
  fillStyle: string;
  strokeStyle: string;
  font: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  fill(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
}

const LABEL_COLOR = "#c8d3f5";
const LABEL_FONT = "12px sans-serif";

// The sky map's Canvas, drawn on a browser canvas through its 2D context.
export function browserCanvas(ctx: Context2D): Canvas {
  return {
    width: ctx.canvas.width,
    height: ctx.canvas.height,
    clear(color) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    },
    dot(x, y, radius, color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fill();
    },
    line(points, color) {
      const [first, ...rest] = points;
      if (first === undefined) return;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(first[0], first[1]);
      for (const [x, y] of rest) ctx.lineTo(x, y);
      ctx.stroke();
    },
    label(x, y, text) {
      ctx.fillStyle = LABEL_COLOR;
      ctx.font = LABEL_FONT;
      ctx.fillText(text, x, y);
    },
  };
}
