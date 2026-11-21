import { describe, expect, it } from "vitest";
import { PluginRegistry } from "./registry";

describe("PluginRegistry", () => {
  it("keeps the layers a plugin adds through its host", () => {
    const registry = new PluginRegistry(60);
    const host = registry.host();
    host.addLayer("glow", (t) => t / 10);
    expect(host.latitude()).toBe(60);
    expect(registry.layerNames()).toEqual(["glow"]);
    expect(registry.strength("glow", 5)).toBe(0.5);
    expect(registry.strength("missing", 5)).toBe(0);
  });

  it("refuses a plugin loaded twice", () => {
    const registry = new PluginRegistry();
    const module = { activate: () => "twice" };
    registry.add("twice", module);
    expect(() => registry.add("twice", module)).toThrow("already loaded");
  });
});
