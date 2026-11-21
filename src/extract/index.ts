// extractSnapshot: one export directory into one gated store. In order:
//  1. read and check the export directory;
//  2. check the engines (a problem fails the build);
//  3. the skip check: a current store with the same skip key is kept, and the attempt says so;
//  4. the sandbox: unless this run is already inside one, re-run inside the strongest one the
//     machine has, building in this build's work directory, the one path the sandbox can write;
//     then check what that run left there, and go on at the swap with its store;
//  5. remove what dead builds left, and make this build's work directory;
//  6. run the engines: ast-grep, dependency-cruiser, grimp, scip-typescript, then scip-python,
//     each when its detail and its input allow. A failed or timed-out engine degrades to its
//     fallback, and an engine that cannot run here (grimp without Python) falls back, except
//     ast-grep, whose outline mints every definition ID: its failure fails the build;
//  7. merge their facts, the two SCIP indexes' as one, compute the metrics, the coverage and
//     the gates;
//  8. write the store to store.tmp-<pid>.sqlite;
//  9. open it, and decide on its gates: a failed gate deletes it;
// 10. swap it in, keeping the previous store, then write build.json and the attempt.
// markStage records each stage as a provisional failed attempt, so that a build that dies is
// explained. Any error removes this build's temporary files, records the attempt as failed,
// and is thrown again. Every reason and warning the build writes is cleaned first: each of its
// directories, and the home directory, named by token, and every secret redacted.
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import {
  defaultEnginesDir,
  type EngineLock,
  readInstalled,
  readLock,
  verifyEngines,
} from "../engines/index.js";
import { removeTree } from "../export/index.js";
import { type Detail, type EngineName, LANG_BY_EXT } from "../model/index.js";
import { homeRoot, textCleaner } from "../redact/index.js";
import {
  type BuildFacts,
  besideStore,
  type Coverage,
  type GateResult,
  type MetaRow,
  openStore,
  SCHEMA_VERSION,
  type StoreMeta,
  writeAttempt,
  writeBuildFacts,
  writeStore,
} from "../store/index.js";
import { HAKUTAKU_VERSION } from "../version.js";
import { cgroupOf, memoryPeak } from "./cgroup.js";
import type { EngineDriver, ExtractContext } from "./context.js";
import { astGrepDriver } from "./drivers/ast-grep.js";
import { depcruiseDriver } from "./drivers/depcruise.js";
import { grimpDriver } from "./drivers/grimp.js";
import { scipPythonDriver } from "./drivers/scip-python.js";
import { heapMiB, scipTypescriptDriver } from "./drivers/scip-typescript.js";
import { readExportDir, snapshotReader } from "./export-dir.js";
import { runGates, storedTexts } from "./gates.js";
import { regularPaths } from "./merge/files.js";
import { coverageOf, type MergeInput, mergeFacts } from "./merge/index.js";
import { computeMetrics } from "./metrics.js";
import { extractInSandbox } from "./rerun.js";
import {
  buildRoots,
  EngineFailure,
  type EngineRun,
  type EngineRunResult,
  runEngine,
} from "./run.js";
import {
  detectSandbox,
  noSandboxEvidence,
  noSandboxReason,
  type Sandbox,
} from "./sandbox.js";
import { joinScipFacts } from "./scip/facts.js";
import { matchesStore, skipKey } from "./skip.js";
import { cleanupStale, markStage, swapIn } from "./swap.js";

export type SandboxMode = "auto" | "require" | "none";

