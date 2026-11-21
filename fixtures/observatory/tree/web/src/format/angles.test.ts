import { describe, expect, it } from "vitest";
import { formatDeclination, formatMagnitude, formatRightAscension } from "./angles";

describe("angles", () => {
  it("writes right ascension in hours", () => {
    expect(formatRightAscension(101.287)).toBe("06h 45m 09s");
    expect(formatRightAscension(0)).toBe("00h 00m 00s");
  });

  it("writes declination with its sign", () => {
    expect(formatDeclination(-16.716)).toBe("-16d 42m 58s");
    expect(formatDeclination(38.784)).toBe("+38d 47m 02s");
  });

  it("carries a rounded 60 seconds into the minutes", () => {
    expect(formatDeclination(10.99999)).toBe("+11d 00m 00s");
  });

  it("writes magnitudes with a sign and two decimals", () => {
    expect(formatMagnitude(-1.46)).toBe("-1.46 mag");
    expect(formatMagnitude(0.03)).toBe("+0.03 mag");
  });
});
