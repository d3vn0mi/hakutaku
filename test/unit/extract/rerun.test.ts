import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  type Stats,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  fileProblem,
  innerArgv,
  innerFailure,
  type Rerun,
  SandboxedRunFailed,
  takeBuilt,
} from "../../../src/extract/rerun.js";
import {
  type Attempt,
  type BuildFacts,
  MAX_JSON_BYTES,
  openStore,
  readBuildFacts,
  type Store,
  type StoreContent,
  writeBuildFacts,
} from "../../../src/store/index.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-rerun-"));
  made.push(dir);
  return dir;
};

const COMMIT = "a".repeat(40);

const rerun: Rerun = {
  sandbox: "bubblewrap",
  dir: "/srv/observatory/export",
  work: "/srv/observatory/store/work.tmp-4242",
  commit: COMMIT,
  enginesDir: "/srv/observatory/engines",
  detail: "standard",
  noSource: false,
  memoryMax: "3G",
  pythonPath: null,
  home: "/srv/astronomer",
  currentUnresolved: 3,
};

it("tells the sandboxed run to build in the work directory, whether its sandbox caps memory, the home directory to name ~, and the current store's unresolved imports", () => {
  const capped = innerArgv(rerun, true);
  expect(capped.slice(2)).toEqual([
    "extract",
    "/srv/observatory/export",
    "--out",
    "/srv/observatory/store/work.tmp-4242/store.sqlite",
    "--engines-dir",
    "/srv/observatory/engines",
    "--detail",
    "standard",
    "--sandbox",
    "none",
    "--sandboxed-by",
    "bubblewrap",
    "--memory-max",
    "3G",
    "--memory-capped",
    "--home",
    "/srv/astronomer",
    "--current-unresolved",
    "3",
  ]);
  const uncapped = innerArgv(
    { ...rerun, home: null, noSource: true, currentUnresolved: null },
    false,
  );
  expect(uncapped).not.toContain("--memory-capped");
  expect(uncapped).not.toContain("--home");
  expect(uncapped).not.toContain("--current-unresolved");
  expect(uncapped).toContain("--no-source");
  expect(innerArgv({ ...rerun, currentUnresolved: 0 }, true).slice(-2)).toEqual(
    ["--current-unresolved", "0"],
  );
});

const failed = (reason: string, commit = COMMIT): Attempt => ({
  at: "2026-11-21T10:00:00Z",
  commit,
  result: "failed",
  reason,
});

const ctx = {
  sandbox: "bubblewrap" as const,
  memoryCap: null,
  oomContinue: true,
  commit: COMMIT,
  draft: null,
};

it("takes the sandboxed run's own failed attempt, else the message it printed, to the end of the stderr seen", () => {
  const tail =
    "grimp: left out the package sky\nhakutaku: ast-grep failed: ERROR: web/a.ts\ndenied\n";
  const ended = { code: 1, signal: null, stderrTail: tail, oomKilled: null };
  expect(innerFailure(ended, ctx)).toEqual({
    message: "ast-grep failed: ERROR: web/a.ts\ndenied",
    printed: true,
  });
  // the attempt it recorded holds the whole message, which the tail may have cut
  expect(
    innerFailure(ended, {
      ...ctx,
      draft: failed("ast-grep failed: ERROR: web/a.ts\ndenied\nand more"),
    }),
  ).toEqual({
    message: "ast-grep failed: ERROR: web/a.ts\ndenied\nand more",
    printed: true,
  });
  // an attempt for another commit, or one still provisional, is not the run's own reason
  for (const draft of [
    failed("planted", "b".repeat(40)),
    failed("interrupted or still running (pid 2): running ast-grep"),
    { ...failed("x"), result: "built" as const },
  ]) {
    expect(innerFailure(ended, { ...ctx, draft }).message).toBe(
      "ast-grep failed: ERROR: web/a.ts\ndenied",
    );
  }
});