export interface ExtractOptions {
  dir: string; // the export directory
  out: string; // the store.sqlite path
  enginesDir?: string; // defaultEnginesDir()
  detail?: Detail; // "standard"
  noSource?: boolean;
  sandbox?: SandboxMode; // "auto"
  memoryMax?: string; // systemd's MemoryMax syntax; defaultMemoryMax(detail)
  // The sandbox this run is already inside. A sandboxed re-run is given it, so that it runs no
  // sandbox of its own and build.json names the real one.
  sandboxedBy?: "bubblewrap" | "systemd-run";
  // Whether whatever this run is inside caps its memory at memoryMax, as a sandboxed re-run is
  // told when its sandbox does: only then is an engine killed for want of memory said to have
  // reached the cap.
  memoryCapped?: boolean;
  // The user's home directory, which the build's texts name as ~: this process's when absent. A
  // sandboxed re-run is given the outer one's, since inside bubblewrap HOME is the sandbox's.
  home?: string;
  // The current store's unresolved relative imports, which the unresolved-imports gate must not
  // pass: read from the store at out when absent. A sandboxed re-run is given them, since it
  // builds in a work directory and cannot read the store.
  currentUnresolved?: number;
}

export interface ExtractResult {
  result: "built" | "skipped" | "gates-failed";
  commit: string;
  contentHash: string | null; // the store's; null when the gates failed
  reason?: string; // the failed gates, as "<gate>: <detail>" joined by "; "
  gates: GateResult[];
}

// The points a build passes, at fixed places:
// - engine:<name>, right after that engine is spawned, while it runs;
// - write-store, once store.tmp-<pid>.sqlite is written;
// - gates, once the stage reads "checking the gates", before any gate is acted on;
// - swap, once the stage reads "swapping the store", right before the swap.
// The first three fire in the process that builds: inside the sandbox when there is one, so a
// caller that needs them passes sandbox "none". swap fires in this process, which always does
// the swap itself.
export type ExtractStage =
  | `engine:${EngineName}`
  | "write-store"
  | "gates"
  | "swap";

export interface ExtractHooks {
  onStage?(stage: ExtractStage): void;
  // Every engine's timeout in place of its detail's, so that a test can time one out quickly.
  engineTimeoutMs?: number;
}

const DEFAULT_MEMORY_MAX = "3G";
// Deep detail's cap. scip-python's memory grows with the Python it reads, far past the default
// cap on a large repo; the sandbox allows no swap, so a build that reaches the cap fails at once
// instead of crawling on.
const DEEP_MEMORY_MAX = "15G";
const DETAILS: readonly Detail[] = ["quick", "standard", "deep"];
const SANDBOX_MODES: readonly SandboxMode[] = ["auto", "require", "none"];
const SANDBOX_KINDS: readonly string[] = ["bubblewrap", "systemd-run"];
const DETAIL_RANK: Readonly<Record<Detail, number>> = {
  quick: 0,
  standard: 1,
  deep: 2,
};

// The engines in the order they run.
const DRIVERS: readonly EngineDriver<unknown>[] = [
  astGrepDriver,
  depcruiseDriver,
  grimpDriver,
  scipTypescriptDriver,
  scipPythonDriver,
];

// The memory cap a build of this detail takes when none is given: 3G, and 15G at deep detail.
export function defaultMemoryMax(detail: Detail): string {
  return detail === "deep" ? DEEP_MEMORY_MAX : DEFAULT_MEMORY_MAX;
}

type EngineFacts = NonNullable<BuildFacts["engines"][EngineName]>;

interface Options {
  dir: string;
  out: string;
  enginesDir: string;
  detail: Detail;
  noSource: boolean;
  sandbox: SandboxMode;
  memoryMax: string;
  sandboxedBy: "bubblewrap" | "systemd-run" | undefined;
  memoryCapped: boolean;
  home: string | null;
  currentUnresolved: number | null;
  tmp: string;
  work: string;
  clean: (text: string) => string; // a reason or a warning, as the build writes it
}

// What a build that reached the swap hands to its last step. peakRssBytes is known when the
// build ran in a sandbox; otherwise the last step reads it.
interface Swapped {
  commit: string;
  ref: string;
  contentHash: string;
  gates: GateResult[];
  sandbox: BuildFacts["sandbox"];
  engines: BuildFacts["engines"];
  warnings: string[];
  peakRssBytes?: number | null;
}

