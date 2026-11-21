// The plugins the sky map has loaded, and what each may call back.
export interface PluginHost {
  latitude(): number;
  addLayer(name: string, strength: (t: number) => number): void;
}

// What a plugin's entry module exports.
export interface PluginModule {
  activate(host: PluginHost): string;
}

export class PluginRegistry {
  private readonly layers = new Map<string, (t: number) => number>();
  private readonly loaded = new Map<string, PluginModule>();

  constructor(private readonly observerLatitude = 51.5) {}

  // The host handed to each plugin's activate.
  host(): PluginHost {
    return {
      latitude: () => this.observerLatitude,
      addLayer: (name, strength) => {
        this.layers.set(name, strength);
      },
    };
  }

  add(name: string, module: PluginModule): void {
    if (this.loaded.has(name)) throw new Error(`the plugin ${name} is already loaded`);
    this.loaded.set(name, module);
  }

  layerNames(): string[] {
    return [...this.layers.keys()].sort();
  }

  // A plugin layer's strength at day t, 0 for a layer nobody added.
  strength(name: string, t: number): number {
    return this.layers.get(name)?.(t) ?? 0;
  }
}
