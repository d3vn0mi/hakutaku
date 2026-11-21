import { type PluginModule, PluginRegistry } from "./registry";

export interface PluginManifest {
  dir: string; // the plugin's directory, as the site serves it
  entry: string; // plugin.json's entry, relative to dir
}

// Loads one plugin: imports the module its manifest names, at a path built at run time, then
// activates it against the registry. Returns the plugin's name.
export async function loadPlugin(
  registry: PluginRegistry,
  manifest: PluginManifest,
): Promise<string> {
  const target = `${manifest.dir}/${manifest.entry.replace(/^\.\//, "")}`;
  const mod = (await import(target)) as PluginModule;
  const name = mod.activate(registry.host());
  registry.add(name, mod);
  return name;
}

// Loads each plugin in turn and returns the names of those that loaded. A plugin that fails is
// reported and skipped, so one broken plugin never blanks the map.
export async function loadPlugins(
  manifests: readonly PluginManifest[],
  report: (message: string) => void,
  registry = new PluginRegistry(),
): Promise<string[]> {
  const names: string[] = [];
  for (const manifest of manifests) {
    try {
      names.push(await loadPlugin(registry, manifest));
    } catch (error) {
      report(`plugin ${manifest.dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return names;
}