export async function extractSnapshot(
  opts: ExtractOptions,
  hooks: ExtractHooks = {},
): Promise<ExtractResult> {
  const startedAt = new Date();
  const started = performance.now();
  const o = optionsOf(opts);
  const known: { commit: string | null } = { commit: null };
  let swapped: Swapped;
  try {
    const outcome = await build(o, hooks, known);
    if ("result" in outcome) return outcome;
    swapped = outcome;
  } catch (error) {
    // The error goes on to the caller cleaned as the attempt is, so that whatever prints or
    // keeps it names no path on this machine and no secret. It is cleaned in place, which keeps
    // its class and fields, such as whether a sandboxed run printed it.
    if (error instanceof Error) {
      try {
        error.message = o.clean(error.message);
      } catch {
        // a message that cannot be set is left as it is
      }
    }
    try {
      rmSync(o.tmp, { force: true });
      rmSync(`${o.tmp}-journal`, { force: true });
      removeTree(o.work);
    } catch {
      // the next build's cleanupStale removes what is left
    }
    if (known.commit !== null) {
      try {
        writeAttempt(o.out, {
          at: new Date().toISOString(),
          commit: known.commit,
          result: "failed",
          reason: o.clean(messageOf(error)),
        });
      } catch {
        // the build's own error says more
      }
    }
    throw error;
  }
  return finish(o, swapped, startedAt, started);
}

function optionsOf(opts: ExtractOptions): Options {
  const detail = opts.detail ?? "standard";
  if (!DETAILS.includes(detail)) {
    throw new Error(`not a detail: ${JSON.stringify(detail)}`);
  }
  const sandbox = opts.sandbox ?? "auto";
  if (!SANDBOX_MODES.includes(sandbox)) {
    throw new Error(`not a sandbox mode: ${JSON.stringify(sandbox)}`);
  }
  if (
    opts.sandboxedBy !== undefined &&
    !SANDBOX_KINDS.includes(opts.sandboxedBy)
  ) {
    throw new Error(`not a sandbox: ${JSON.stringify(opts.sandboxedBy)}`);
  }
  const memoryMax = opts.memoryMax ?? defaultMemoryMax(detail);
  // the cap systemd takes must also give Node a heap: no percentage, no "infinity"
  heapMiB(memoryMax);
  const currentUnresolved = opts.currentUnresolved ?? null;
  if (
    currentUnresolved !== null &&
    !(Number.isSafeInteger(currentUnresolved) && currentUnresolved >= 0)
  ) {
    throw new Error(
      `not a count of unresolved imports: ${JSON.stringify(currentUnresolved)}`,
    );
  }
  const out = resolve(opts.out);
  const beside = besideStore(out);
  const dir = resolve(opts.dir);
  const enginesDir = resolve(opts.enginesDir ?? defaultEnginesDir());
  const work = beside.work(process.pid);
  const home = opts.home ?? homeRoot();
  return {
    dir,
    out,
    enginesDir,
    detail,
    noSource: opts.noSource ?? false,
    sandbox,
    memoryMax,
    sandboxedBy: opts.sandboxedBy,
    memoryCapped: opts.memoryCapped ?? false,
    home,
    currentUnresolved,
    tmp: beside.tmp(process.pid),
    work,
    clean: textCleaner(
      buildRoots({
        snapshotDir: join(dir, "snapshot"),
        exportDir: dir,
        workDir: work,
        enginesDir,
        storeDir: beside.dir,
        home,
      }),
    ),
  };
}

