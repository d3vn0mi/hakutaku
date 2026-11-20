// Compiler tiers: whether a compiler-backed engine ran for a language in this build, and what
// code_explain's label and note say about how a definition's users were found.
import type { Lang } from "../model/index.js";
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
