import { describe, expect, it } from "vitest";
import { FakeClock } from "../testing/fake-clock";
import { ReplayClock } from "./clock";

describe("ReplayClock", () => {
  it("starts at its start time", () => {
    const start = new Date("2026-08-12T22:00:00Z");
    const replay = new ReplayClock(start, 60, new FakeClock());
    expect(replay.now().toISOString()).toBe(start.toISOString());
  });

  it("runs faster than the clock beneath it", () => {
    const beneath = new FakeClock();
    const replay = new ReplayClock(new Date("2026-08-12T22:00:00Z"), 60, beneath);
    beneath.advance(60_000);
    expect(replay.now().toISOString()).toBe("2026-08-12T23:00:00.000Z");
  });
});