it("words how the sandboxed run ended when it printed nothing, naming the stage its last attempt records", () => {
  const stopped = (
    code: number | null,
    signal: string | null,
    more: Partial<Parameters<typeof innerFailure>[1]> & {
      oomKilled?: boolean | null;
      stderrTail?: string;
    } = {},
  ) =>
    innerFailure(
      {
        code,
        signal,
        stderrTail: more.stderrTail ?? "",
        oomKilled: more.oomKilled ?? null,
      },
      { ...ctx, ...more },
    );
  const atStage = failed(
    "interrupted or still running (pid 2): running scip-typescript",
  );
  // bubblewrap exits 128 + N for a run a signal stopped
  expect(stopped(143, null, { draft: atStage })).toEqual({
    message:
      "the sandboxed extract failed while running scip-typescript: stopped by SIGTERM",
    printed: false,
  });
  expect(stopped(137, null).message).toBe(
    "the sandboxed extract failed: stopped by SIGKILL",
  );
  // the cap is said only where an OOM kill was counted
  const cap =
    "the sandboxed extract failed: reached the 3G memory cap; rebuild with a larger --memory-max";
  expect(stopped(137, null, { memoryCap: "3G", oomKilled: true }).message).toBe(
    cap,
  );
  // a SIGKILL that no count can tell from another under a memory cap names the cap only as one
  // possible cause, with its repair
  const maybeCap =
    "the sandboxed extract failed: stopped by SIGKILL; if that was the 3G memory cap, rebuild with a larger --memory-max";
  expect(stopped(137, null, { memoryCap: "3G" }).message).toBe(maybeCap);
  expect(
    stopped(137, null, { memoryCap: "3G", oomKilled: false }).message,
  ).toBe("the sandboxed extract failed: stopped by SIGKILL");
  // the sandbox command itself stopped by a signal
  expect(
    stopped(null, "SIGKILL", { memoryCap: "3G", oomKilled: true }).message,
  ).toBe(cap);
  expect(stopped(null, "SIGKILL", { memoryCap: "3G" }).message).toBe(maybeCap);
  // systemd-run exits 255 for a service whose main process a signal stopped, as the kernel's
  // kill at the cap does under OOMPolicy=continue, and 1 for one that failed otherwise, as an
  // OOM kill that stops the service does without it
  expect(
    stopped(255, null, { sandbox: "systemd-run", memoryCap: "3G" }).message,
  ).toBe(maybeCap);
  expect(
    stopped(255, null, {
      sandbox: "systemd-run",
      memoryCap: "3G",
      draft: atStage,
    }).message,
  ).toBe(
    "the sandboxed extract failed while running scip-typescript: stopped by SIGKILL; if that was the 3G memory cap, rebuild with a larger --memory-max",
  );
  expect(stopped(1, null, { sandbox: "systemd-run" }).message).toBe(
    "the sandboxed extract failed: exit code 1",
  );
  // under OOMPolicy=continue the cap never stops the service; without it, an exit 1 may be the
  // cap's
  expect(
    stopped(1, null, { sandbox: "systemd-run", memoryCap: "3G" }).message,
  ).toBe("the sandboxed extract failed: exit code 1");
  expect(
    stopped(1, null, {
      sandbox: "systemd-run",
      memoryCap: "3G",
      oomContinue: false,
    }).message,
  ).toBe(
    "the sandboxed extract failed: exit code 1; if that was the 3G memory cap, rebuild with a larger --memory-max",
  );
  expect(
    stopped(1, null, { memoryCap: "3G", oomContinue: false }).message,
  ).toBe("the sandboxed extract failed: exit code 1");
  // another signal, or no cap, names no cap
  expect(stopped(143, null, { memoryCap: "3G" }).message).toBe(
    "the sandboxed extract failed: stopped by SIGTERM",
  );
  expect(stopped(255, null, { sandbox: "systemd-run" }).message).toBe(
    "the sandboxed extract failed: stopped by SIGKILL",
  );
  expect(stopped(200, null).message).toBe(
    "the sandboxed extract failed: exit code 200",
  );
  // "hakutaku: " inside a line is not the CLI's message
  expect(
    stopped(1, null, { stderrTail: "a note from hakutaku: none\nKilled\n" }),
  ).toEqual({
    message: "the sandboxed extract failed: exit code 1",
    printed: false,
  });
  // a stage is named only as a build records it, and only for this commit
  for (const draft of [
    failed("interrupted or still running (pid 2): running rm -rf ~"),
    failed(
      "interrupted or still running (pid 2): running scip-typescript",
      "b".repeat(40),
    ),
  ]) {
    expect(stopped(143, null, { draft }).message).toBe(
      "the sandboxed extract failed: stopped by SIGTERM",
    );
  }
  expect(
    stopped(143, null, {
      draft: failed("interrupted or still running (pid 2): writing the store"),
    }).message,
  ).toBe(
    "the sandboxed extract failed while writing the store: stopped by SIGTERM",
  );
});

