// Compiler tiers: whether a compiler-backed engine ran for a language in this build, what
// code_explain's label and note say about how a definition's users were found, and the blind
// spots of an answer about callers.
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

// Whether the compiler tier for lang ran in the store's build, and, when it did not, why.
export function compilerTier(store: Store, lang: Lang | null): CompilerTier {
  const { detail, coverage } = store.meta;
  if (lang === "typescript" || lang === "javascript") {
    if (coverage.tiers["scip-typescript"] === "ran") return { ran: true };
    return {
      ran: false,
      reason: detail === "quick" ? "quick detail" : "scip-typescript fell back",
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
            : "scip-python fell back",
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

// What an answer about callers cannot see in this build, one line per gap, in a fixed order.
// labels are the labels asked for; fileTarget marks an answer about a file, which takes none.
export function blindSpots(
  store: Store,
  lang: Lang | null,
  opts: { labels?: readonly Label[]; fileTarget?: boolean },
): string[] {
  const { coverage } = store.meta;
  const script = lang === "typescript" || lang === "javascript";
  const compiled = script || lang === "python";
  const out: string[] = [];
  if (compiled) {
    const tier = compilerTier(store, lang);
    if (!tier.ran) {
      out.push(
        `no compiler ran for ${displayLang(lang)} in this build (${tier.reason}), so no site is bound`,
      );
    }
  }
  if (lang === "python" && coverage.pythonResolver === "hakutaku-resolver") {
    out.push(
      "Python imports come from hakutaku's own resolver, because grimp did not run",
    );
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
  if (script && computed > 0) {
    const line =
      computed === 1
        ? "1 dynamic import with a computed path is not followed"
        : `${computed} dynamic imports with a computed path are not followed`;
    if (opts.fileTarget === true) out.push(line);
    else if (opts.labels?.includes("unscoped") === true) {
      out.push(`${line}; the unscoped matches include calls made through them`);
    } else {
      out.push(`${line}; ask with labels ["unscoped"] to see name matches`);
    }
  }
  if (compiled && coverage.unmatchedBoundUses > 0) {
    out.push(
      `compiler-bound uses that match no outline definition are counted in coverage only (${coverage.unmatchedBoundUses})`,
    );
  }
  return out;
}
