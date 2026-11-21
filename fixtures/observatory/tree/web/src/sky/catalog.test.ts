import { describe, expect, it } from "vitest";
import { BRIGHT_STARS, Catalog, magnitudeLimit } from "./catalog";

describe("Catalog", () => {
  const catalog = new Catalog();

  it("sorts the stars brightest first", () => {
    expect(catalog.brightest(2).map((s) => s.name)).toEqual(["Sirius", "Canopus"]);
  });

  it("looks a star up by name in any case", () => {
    expect(catalog.lookup("vega")?.magnitude).toBeCloseTo(0.03);
    expect(catalog.lookup("Polaris")).toBeUndefined();
  });

  it("suggests the planets too", () => {
    expect(catalog.names()).toContain("Jupiter");
  });

  it("shows fewer stars under a brighter sky", () => {
    expect(magnitudeLimit(1)).toBeGreaterThan(magnitudeLimit(9));
    expect(catalog.visible(9).length).toBeLessThanOrEqual(catalog.visible(1).length);
  });

  it("keeps only the stars it is given", () => {
    expect(new Catalog(BRIGHT_STARS.slice(0, 3)).size).toBe(3);
  });
});
