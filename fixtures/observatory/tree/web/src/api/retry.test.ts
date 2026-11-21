import { describe, expect, it } from "vitest";
import { withRetry } from "./retry";

describe("withRetry", () => {
  it("returns the first success, waiting twice as long each time", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("not yet");
        return "done";
      },
      3,
      100,
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(result).toBe("done");
    expect(waits).toEqual([100, 200]);
  });

  it("throws the last failure", async () => {
    await expect(
      withRetry(() => Promise.reject(new Error("down")), 2, 1, async () => {}),
    ).rejects.toThrow("down");
  });
});