// Steps 1 to 10's swap. It answers with the result of a build that ended before the swap, or
// with what the last step needs.
async function build(
  o: Options,
  hooks: ExtractHooks,
  known: { commit: string | null },
): Promise<ExtractResult | Swapped> {
  // 1.
  const { manifest, history, profile, rules, profileBytes, rulesBytes } =
    readExportDir(o.dir);
  const commit = manifest.commit;
  known.commit = commit;

  // 2.
  const verified = verifyEngines(o.enginesDir, {
    deep: o.detail === "deep",
    runVersions: false,
  });
  if (!verified.ok) {
    throw new Error(
      `the engines are not ready (${verified.problems.join("; ")}); run hakutaku engines install${
        o.detail === "deep" ? " --deep" : ""
      }`,
    );
  }
  const pythonPath = readInstalled(o.enginesDir)?.python ?? null;

  // 3.
  const key = skipKey(
    manifest,
    profileBytes,
    rulesBytes,
    o.detail,
    o.noSource,
    o.memoryMax,
  );
  const current = currentStore(o.out);
  const currentUnresolved =
    o.currentUnresolved ?? current?.meta.coverage.unresolvedImports ?? null;
  if (current !== null && matchesStore(key, current.meta)) {
    writeAttempt(o.out, {
      at: new Date().toISOString(),
      commit,
      result: "skipped",
    });
    return {
      result: "skipped",
      commit,
      contentHash: current.contentHash,
      gates: current.meta.gates,
    };
  }

  // 4.
  const warnings: string[] = [];
  let sandbox: BuildFacts["sandbox"];
  if (o.sandboxedBy !== undefined) {
    sandbox = o.sandboxedBy;
  } else if (o.sandbox === "none") {
    sandbox = "none";
  } else {
    const found = await detectSandbox();
    if (found !== null) {
      return await buildInSandbox(o, hooks, found, {
        commit,
        ref: manifest.ref,
        pythonPath,
        currentUnresolved,
      });
    }
    const why = await noSandboxReason();
    if (o.sandbox === "require") {
      // the repair lines, then each probe's evidence below them
      throw new Error(
        [`--sandbox require: ${why}`, ...(await noSandboxEvidence())].join(
          "\n",
        ),
      );
    }
    process.stderr.write(`hakutaku: ${why}; extracting without one\n`);
    warnings.push(`${why}; extracting without one`);
    sandbox = "unavailable";
  }

  // 5.
  const storeDir = besideStore(o.out).dir;
  mkdirSync(storeDir, { recursive: true });
  cleanupStale(storeDir);
  const results = new Map<EngineName, EngineRunResult>();
  const ctx: ExtractContext = {
    exportDir: o.dir,
    snapshotDir: join(o.dir, "snapshot"),
    workDir: o.work,
    enginesDir: o.enginesDir,
    detail: o.detail,
    noSource: o.noSource,
    profile,
    rules,
    manifest,
    pythonPath,
    memoryMax: o.memoryMax,
    memoryCapped: o.memoryCapped,
    storeDir,
    home: o.home,
    ...(hooks.engineTimeoutMs === undefined
      ? {}
      : { timeoutMs: hooks.engineTimeoutMs }),
    log: (line) => warnings.push(line),
    runner: async (run: EngineRun) => {
      const result = await runEngine({
        ...run,
        onSpawn: (pid) => {
          run.onSpawn?.(pid);
          hooks.onStage?.(`engine:${run.engine}`);
        },
      });
      results.set(run.engine, result);
      return result;
    },
  };
  const metadataOnly = new Set(manifest.metadataOnly.map((m) => m.path));
  const hasPython = regularPaths(manifest).some(
    (path) =>
      LANG_BY_EXT[posix.extname(path)] === "python" && !metadataOnly.has(path),
  );
  const choices = new Map(
    DRIVERS.map((d) => [d.name, choiceOf(d, ctx, hasPython)] as const),
  );
  const first = DRIVERS.find((d) => choices.get(d.name) === "run");
  markStage(
    o.out,
    commit,
    first === undefined ? "writing the store" : `running ${first.name}`,
  );
  mkdirSync(o.work);

  // 6.
  const tiers: Coverage["tiers"] = {};
  const engines: BuildFacts["engines"] = {};
  // the repair of each tier that failed for want of memory
  const outOfMemory: Partial<Record<EngineName, string>> = {};
  const runTier = async <T>(driver: EngineDriver<T>): Promise<T | null> => {
    const name = driver.name;
    const choice = choices.get(name) ?? "skipped";
    if (choice !== "run") {
      tiers[name] = choice;
      engines[name] = {
        status: choice,
        wallMs: 0,
        cpuMs: null,
        peakRssBytes: null,
        exitCode: null,
      };
      return null;
    }
    markStage(o.out, commit, `running ${name}`);
    const t = performance.now();
    try {
      const facts = await driver.run(ctx);
      tiers[name] = "ran";
      engines[name] = runFacts("ran", results.get(name), t);
      return facts;
    } catch (error) {
      if (name === "ast-grep") throw error;
      const result = results.get(name);
      tiers[name] = "failed";
      engines[name] = runFacts(
        result?.timedOut === true ? "timed-out" : "failed",
        result,
        t,
      );
      if (error instanceof EngineFailure && error.end.memory) {
        outOfMemory[name] = error.end.text;
      }
      warnings.push(messageOf(error));
      return null;
    }
  };
  const astGrep = await runTier(astGrepDriver);
  const depcruise = await runTier(depcruiseDriver);
  const grimp = await runTier(grimpDriver);
  const scip = await runTier(scipTypescriptDriver);
  const scipPython = await runTier(scipPythonDriver);

  // 7. The two SCIP indexes cover disjoint files, the TypeScript and JavaScript ones and the
  // Python ones, and the merge reads them as one.
  const input: MergeInput = {
    manifest,
    profile,
    rules,
    detail: o.detail,
    noSource: o.noSource,
    readSnapshot: snapshotReader(ctx.snapshotDir),
    astGrep,
    depcruise,
    scip: joinScipFacts(scip, scipPython),
    grimp,
    pythonResolver:
      tiers.grimp === "ran"
        ? "grimp"
        : hasPython
          ? "hakutaku-resolver"
          : "none",
  };
  const { content, side } = mergeFacts(input);
  warnings.push(...side.warnings);
  // null, not an empty set, when dependency-cruiser did not run: an empty set would count every
  // TypeScript and JavaScript cycle as a disagreement
  const { cycleDifferences, ...metrics } = computeMetrics(
    content,
    history,
    manifest.commitTime,
    depcruise === null ? null : depcruise.circular,
    {
      tiers,
      imports: astGrep?.imports ?? [],
      denylistExtra: profile.denylist.extra,
    },
  );
  const coverage: Coverage = {
    ...coverageOf({ input, content, side, tiers, cycleDifferences }),
    ...(Object.keys(outOfMemory).length === 0
      ? {}
      : { outOfMemory: { memoryMax: o.memoryMax, tiers: outOfMemory } }),
  };
  // The gates are part of the store's meta, so they are worked out here, over the rows about
  // to be written, and acted on once the written store opens. Their SCIP facts are
  // scip-typescript's alone: the TypeScript and JavaScript files it was given must each have a
  // document, and its symbols must each be one file's. A Python file's indexing is checked by
  // its module name, at every detail.
  const gates = runGates({
    files: content.files,
    regularPaths: regularPaths(manifest),
    metadataOnly: [...metadataOnly],
    python: profile.python,
    indexed: side.indexed,
    scip:
      scip === null
        ? null
        : { documents: scip.documents, duplicates: scip.duplicates },
    relative: side.relative,
    maxUnresolvedRelativeImports: profile.gates.maxUnresolvedRelativeImports,
    currentUnresolved,
    denylistExtra: profile.denylist.extra,
    redactions: side.redactions,
    texts: storedTexts(content),
  });
  const meta: MetaRow = {
    schema_version: SCHEMA_VERSION,
    hakutaku_version: HAKUTAKU_VERSION,
    repo_id: manifest.id,
    commit_sha: commit,
    commit_time: manifest.commitTime,
    detail: o.detail,
    no_source: o.noSource ? 1 : 0,
    engines: versionsThatRan(tiers, readLock().lock),
    engine_lock_hash: key.engineLockHash,
    profile_hash: key.profileHash,
    rules_hash: key.rulesHash,
    coverage,
    gates,
  };

  // 8.
  markStage(o.out, commit, "writing the store");
  const { contentHash } = writeStore(o.tmp, {
    meta: [meta],
    ...content,
    ...metrics,
    run: { ref: manifest.ref, built_at: new Date().toISOString() },
  });
  hooks.onStage?.("write-store");

  // 9.
  markStage(o.out, commit, "checking the gates");
  hooks.onStage?.("gates");
  const written = openStore(o.tmp);
  if ("code" in written) {
    throw new Error(`the new store does not open: ${written.reason}`);
  }
  const decided = written.meta.gates;
  written.close();
  const failed = decided.filter((g) => !g.ok);
  if (failed.length > 0) {
    rmSync(o.tmp, { force: true });
    removeTree(o.work);
    const reason = o.clean(
      failed.map((g) => `${g.gate}: ${g.detail}`).join("; "),
    );
    writeAttempt(o.out, {
      at: new Date().toISOString(),
      commit,
      result: "gates-failed",
      reason,
    });
    return {
      result: "gates-failed",
      commit,
      contentHash: null,
      reason,
      gates: decided,
    };
  }

  // 10.
  swapStage(o, hooks, commit, o.tmp);
  return {
    commit,
    ref: manifest.ref,
    contentHash,
    gates: decided,
    sandbox,
    engines,
    warnings,
  };
}

