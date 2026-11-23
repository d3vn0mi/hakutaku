// How long a camera move lasts: its own time, or none at all when the viewer asks for reduced
// motion.
import { expect, it } from "vitest";
import { motionMs } from "../../../../src/viewer/app/motion.js";

it("a move takes no time under reduced motion, and its own time otherwise", () => {
  expect(motionMs(380, true)).toBe(0);
  expect(motionMs(380, false)).toBe(380);
  expect(motionMs(0, false)).toBe(0);
});
