import { expect, it } from "vitest";
import { drawFrame } from "./frame";
import { PLANETS } from "./planets";

// A canvas that writes down each call it gets.
function recorder() {
  const calls: string[] = [];
  const canvas = {
    width: 800,
    height: 600,
    clear: (color: string) => {
      calls.push(`clear ${color}`);
    },
    dot: (x: number, y: number) => {
      calls.push(`dot ${Math.round(x)},${Math.round(y)}`);
    },
    line: () => {
      calls.push("line");
    },
    label: (_x: number, _y: number, text: string) => {
      calls.push(`label ${text}`);
    },
  };
  return { calls, canvas };
}

it("clears, draws the star field, then labels each planet on the screen", () => {
  const { calls, canvas } = recorder();
  const drawn = drawFrame(canvas, PLANETS, 0);
  expect(calls[0]).toBe("clear #020814");
  expect(calls).toContain("line");
  expect(calls.filter((c) => c.startsWith("label ")).length).toBe(drawn);
  expect(drawn).toBeGreaterThan(0);
});
