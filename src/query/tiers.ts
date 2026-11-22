// Compiler tiers: whether a compiler-backed engine ran for a language in this build, what
// code_explain's label and note say about how a definition's users were found, and the blind
// spots of the answers about callers, references, imports, paths and text.
import type { Label, Lang } from "../model/index.js";
import type { Store } from "../store/index.js";
import type { DefInfo } from "./store-index.js";

// How a note names the languages a compiler tier covers. Any other language goes by its id.
export const LANG_DISPLAY: Readonly<Record<string, string>> = Object.freeze({
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
});

export function displayLang(lang: Lang | null): string {
  if (lang === null) return "unknown";
  // an own key only: a language id such as "constructor" is not a display name
  return Object.hasOwn(LANG_DISPLAY, lang) ? LANG_DISPLAY[lang] : lang;
}

export type CompilerTier = { ran: true } | { ran: false; reason: string };

// Whether the compiler tier for lang ran in the store's build, and, when it did not, why. A tier
// that ran out of memory says so, with its repair, where any other failed tier fell back.
export function compilerTier(store: Store, lang: Lang | null): CompilerTier {
  const { detail, coverage } = store.meta;
  const fellBack = (engine: "scip-typescript" | "scip-python"): string => {
    const why = coverage.outOfMemory?.tiers[engine];
    return why === undefined ? `${engine} fell back` : `${engine} ${why}`;
  };
  if (lang === "typescript" || lang === "javascript") {
    if (coverage.tiers["scip-typescript"] === "ran") return { ran: true };
    return {
      ran: false,
      reason: detail === "quick" ? "quick detail" : fellBack("scip-typescript"),
    };
  }
  if (lang === "python") {
    if (coverage.tiers["scip-python"] === "ran") return { ran: true };
    return {
      ran: false,
      reason:
        detail === "quick"
          ? "quick detail"
          : detail === "standard"
            ? "below deep detail"
            : fellBack("scip-python"),
    };
  }
  return { ran: false, reason: "no compiler tier for this language" };
}

const UNUSED = "no other production file uses it";
const BOUND =
  "every counted file has a compiler-bound use; code_callers lists each use with its line";
const SCOPED =
  "includes files that use the name inside files importing its module, without a compiler binding; code_callers labels each use";

// A definition's label and note in code_explain: the first case that applies decides.
export function explainLabel(
  store: Store,
  def: DefInfo,
  lang: Lang | null,
): { label: "bound" | "scoped"; note: string } {
  if (def.usedByFiles === 0) {
    const tier = compilerTier(store, lang);
    if (tier.ran) return { label: "bound", note: UNUSED };
    return {
      label: "scoped",
      note: `no other production file uses it by name in files that import its module; no compiler ran for ${displayLang(lang)} in this build (${tier.reason}), so check code_callers' unscoped matches`,
    };
  }
  if (def.usedByFilesBound === def.usedByFiles) {
    return { label: "bound", note: BOUND };
  }
  return { label: "scoped", note: SCOPED };
}

// The languages whose callers hakutaku extracts.
const CALLER_LANGS: ReadonlySet<string> = new Set([
  "typescript",
  "javascript",
  "python",
  "shell",
]);

// The languages whose dynamic imports can have a computed path, and those a compiler tier
// covers.
const isScript = (lang: Lang | null): boolean =>
  lang === "typescript" || lang === "javascript";
const isCompiled = (lang: Lang | null): boolean =>
  isScript(lang) || lang === "python";

// The wording of the blind-spot lines, which the functions below and BLIND_SPOT_LINES both build
// their lines from.

// A count line in both its forms, each in full, since the singular changes more than "is" and
// "are": "1 <one>" at 1, "<n> <many>" otherwise.
interface CountLine {
  one: string;
  many: string;
}

// A count, or the placeholder that stands for one in BLIND_SPOT_LINES.
type Count = number | "<n>";

function counted(n: Count, line: CountLine): string {
  return n === 1 ? `1 ${line.one}` : `${n} ${line.many}`;
}

// A compiler tier that did not run for a language, by its display name, then what that leaves
// out of the answer.
function noCompiler(language: string, reason: string, so: string): string {
  return `no compiler ran for ${language} in this build (${reason}), so ${so}`;
}
const NO_SITE = "no site is bound";
const NO_REFERENCE = "no reference is recorded";

