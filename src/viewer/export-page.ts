// The static export: one repo's map as one self-contained page, which requests nothing. The page
// holds its data in a JSON data block, written so that nothing in it can end the block, and runs
// the viewer's one script, under a CSP that allows exactly that script and the one style block by
// their hashes (inlineViewerHtml). The page holds the map with every outline, its history, the
// tools' own answers for each node, which its Agent tab shows, and the redacted sources when they
// are asked for and the repo shows them. It never imports the browser app: the calls are written
// here from the map's own IDs, as the Agent tab writes them, with the one callText.
import { open, rename, rm } from "node:fs/promises";
import {
  formatId,
  type Id,
  type NodeRef,
  type RepoId,
} from "../model/index.js";
import {
  ECOSYSTEMS,
  F,
  FLAG_SOURCE,
  historyData,
  INLINE_OUTLINES_UP_TO,
  type MapData,
  mapData,
  type SourceData,
  sourceData,
} from "../query/view/index.js";
import type { Store } from "../store/index.js";
import { type CallContext, type Host, runTool } from "../tools/index.js";
import { type AgentCall, callText } from "./call-text.js";
import { inlineViewerHtml } from "./inline.js";
import type { StaticBundle, StoredAnswer } from "./static-bundle.js";

export type { StaticBundle, StoredAnswer } from "./static-bundle.js";

// The page's data from the repo's store. The map holds every outline and the files that change
// together, whatever the repo's size. The answers stop above agentUpTo production files, 2,000
// unless given; the sources are there only when asked for and the repo shows them, and the map
// says whether the page holds them.
export function buildStaticBundle(
  host: Host,
  ctx: CallContext,
  repo: RepoId,
  opts: { withSource: boolean; agentUpTo?: number },
): StaticBundle {
  const store = host.open(ctx, repo);
  if ("code" in store) {
    throw new Error(
      store.code === "not_built"
        ? `${repo} has no usable store (${store.reason})`
        : `unknown repo ${repo}`,
    );
  }
  // One build for the whole page: every answer is read from the store the map comes from, with
  // the freshness the map gives, however often the repo is rebuilt while the page is written.
  const freshness = host.freshness(repo);
  const pinned: Host = {
    repos: (c) => host.repos(c),
    open: (c, r) => (r === repo ? store : host.open(c, r)),
    freshness: (r) => (r === repo ? freshness : host.freshness(r)),
    snippets: (r) => host.snippets(r),
    maxResultChars: host.maxResultChars,
  };
  const full = mapData(store, {
    stale: freshness.stale,
    snippets: host.snippets(repo),
    inlineUpTo: Number.POSITIVE_INFINITY,
  });
  const sources =
    opts.withSource && full.sources ? sourcesOf(store, full) : null;
  const map: MapData = { ...full, sources: sources !== null };
  const answers =
    map.counts.productionFiles > (opts.agentUpTo ?? INLINE_OUTLINES_UP_TO)
      ? null
      : answersOf(pinned, ctx, map);
  return {
    format: 1,
    map,
    history: historyData(store),
    sources,
    agent: answers,
  };
}

// Every stored source, by file ID: a file's store id is its place in the map plus one.
function sourcesOf(store: Store, map: MapData): Record<Id, SourceData> {
  const held: Array<[Id, SourceData]> = [];
  map.files.forEach((file, i) => {
    if ((file[F.flags] & FLAG_SOURCE) === 0) return;
    const source = sourceData(store, i + 1);
    if (source !== null) held.push([source.file, source]);
  });
  return Object.fromEntries(held);
}

// The answer for each node the page can select, by its ID: code_overview for each component,
// code_explain for each file and each definition, and code_references for each library, each
// asked with the repo first and then the node's full stable ID, as the Agent tab asks.
function answersOf(
  host: Host,
  ctx: CallContext,
  map: MapData,
): Record<Id, StoredAnswer> {
  const { repo, files, defs, components, externals } = map;
  const answers: Array<[Id, StoredAnswer]> = [];
  const ask = (
    tool: AgentCall["tool"],
    key: "component" | "target" | "symbol",
    ref: NodeRef,
  ): void => {
    const id = formatId(ref);
    answers.push([
      id,
      answerOf(host, ctx, { tool, args: { repo, [key]: id } }),
    ]);
  };
  for (const [path] of components) {
    // a component's path has no final "/" in the map, and the root's is "."
    ask("code_overview", "component", {
      kind: "directory",
      repo,
      path: `${path}/`,
    });
  }
  for (const file of files) {
    ask("code_explain", "target", { kind: "file", repo, path: file[F.path] });
  }
  defs.file.forEach((file, i) => {
    ask("code_explain", "target", {
      kind: "definition",
      repo,
      path: files[file][F.path],
      qualname: defs.name[i],
      ordinal: defs.ordinal[i],
    });
  });
  for (const [ecosystem, name] of externals) {
    ask("code_references", "symbol", {
      kind: "external",
      repo,
      ecosystem: ECOSYSTEMS[ecosystem],
      name,
    });
  }
  return Object.fromEntries(answers);
}

// What the tool answers for the call, as the viewer's API gives it: the answer as indented JSON,
// or the tool's error as indented JSON, as `hakutaku query` prints both.
function answerOf(host: Host, ctx: CallContext, call: AgentCall): StoredAnswer {
  const result = runTool(host, ctx, call.tool, call.args, (err) => {
    console.error("hakutaku viewer:", err);
  });
  return result.ok
    ? {
        call: callText(call),
        text: JSON.stringify(result.answer, null, 2),
        ok: true,
      }
    : {
        call: callText(call),
        text: JSON.stringify({ error: result.error }, null, 2),
        ok: false,
      };
}

// The JSON as the data block holds it: each "<", ">" and "&" as JSON's own escape for it, a
// backslash, "u" and four lower-case hex digits, which JSON reads back as the character. With no
// "<" left, nothing in the block can end it, open a comment or start a tag.
export function escapeForDataBlock(json: string): string {
  return json.replace(
    /[<>&]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// Writes the page to <file>.tmp-<pid>, then renames it over file, so that a reader finds the old
// page or the new one, never a part of either. What is at the temporary name is removed first,
// and the page is created only where nothing is, so a link left there is never written through.
// It fails, writing nothing, when the repo has no usable store, or when the viewer's script,
// styles or data could not go inline in one page.
export async function exportStaticPage(opts: {
  host: Host;
  ctx: CallContext;
  repo: RepoId;
  file: string;
  withSource: boolean;
}): Promise<void> {
  const bundle = buildStaticBundle(opts.host, opts.ctx, opts.repo, {
    withSource: opts.withSource,
  });
  const { html } = inlineViewerHtml(escapeForDataBlock(JSON.stringify(bundle)));
  const temporary = `${opts.file}.tmp-${process.pid}`;
  try {
    await rm(temporary, { force: true });
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(html, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temporary, opts.file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