// Steps 5 to 9 inside the sandbox, and step 10's swap here. This process makes the work
// directory, the one path the sandbox can write, and the inner run builds its store there and
// never sees the store's directory; extractInSandbox checks what it left, and the store is
// swapped in from there. A run that failed is thrown as SandboxedRunFailed, whose message the
// caller records as the attempt's reason.
async function buildInSandbox(
  o: Options,
  hooks: ExtractHooks,
  sandbox: Sandbox,
  b: {
    commit: string;
    ref: string;
    pythonPath: string | null;
    currentUnresolved: number | null;
  },
): Promise<ExtractResult | Swapped> {
  const storeDir = besideStore(o.out).dir;
  mkdirSync(storeDir, { recursive: true });
  cleanupStale(storeDir);
  markStage(o.out, b.commit, `building in the ${sandbox} sandbox`);
  makeWorkDir(o.work);
  const built = await extractInSandbox({
    sandbox,
    dir: o.dir,
    work: o.work,
    commit: b.commit,
    enginesDir: o.enginesDir,
    detail: o.detail,
    noSource: o.noSource,
    memoryMax: o.memoryMax,
    pythonPath: b.pythonPath,
    home: o.home,
    currentUnresolved: b.currentUnresolved,
  });
  if (built.result === "gates-failed") {
    removeTree(o.work);
    const reason = o.clean(built.inner.reason ?? "the gates failed");
    writeAttempt(o.out, {
      at: new Date().toISOString(),
      commit: b.commit,
      result: "gates-failed",
      reason,
    });
    return { ...built.inner, reason };
  }
  swapStage(o, hooks, b.commit, built.store);
  return {
    commit: b.commit,
    ref: b.ref,
    contentHash: built.contentHash,
    gates: built.inner.gates,
    sandbox,
    engines: built.engines,
    warnings: built.warnings,
    peakRssBytes: built.peakRssBytes,
  };
}