const COMPUTED: CountLine = {
  one: "dynamic import with a computed path is not followed",
  many: "dynamic imports with a computed path are not followed",
};

// How the computed-import line ends in an answer about callers: by the labels asked for, or, from
// a tool that takes no labels, by naming code_callers. In an answer about a file or a call path
// it ends at "not followed".
const COMPUTED_ENDING = Object.freeze({
  noLabels: '; code_callers lists name matches with labels ["unscoped"]',
  withUnscoped: "; the unscoped matches include calls made through them",
  withoutUnscoped: '; ask with labels ["unscoped"] to see name matches',
});

// A count in parentheses, plural even at 1.
function unmatchedBoundUses(n: Count): string {
  return `compiler-bound uses that match no outline definition are counted in coverage only (${n})`;
}

const OWN_RESOLVER =
  "Python imports come from hakutaku's own resolver, because grimp did not run";
const NOT_READ = "Python imports were not read in this build";
const RESOLVED_PYTHON: CountLine = {
  one: "Python file has imports that come from hakutaku's own resolver, not grimp",
  many: "Python files have imports that come from hakutaku's own resolver, not grimp",
};
const RESOLVED_SCRIPTS: CountLine = {
  one: "TypeScript or JavaScript file has imports that come from hakutaku's own resolver, not dependency-cruiser",
  many: "TypeScript and JavaScript files have imports that come from hakutaku's own resolver, not dependency-cruiser",
};

const noCallers = (lang: Lang): string =>
  `hakutaku extracts no callers for ${lang}`;
const SHELL_CALLERS =
  "shell callers are name matches in the file and the files that source it";
const noReferences = (lang: Lang): string =>
  `hakutaku records no references for ${lang}`;

const UNRESOLVED: CountLine = {
  one: "relative import did not resolve to a file and is not an edge",
  many: "relative imports did not resolve to a file and are not edges",
};
const DENIED_WITH_IMPORTS: CountLine = {
  one: "denylisted file is left out of the map, with its imports",
  many: "denylisted files are left out of the map, with their imports",
};

const NO_SOURCE = "this map stores no source text, so no file is searched";
const NO_SOURCE_FILES: CountLine = {
  one: "file over 1 MB, minified or generated keeps no stored text and is not searched",
  many: "files over 1 MB, minified or generated keep no stored text and are not searched",
};
const DENIED: CountLine = {
  one: "denylisted file is left out of the map",
  many: "denylisted files are left out of the map",
};
const SPANS: CountLine = { one: "span", many: "spans" };

function redactedSpans(n: Count): string {
  return `secret-shaped text is redacted (${counted(n, SPANS)} across the map), so it cannot be found`;
}

// The count of files with at least one import that hakutaku's own resolver read, for Python or
// for TypeScript and JavaScript together, taken from the store once for each Store object
// (src/extract/merge/imports.ts says which imports are the resolver's). While grimp runs, the
// resolver reads every import of a Python file grimp did not read, and, in a file grimp read, a
// dynamic import and an import of a module grimp did not report on the same line. While
// dependency-cruiser runs, it reads every import of a TypeScript or JavaScript file
// dependency-cruiser did not list, and an import it gave no edge; when dependency-cruiser did not
// run, every import scip-typescript did not resolve. So a counted file may hold an engine's
// imports as well, and a line says only that some of its imports are the resolver's.
const RESOLVED_SQL = {
  python:
    "SELECT COUNT(DISTINCT i.src_file_id) AS n FROM imports AS i JOIN files AS f ON f.id = i.src_file_id WHERE f.lang = 'python' AND i.producer = 'hakutaku-resolver'",
  scripts:
    "SELECT COUNT(DISTINCT i.src_file_id) AS n FROM imports AS i JOIN files AS f ON f.id = i.src_file_id WHERE f.lang IN ('typescript', 'javascript') AND i.producer = 'hakutaku-resolver'",
} as const;
const resolvedCounts = new WeakMap<
  Store,
  Partial<Record<keyof typeof RESOLVED_SQL, number>>
>();

