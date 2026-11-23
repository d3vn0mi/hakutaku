// How long a camera move lasts: its own time, or none at all when the viewer asks for reduced
// motion. And nothing else in the app moves on its own: the map's camera animates only for as
// long as motionMs says, the source scrolls smoothly only when reduced motion is not asked for,
// and the styles animate nothing.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { motionMs } from "../../../../src/viewer/app/motion.js";

const APP = fileURLToPath(
  new URL("../../../../src/viewer/app/", import.meta.url),
);
const read = (f: string) => readFileSync(join(APP, f), "utf8");
// Every file of the app, as a path under src/viewer/app.
const files = readdirSync(APP, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => join(e.parentPath, e.name).slice(APP.length))
  .sort();

it("a move takes no time under reduced motion, and its own time otherwise", () => {
  expect(motionMs(380, true)).toBe(0);
  expect(motionMs(380, false)).toBe(380);
  expect(motionMs(0, false)).toBe(0);
});

it("reduced motion turns camera animations off", () => {
  expect([motionMs(380, true), motionMs(380, false)]).toEqual([0, 380]);
});

it("the camera animates in one place, for as long as motionMs says under the viewer's wish", () => {
  const code = files.filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
  expect(code).toContain("map/render.ts"); // the scan reads real files
  const animating = code.filter((f) =>
    /\.animate\(|animated(Reset|Zoom|Unzoom)\(/.test(read(f)),
  );
  expect(animating).toEqual(["map/render.ts"]);
  const render = read("map/render.ts");
  expect(render.match(/\.animate\(/g)).toHaveLength(1);
  expect(render).toMatch(
    /const duration = motionMs\(ms, prefersReducedMotion\(\)\);\s+if \(duration > 0\) void camera\.animate\(target, \{ duration \}\);\s+else camera\.setState\(target\);/,
  );
});

it("a scroll is smooth only when reduced motion is not asked for, and the styles animate nothing", () => {
  const code = files.filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
  const smooth = code.filter((f) => /"smooth"/.test(read(f)));
  expect(smooth).toEqual(["source/render.ts"]);
  expect(read("source/render.ts")).toMatch(
    /behavior: prefersReducedMotion\(\) \? "instant" : "smooth"/,
  );
  const css = files.filter((f) => f.endsWith(".css"));
  expect(css).toContain("styles/app.css");
  for (const f of css) {
    expect(read(f), f).not.toMatch(
      /\b(transition|animation)(-[a-z-]+)?\s*:|@keyframes|scroll-behavior:\s*smooth/,
    );
  }
});