// The build's work directory, made fresh for this user alone: never one that is already there,
// which something else may have put in its place.
function makeWorkDir(work: string): void {
  mkdirSync(work, { mode: 0o700 });
  chmodSync(work, 0o700);
}

// Step 10's swap: the stage is recorded and announced, then the store at tmp takes the current
// one's place.
function swapStage(
  o: Options,
  hooks: ExtractHooks,
  commit: string,
  tmp: string,
): void {
  markStage(o.out, commit, "swapping the store");
  hooks.onStage?.("swap");
  swapIn(tmp, o.out);
}

// After the swap the store is built, whatever happens next: a file that cannot be written is
// reported on stderr, never recorded as a failed attempt over a store that is in place.
function finish(
  o: Options,
  s: Swapped,
  startedAt: Date,
  started: number,
): ExtractResult {
  const finishedAt = new Date();
  const facts: BuildFacts = {
    commit: s.commit,
    ref: s.ref,
    contentHash: s.contentHash,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallMs: Math.round(performance.now() - started),
    peakRssBytes:
      s.peakRssBytes !== undefined
        ? s.peakRssBytes
        : s.sandbox === "systemd-run"
          ? ownPeak()
          : null,
    sandbox: s.sandbox,
    engines: s.engines,
    warnings: s.warnings.map(o.clean),
  };
  const steps: Array<[string, () => void]> = [
    ["write build.json", () => writeBuildFacts(o.out, facts)],
    [
      "record the attempt",
      () =>
        writeAttempt(o.out, {
          at: finishedAt.toISOString(),
          commit: s.commit,
          result: "built",
        }),
    ],
    ["remove the work directory", () => removeTree(o.work)],
  ];
  for (const [what, step] of steps) {
    try {
      step();
    } catch (error) {
      process.stderr.write(
        `hakutaku: the store is built, but extract could not ${what}: ${messageOf(error)}\n`,
      );
    }
  }
  return {
    result: "built",
    commit: s.commit,
    contentHash: s.contentHash,
    gates: s.gates,
  };
}

