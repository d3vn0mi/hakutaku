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

// A count line: "1 <one>" at 1, "<n> <many>" otherwise. Each caller writes both forms in full,
// since the singular changes more than "is" and "are".
function counted(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

// A compiler tier that did not run for lang, then what that leaves out of the answer.
function noCompiler(lang: Lang | null, reason: string, so: string): string {
  return `no compiler ran for ${displayLang(lang)} in this build (${reason}), so ${so}`;
}

function computedImports(n: number): string {
  return counted(
    n,
    "dynamic import with a computed path is not followed",
    "dynamic imports with a computed path are not followed",
  );
}

// A count in parentheses, plural even at 1.
function unmatchedBoundUses(n: number): string {
  return `compiler-bound uses that match no outline definition are counted in coverage only (${n})`;
}

const OWN_RESOLVER =
  "Python imports come from hakutaku's own resolver, because grimp did not run";

// What an answer about callers cannot see in this build, one line per gap, in a fixed order.
// labels are the labels asked for. fileTarget marks an answer that takes no labels, about a file
// or a call path, so the computed-import line names none.
export function blindSpots(
  store: Store,
  lang: Lang | null,
  opts: { labels?: readonly Label[]; fileTarget?: boolean },
): string[] {
  const { coverage } = store.meta;
  const out: string[] = [];
  if (isCompiled(lang)) {
    const tier = compilerTier(store, lang);
    if (!tier.ran) out.push(noCompiler(lang, tier.reason, "no site is bound"));
  }
  if (lang === "python" && coverage.pythonResolver === "hakutaku-resolver") {
    out.push(OWN_RESOLVER);
  }
  if (lang !== null && !CALLER_LANGS.has(lang)) {
    out.push(`hakutaku extracts no callers for ${lang}`);
  }
  if (lang === "shell") {
    out.push(
      "shell callers are name matches in the file and the files that source it",
    );
  }
  const computed = coverage.computedImports;
  if (isScript(lang) && computed > 0) {
    const line = computedImports(computed);
    if (opts.fileTarget === true) out.push(line);
    else if (opts.labels?.includes("unscoped") === true) {
      out.push(`${line}; the unscoped matches include calls made through them`);
    } else {
      out.push(`${line}; ask with labels ["unscoped"] to see name matches`);
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
      out.push(noCompiler(lang, tier.reason, "no reference is recorded"));
    }
  } else if (lang !== null) {
    out.push(`hakutaku records no references for ${lang}`);
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
    out.push(computedImports(coverage.computedImports));
  }
  if (coverage.unresolvedImports > 0) {
    out.push(
      counted(
        coverage.unresolvedImports,
        "relative import did not resolve to a file and is not an edge",
        "relative imports did not resolve to a file and are not edges",
      ),
    );
  }
  if (lang === "python") {
    if (coverage.pythonResolver === "hakutaku-resolver") out.push(OWN_RESOLVER);
    else if (coverage.pythonResolver === "none") {
      out.push("Python imports were not read in this build");
    }
  }
  if (coverage.denied > 0) {
    out.push(
      counted(
        coverage.denied,
        "denylisted file is left out of the map, with its imports",
        "denylisted files are left out of the map, with their imports",
      ),
    );
  }
  return out;
}

// The labels a call path never follows, since its walk takes only the stored bound and scoped
// calls; each line says where those uses are listed.
const UNFOLLOWED: readonly string[] = Object.freeze([
  'unscoped name matches are not followed; code_callers lists them with labels ["unscoped"]',
  "references, uses that are not calls, are not followed; code_references lists them",
]);

// What a path cannot see, from the language of its from node. Via imports, the lines of the
// imports around the from file. Via calls, those of the from definition's callers, then one
// line for each label the walk does not follow.
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
export function searchBlindSpots(store: Store): string[] {
  const { noSource, coverage } = store.meta;
  const out: string[] = [];
  if (noSource) {
    out.push("this map stores no source text, so no file is searched");
  }
  if (coverage.noSourceFiles > 0) {
    out.push(
      counted(
        coverage.noSourceFiles,
        "file over 1 MB, minified or generated keeps no stored text and is not searched",
        "files over 1 MB, minified or generated keep no stored text and are not searched",
      ),
    );
  }
  if (coverage.denied > 0) {
    out.push(
      counted(
        coverage.denied,
        "denylisted file is left out of the map",
        "denylisted files are left out of the map",
      ),
    );
  }
  if (coverage.redactions > 0) {
    out.push(
      counted(
        coverage.redactions,
        "secret-shaped span is redacted and cannot be found",
        "secret-shaped spans are redacted and cannot be found",
      ),
    );
  }
  return out;
}
