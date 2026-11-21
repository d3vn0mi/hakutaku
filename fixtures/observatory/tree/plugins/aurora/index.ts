import { auroraChance, kpAt } from "./forecast";

// What the sky map hands a plugin when it loads it.
export interface AuroraHost {
  latitude(): number;
  addLayer(name: string, strength: (t: number) => number): void;
}

// Called once by the sky map's plugin loader, which finds this file through plugin.json. Adds a
// layer whose strength at day t is the chance of seeing an aurora from the observer's latitude,
// and returns the plugin's name.
export function activate(host: AuroraHost): string {
  host.addLayer("aurora", (t) => auroraChance(kpAt(t), host.latitude()));
  return "aurora";
}