function resolvedFiles(store: Store, group: keyof typeof RESOLVED_SQL): number {
  let held = resolvedCounts.get(store);
  if (held === undefined) {
    held = {};
    resolvedCounts.set(store, held);
  }
  let n = held[group];
  if (n === undefined) {
    n = Number(store.db.prepare(RESOLVED_SQL[group]).get()?.n ?? 0);
    held[group] = n;
  }
  return n;
}

// The line a TypeScript or JavaScript answer gets: the count of those files with imports from
// the resolver, or no line when no file has one.
function resolvedScriptLines(store: Store): string[] {
  const n = resolvedFiles(store, "scripts");
  if (n === 0) return [];
  return [counted(n, RESOLVED_SCRIPTS)];
}

// The line a Python answer gets when grimp ran: the count of Python files with imports from the
// resolver, or no line when no file has one.
function resolvedPythonLines(store: Store): string[] {
  const n = resolvedFiles(store, "python");
  if (n === 0) return [];
  return [counted(n, RESOLVED_PYTHON)];
}

// What an answer about callers cannot see in this build, one line per gap, in a fixed order.
// labels are the labels asked for, given only by a tool that takes them. Without them, the
// computed-import line names code_callers, which lists those name matches, so an answer of a
// tool that takes no labels never asks for them. fileTarget marks an answer about a file or a
// call path, whose computed-import line ends at "not followed".
export function blindSpots(
  store: Store,
  lang: Lang | null,
  opts: { labels?: readonly Label[]; fileTarget?: boolean },
): string[] {
  const { coverage } = store.meta;
  const out: string[] = [];
  if (isCompiled(lang)) {
    const tier = compilerTier(store, lang);
    if (!tier.ran) {
      out.push(noCompiler(displayLang(lang), tier.reason, NO_SITE));
    }
  }
  if (lang === "python") {
    if (coverage.pythonResolver === "hakutaku-resolver") out.push(OWN_RESOLVER);
    else if (coverage.pythonResolver === "grimp") {
      out.push(...resolvedPythonLines(store));
    }
  }
  if (isScript(lang)) out.push(...resolvedScriptLines(store));
  if (lang !== null && !CALLER_LANGS.has(lang)) out.push(noCallers(lang));
  if (lang === "shell") out.push(SHELL_CALLERS);
  const computed = coverage.computedImports;
  if (isScript(lang) && computed > 0) {
    const line = counted(computed, COMPUTED);
    if (opts.fileTarget === true) out.push(line);
    else if (opts.labels === undefined) {
      out.push(`${line}${COMPUTED_ENDING.noLabels}`);
    } else if (opts.labels.includes("unscoped")) {
      out.push(`${line}${COMPUTED_ENDING.withUnscoped}`);
    } else {
      out.push(`${line}${COMPUTED_ENDING.withoutUnscoped}`);
    }
  }
  if (isCompiled(lang) && coverage.unmatchedBoundUses > 0) {
    out.push(unmatchedBoundUses(coverage.unmatchedBoundUses));
  }
  return out;
}

// What the references to a definition in lang cannot show, one line per gap, in a fixed order.
// References come only from a compiler tier, so a language without one records none.
export function referenceBlindSpots(store: Store, lang: Lang | null): string[] {
  const out: string[] = [];
  if (isCompiled(lang)) {
    const tier = compilerTier(store, lang);
    if (!tier.ran) {
      out.push(noCompiler(displayLang(lang), tier.reason, NO_REFERENCE));
    }
  } else if (lang !== null) {
    out.push(noReferences(lang));
  }
  const unmatched = store.meta.coverage.unmatchedBoundUses;
  if (isCompiled(lang) && unmatched > 0) {
    out.push(unmatchedBoundUses(unmatched));
  }
  return out;
}

// What the imports around a file in lang cannot show, in either direction, one line per gap, in
// a fixed order.
export function importBlindSpots(store: Store, lang: Lang | null): string[] {
  const { coverage } = store.meta;
  const out: string[] = [];
  if (isScript(lang) && coverage.computedImports > 0) {
    out.push(counted(coverage.computedImports, COMPUTED));
  }
  if (coverage.unresolvedImports > 0) {
    out.push(counted(coverage.unresolvedImports, UNRESOLVED));
  }
  if (lang === "python") {
    if (coverage.pythonResolver === "hakutaku-resolver") out.push(OWN_RESOLVER);
    else if (coverage.pythonResolver === "none") out.push(NOT_READ);
    else if (coverage.pythonResolver === "grimp") {
      out.push(...resolvedPythonLines(store));
    }
  }
  if (isScript(lang)) out.push(...resolvedScriptLines(store));
  if (coverage.denied > 0) {
    out.push(counted(coverage.denied, DENIED_WITH_IMPORTS));
  }
  return out;
}

