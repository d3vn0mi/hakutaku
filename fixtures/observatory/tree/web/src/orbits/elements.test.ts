import { expect, it } from "vitest";
import { elementsOf, MEAN_ELEMENTS } from "./elements";

it("lists the planets out to Saturn, nearest first", () => {
  const axes = MEAN_ELEMENTS.map((el) => el.a);
  expect(axes).toEqual([...axes].sort((x, y) => x - y));
  expect(MEAN_ELEMENTS.at(-1)?.name).toBe("Saturn");
});

it("finds a planet's elements by name", () => {
  expect(elementsOf("Mars")?.period).toBeCloseTo(686.98);
  expect(elementsOf("Pluto")).toBeUndefined();
});
