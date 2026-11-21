import { describe, expect, it } from "vitest";
import { FakeClock } from "../testing/fake-clock";
import { TtlCache } from "./cache";

describe("TtlCache", () => {
  it("returns a value until it expires", () => {
    const clock = new FakeClock();
    const cache = new TtlCache<number>(1000, clock);
    cache.set("mars", 4);
    clock.advance(999);
    expect(cache.get("mars")).toBe(4);
    clock.advance(1);
    expect(cache.get("mars")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("has nothing for a key it was never given", () => {
    const cache = new TtlCache<number>(1000, new FakeClock());
    expect(cache.get("venus")).toBeUndefined();
  });
});
