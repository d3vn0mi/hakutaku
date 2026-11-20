// What each label on a call site or a use means, as every tool description and the server's
// instructions put it to a model: one sentence each, the same words everywhere.
import type { Label } from "../model/index.js";

export const LABEL_WORDING: Readonly<Record<Label, string>> = Object.freeze({
  bound:
    "A compiler-bound call: the type checker resolved this call site to exactly this definition.",
  scoped:
    "A candidate: a name match in a file that imports the defining module, not compiler-checked; confirm it with code_snippet before relying on it.",
  unscoped:
    "A bare name match with no import link; often a different definition with the same name, so treat it as a lead only.",
  reference:
    "A use that is not a call, such as a value passed around, a mock or a dispatch-table entry, resolved by the compiler.",
});
