// A map of any size for the browser app's tests, built from arithmetic alone, so the same
// arguments always give the same map:
// - 20 components, src/c0 to src/c19;
// - production file i is "src/c<i % 20>/f<i>.ts", in component i % 20, with rank i + 1 and
//   pagerank 1 / (i + 1), and imports file (7i + 3) mod n unless that is itself; the first tenth
//   by rank is the core set;
// - test j is "src/c<j % 20>/f<j>.test.ts", in component j % 20, and imports production file
//   j mod n;
// - library j is npm's "lib<j>", and production file i imports library i mod L;
// - production file i defines "fn<i>_<k>" for k from 0, at line 1 + 3k.
// Production files come first, then tests. Outlines and co-change are inline up to the same
// limit as a store's map.
import {
  FLAG_CORE,
  FLAG_SOURCE,
  INLINE_OUTLINES_UP_TO,
} from "../../../../src/query/view/constants.js";
import type { MapData, MapFile } from "../../../../src/query/view/types.js";

const COMPONENTS = 20;
const LINES = 40;

export function syntheticMap(
  production: number,
  opts: { tests?: number; defsPerFile?: number; libraries?: number } = {},
): MapData {
  const tests = opts.tests ?? 0;
  const defsPerFile = opts.defsPerFile ?? 0;
  const libraries = opts.libraries ?? 0;
  const core = Math.ceil(production / 10);

  const files: MapFile[] = [];
  const components: MapData["components"] = Array.from(
    { length: COMPONENTS },
    (_, c) => [`src/c${c}`, 0, 0, 0],
  );
  for (let i = 0; i < production; i++) {
    const c = i % COMPONENTS;
    const flags = FLAG_SOURCE | (i < core ? FLAG_CORE : 0);
    files.push([
      `src/c${c}/f${i}.ts`,
      0,
      0,
      c,
      LINES,
      i + 1,
      1 / (i + 1),
      0,
      0,
      -1,
      0,
      flags,
    ]);
    components[c][1]++;
    components[c][3] += LINES;
  }
  for (let j = 0; j < tests; j++) {
    const c = j % COMPONENTS;
    files.push([
      `src/c${c}/f${j}.test.ts`,
      1,
      0,
      c,
      LINES,
      0,
      0,
      0,
      0,
      -1,
      0,
      FLAG_SOURCE,
    ]);
    components[c][2]++;
    components[c][3] += LINES;
  }

  const imports: number[] = [];
  for (let i = 0; i < production; i++) {
    const to = (7 * i + 3) % production;
    if (to !== i) imports.push(i, to, 0);
  }
  if (production > 0) {
    for (let j = 0; j < tests; j++)
      imports.push(production + j, j % production, 0);
  }

  const externals: MapData["externals"] = Array.from(
    { length: libraries },
    (_, j) => [0, `lib${j}`, 0],
  );
  const libImports: number[] = [];
  if (libraries > 0) {
    for (let i = 0; i < production; i++) {
      libImports.push(i, i % libraries);
      externals[i % libraries][2]++;
    }
  }

  const defs: MapData["defs"] = {
    file: [],
    name: [],
    ordinal: [],
    line: [],
    kind: [],
    exported: [],
    usedBy: [],
  };
  const endLine: number[] = [];
  for (let i = 0; i < production; i++) {
    for (let k = 0; k < defsPerFile; k++) {
      defs.file.push(i);
      defs.name.push(`fn${i}_${k}`);
      defs.ordinal.push(1);
      defs.line.push(1 + 3 * k);
      defs.kind.push(0);
      defs.exported.push(1);
      defs.usedBy.push(0);
      endLine.push(3 + 3 * k);
    }
  }
  const inline = production <= INLINE_OUTLINES_UP_TO;

  return {
    format: 1,
    repo: "synthetic",
    builtCommit: "0123456789ab",
    stale: false,
    detail: "quick",
    sources: false,
    counts: {
      productionFiles: production,
      tests,
      components: COMPONENTS,
      entryPoints: 0,
      cycles: 0,
      importEdges: imports.length / 3,
      libraries,
      definitions: defs.name.length,
    },
    coreSet: { files: core, ofFiles: production },
    langs: ["typescript"],
    components,
    files,
    imports,
    externals,
    libImports,
    cycles: [],
    entries: [],
    defs,
    outline: inline ? { endLine, tested: endLine.map(() => 0) } : null,
    cochange: inline ? [] : null,
  };
}
