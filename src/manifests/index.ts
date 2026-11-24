// The launch-manifest readers: every entry point a snapshot's manifests declare. Every
// manifest is parsed as data and never run; one that cannot be read in its format gives no
// fact, and no reader throws on a repo's content.
import { comparePaths } from "../model/index.js";
import { readTsconfigs, sourceForBuilt } from "./built-paths.js";
import { readCi } from "./ci.js";
import { bySuffix } from "./commands.js";
import { readContainers } from "./container.js";
import { readPackageJsons } from "./package-json.js";
import { readPluginManifests } from "./plugin.js";
import { readPythonManifests } from "./python.js";
import { readSignals } from "./signals.js";
import { readSystemdUnits } from "./systemd.js";
import type { EntryFact, ManifestInput, Named, ReadContext } from "./types.js";

export { sourceForBuilt } from "./built-paths.js";
export {
  pythonModuleIndex,
  pythonShadowedModules,
} from "./python-modules.js";
export type { EntryFact, ManifestInput } from "./types.js";

// The store's key for an entry point (the entry_points table's primary key), in order.
function compareKeys(a: EntryFact, b: EntryFact): number {
  return (
    comparePaths(a.file, b.file) ||
    comparePaths(a.kind, b.kind) ||
    comparePaths(a.manifest, b.manifest) ||
    a.line - b.line ||
    comparePaths(a.name, b.name)
  );
}

function compareQualnames(a: EntryFact, b: EntryFact): number {
  if (a.qualname === null || b.qualname === null)
    return (a.qualname === null ? 0 : 1) - (b.qualname === null ? 0 : 1);
  return comparePaths(a.qualname, b.qualname);
}

// Every reader's facts, without those naming a test file, sorted by (file, kind,
// manifest, line, name) with comparePaths, and one per key: the store keys entry_points by
// those five, so two facts that differ only in qualname keep the first in qualname order (no
// qualname first).
export function readEntryPoints(input: ManifestInput): EntryFact[] {
  const tsconfigs = readTsconfigs(input);
  const named: Named = (path) =>
    sourceForBuilt(path, tsconfigs, (p) => input.paths.has(p));
  // bySuffix tries a tail only when sourceForBuilt could map it to a tracked path: no longer
  // than the longest tracked path, plus what sourceForBuilt can take off a path. That is 4
  // characters (build/ to src/, then .d.ts to .ts), or an outDir, with its tsconfig's
  // directory, in place of a rootDir, then 2.
  let longest = 0;
  for (const path of input.paths) longest = Math.max(longest, path.length);
  let shrink = 4;
  for (const t of tsconfigs) {
    shrink = Math.max(shrink, t.dir.length + 1 + (t.outDir?.length ?? 0) + 2);
  }
  const ctx: ReadContext = {
    input,
    named,
    bySuffix: bySuffix(named, longest + shrink),
  };
  const facts = [
    ...readPackageJsons(ctx),
    ...readSystemdUnits(ctx),
    ...readPythonManifests(ctx),
    ...readContainers(ctx),
    ...readCi(ctx),
    ...readPluginManifests(ctx),
    ...readSignals(ctx),
  ].filter((fact) => !input.isTest(fact.file));
  facts.sort((a, b) => compareKeys(a, b) || compareQualnames(a, b));
  return facts.filter(
    (fact, i) => i === 0 || compareKeys(fact, facts[i - 1] as EntryFact) !== 0,
  );
}