// A work directory as a built inner run leaves it: the gated store, of the commit the store's
// meta names, and its build facts.
function builtWork(content: StoreContent = emptyContent()): {
  work: string;
  contentHash: string;
  commit: string;
} {
  const work = join(tmp(), "work.tmp-4242");
  mkdirSync(work);
  copyFileSync(miniStore(content), join(work, "store.sqlite"));
  const store = openStore(join(work, "store.sqlite")) as Store;
  const { commit } = store.meta;
  const { contentHash } = store.run;
  store.close();
  const facts: BuildFacts = {
    commit,
    ref: "HEAD",
    contentHash,
    startedAt: "2026-11-21T10:00:00Z",
    finishedAt: "2026-11-21T10:00:05Z",
    wallMs: 5000,
    peakRssBytes: 123,
    sandbox: "bubblewrap",
    engines: {},
    warnings: ["grimp: left out the package sky"],
  };
  writeBuildFacts(join(work, "store.sqlite"), facts);
  return { work, contentHash, commit };
}

const refusedFor = (
  w: { work: string; contentHash: string; commit: string },
  reported: Partial<{ commit: string; contentHash: string }> = {},
): string => {
  try {
    takeBuilt(w.work, {
      commit: reported.commit ?? w.commit,
      contentHash: reported.contentHash ?? w.contentHash,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxedRunFailed);
    expect((error as SandboxedRunFailed).printed).toBe(false);
    return (error as Error).message;
  }
  throw new Error("not refused");
};

it("takes a built run's store and build facts from the work directory", () => {
  const w = builtWork();
  const taken = takeBuilt(w.work, w);
  expect(taken.store).toBe(join(w.work, "store.sqlite"));
  expect(taken.facts).toMatchObject({
    commit: w.commit,
    contentHash: w.contentHash,
    peakRssBytes: 123,
    warnings: ["grimp: left out the package sky"],
  });
});

// Every process in the sandbox can write the work directory, so nothing in it is used before it
// is shown to be a regular file of this user's, with one name, and the store and the facts the
// run reported.
it.skipIf(process.platform === "win32")(
  "refuses a store that is a link, not a regular file, a second name, missing or not the one reported",
  () => {
    const link = builtWork();
    const elsewhere = join(tmp(), "store.sqlite");
    copyFileSync(join(link.work, "store.sqlite"), elsewhere);
    rmSync(join(link.work, "store.sqlite"));
    symlinkSync(elsewhere, join(link.work, "store.sqlite"));
    expect(refusedFor(link)).toBe(
      "the sandboxed build's store.sqlite is refused: it is a link",
    );

    const fifo = builtWork();
    rmSync(join(fifo.work, "store.sqlite"));
    execFileSync("mkfifo", [join(fifo.work, "store.sqlite")]);
    expect(refusedFor(fifo)).toBe(
      "the sandboxed build's store.sqlite is refused: it is not a regular file",
    );

    const named = builtWork();
    linkSync(join(named.work, "store.sqlite"), join(named.work, "other"));
    expect(refusedFor(named)).toBe(
      "the sandboxed build's store.sqlite is refused: it has more than one name",
    );

    const missing = builtWork();
    rmSync(join(missing.work, "store.sqlite"));
    expect(refusedFor(missing)).toBe(
      "the sandboxed build's store.sqlite is refused: it is missing",
    );

    const other = builtWork();
    expect(refusedFor(other, { contentHash: "0".repeat(64) })).toBe(
      "the sandboxed build's store.sqlite is refused: it is not the store the sandboxed extract reported",
    );
    expect(refusedFor(other, { commit: COMMIT })).toBe(
      "the sandboxed build's store.sqlite is refused: it is not the store the sandboxed extract reported",
    );

    // a store whose gates did not all pass is never swapped in, whatever the run reported
    const content = emptyContent();
    const [meta] = content.meta;
    if (meta === undefined) throw new Error("no meta row");
    meta.gates = meta.gates.map((g) =>
      g.gate === "denylist"
        ? { ...g, ok: false, detail: "1 denied path in the store" }
        : g,
    );
    expect(refusedFor(builtWork(content))).toBe(
      "the sandboxed build's store.sqlite is refused: it is not the store the sandboxed extract reported",
    );

    const broken = builtWork();
    writeFileSync(join(broken.work, "store.sqlite"), "not a store");
    expect(refusedFor(broken)).toBe(
      "the sandboxed build's store.sqlite is refused: it does not open (store unreadable)",
    );
  },
);

it.skipIf(process.platform === "win32")(
  "refuses build facts that are a link, too large, missing or not the build reported",
  () => {
    const link = builtWork();
    const facts = join(link.work, "build.json");
    const elsewhere = join(tmp(), "build.json");
    copyFileSync(facts, elsewhere);
    rmSync(facts);
    symlinkSync(elsewhere, facts);
    expect(refusedFor(link)).toBe(
      "the sandboxed build's build.json is refused: it is a link",
    );

    const large = builtWork();
    writeFileSync(
      join(large.work, "build.json"),
      " ".repeat(MAX_JSON_BYTES + 1),
    );
    expect(refusedFor(large)).toBe(
      `the sandboxed build's build.json is refused: it is larger than ${MAX_JSON_BYTES} bytes`,
    );

    const missing = builtWork();
    rmSync(join(missing.work, "build.json"));
    expect(refusedFor(missing)).toBe(
      "the sandboxed build's build.json is refused: it is missing",
    );

    const other = builtWork();
    writeFileSync(join(other.work, "build.json"), "{}");
    expect(refusedFor(other)).toBe(
      "the sandboxed build's build.json is refused: it is not the build facts of the store reported",
    );

    // the facts of another store of the same commit
    const another = builtWork();
    const read = readBuildFacts(join(another.work, "store.sqlite"));
    if (read === null) throw new Error("no build facts");
    writeBuildFacts(join(another.work, "store.sqlite"), {
      ...read,
      contentHash: "0".repeat(64),
    });
    expect(refusedFor(another)).toBe(
      "the sandboxed build's build.json is refused: it is not the build facts of the store reported",
    );
  },
);

it("refuses a file another user owns, or one larger than its limit", () => {
  const dir = tmp();
  const file = join(dir, "store.sqlite");
  writeFileSync(file, "0123456789");
  const own = lstatSync(file);
  expect(fileProblem(own, 10)).toBeNull();
  expect(fileProblem(own, 9)).toBe("is larger than 9 bytes");
  const theirs: Stats = Object.assign(
    Object.create(Object.getPrototypeOf(own)),
    own,
    { uid: own.uid + 1 },
  );
  expect(fileProblem(theirs, 10)).toBe("is not owned by this user");
});