// Whether a driver runs, or why not: below its detail, or with no input, it is skipped; grimp
// without a Python falls back when there is Python to read.
function choiceOf(
  driver: EngineDriver<unknown>,
  ctx: ExtractContext,
  hasPython: boolean,
): "run" | "skipped" | "fallback" {
  if (DETAIL_RANK[ctx.detail] < DETAIL_RANK[driver.minDetail]) return "skipped";
  if (driver.name === "grimp" && ctx.pythonPath === null) {
    return hasPython ? "fallback" : "skipped";
  }
  return driver.applies(ctx) ? "run" : "skipped";
}

// An engine's line in build.json, from its run when it got that far.
function runFacts(
  status: EngineFacts["status"],
  result: EngineRunResult | undefined,
  started: number,
): EngineFacts {
  if (result === undefined) {
    return {
      status,
      wallMs: Math.round(performance.now() - started),
      cpuMs: null,
      peakRssBytes: null,
      exitCode: null,
    };
  }
  return {
    status,
    wallMs: result.wallMs,
    cpuMs: result.cpuMs,
    peakRssBytes: result.peakRssBytes,
    exitCode: result.exitCode,
  };
}

// The lock's version of each engine that ran.
function versionsThatRan(
  tiers: Coverage["tiers"],
  lock: EngineLock,
): MetaRow["engines"] {
  const versions: MetaRow["engines"] = {};
  for (const [name, tier] of Object.entries(tiers) as Array<
    [EngineName, string]
  >) {
    const version = lock.engines[name]?.version;
    if (tier === "ran" && version !== undefined) versions[name] = version;
  }
  return versions;
}

// The current store's meta and content hash, or null when there is none that opens.
function currentStore(
  out: string,
): { meta: StoreMeta; contentHash: string } | null {
  const store = openStore(out);
  if ("code" in store) return null;
  try {
    return { meta: store.meta, contentHash: store.run.contentHash };
  } finally {
    store.close();
  }
}

// Inside a systemd-run service the build is its own cgroup, whose peak it can read.
function ownPeak(): number | null {
  const cgroup = cgroupOf("self");
  return cgroup === null ? null : memoryPeak(cgroup);
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