// The links a call path never follows, since its walk takes only the bound and scoped calls the
// store holds: unscoped name matches, the scoped links code_callers works out at query time by
// following import chains, and references. Each line says which tool finds them.
const UNFOLLOWED: readonly string[] = Object.freeze([
  'unscoped name matches are not followed; code_callers lists them with labels ["unscoped"]',
  "scoped links that code_callers finds through import chains are not followed",
  "references, uses that are not calls, are not followed; code_references lists them",
]);

// What a path cannot see, from the language of its from node. Via imports, the lines of the
// imports around the from file. Via calls, those of the from definition's callers, then one
// line for each kind of link the walk does not follow.
export function pathBlindSpots(
  store: Store,
  via: "imports" | "calls",
  lang: Lang | null,
): string[] {
  if (via === "imports") return importBlindSpots(store, lang);
  return [...blindSpots(store, lang, { fileTarget: true }), ...UNFOLLOWED];
}

// What a search of the stored text cannot find, one line per gap, in a fixed order. A map with no
// source text answers code_search_text with no_source, so only a direct caller sees that line.
// The redaction count covers the whole map: stored text, and also signatures, import
// specifiers, library names, entry point names, call receivers and symbolic link targets. So the
// line gives it as a count across the map, not as a count of searched lines.
export function searchBlindSpots(store: Store): string[] {
  const { noSource, coverage } = store.meta;
  const out: string[] = [];
  if (noSource) out.push(NO_SOURCE);
  if (coverage.noSourceFiles > 0) {
    out.push(counted(coverage.noSourceFiles, NO_SOURCE_FILES));
  }
  if (coverage.denied > 0) out.push(counted(coverage.denied, DENIED));
  if (coverage.redactions > 0) out.push(redactedSpans(coverage.redactions));
  return out;
}

const N = "<n>";
const LANGUAGE = "<language>";
const WHY = "<why>";

// Every line a blindSpots list can carry, by the answers that carry it, as docs/tools.md lists
// them: a count as <n>, in the plural, though a count line reads in the singular at 1; a language
// as <language>, and a reason as <why>. Each is built from the wording the functions above build
// their lines from. searchBlindSpots' line for a map that stores no source text is left out:
// code_search_text answers no_source for such a map, so no answer carries that line.
export const BLIND_SPOT_LINES = Object.freeze({
  // code_callers, code_impact, and code_path via calls, from its from definition
  callers: Object.freeze([
    noCompiler(LANGUAGE, WHY, NO_SITE),
    OWN_RESOLVER,
    counted(N, RESOLVED_PYTHON),
    counted(N, RESOLVED_SCRIPTS),
    noCallers(LANGUAGE),
    SHELL_CALLERS,
    `${counted(N, COMPUTED)}${COMPUTED_ENDING.withoutUnscoped}`,
    `${counted(N, COMPUTED)}${COMPUTED_ENDING.withUnscoped}`,
    `${counted(N, COMPUTED)}${COMPUTED_ENDING.noLabels}`,
    counted(N, COMPUTED),
    unmatchedBoundUses(N),
  ]),
  // code_references for a definition
  references: Object.freeze([
    noCompiler(LANGUAGE, WHY, NO_REFERENCE),
    noReferences(LANGUAGE),
    unmatchedBoundUses(N),
  ]),
  // code_deps, and code_path via imports, from its from file
  imports: Object.freeze([
    counted(N, COMPUTED),
    counted(N, UNRESOLVED),
    OWN_RESOLVER,
    NOT_READ,
    counted(N, RESOLVED_PYTHON),
    counted(N, RESOLVED_SCRIPTS),
    counted(N, DENIED_WITH_IMPORTS),
  ]),
  // code_path via calls, after its from definition's lines
  unfollowed: UNFOLLOWED,
  // code_search_text
  search: Object.freeze([
    counted(N, NO_SOURCE_FILES),
    counted(N, DENIED),
    redactedSpans(N),
  ]),
});
