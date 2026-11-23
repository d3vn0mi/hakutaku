// What the Agent tab asks for a node, and what it shows of the reply. No DOM here: Node tests
// import it.
// - A file or a definition asks code_explain, a component code_overview and a library
//   code_references, each with the node's full stable ID: the one form that stays unambiguous
//   for a path holding "#", ":" or "%". A group asks nothing.
// - The call is written by callText, which an exported page shares.
// - A reply is shown as it came. An error the tool answered is shown under a note that says so; a
//   reply that holds no answer for the node (status 0, as an exported page may give), an answer
//   from another build, and a call that brought no reply show only a note.
import type { AgentCall } from "../../call-text.js";
import { toolCommit } from "../build-guard.js";
import type { ToolReply } from "../data-types.js";
import type { Model } from "../model.js";
import { idOf } from "../routing.js";
import type { Sel } from "../state.js";

export type { AgentCall } from "../../call-text.js";
export { callText } from "../../call-text.js";

const TOOL_ERROR = "The tool answered an error:";
const NO_ANSWER = "This export holds no agent answer for this node.";
const FAILED = "The answer could not be loaded.";

// Null for no selection and for a group.
export function agentCall(model: Model, sel: Sel): AgentCall | null {
  if (sel === null || sel.kind === "group") return null;
  const id = idOf(model, sel);
  if (id === null) return null;
  const { repo } = model.map;
  switch (sel.kind) {
    case "file":
    case "definition":
      return { tool: "code_explain", args: { repo, target: id } };
    case "component":
      return { tool: "code_overview", args: { repo, component: id } };
    case "library":
      return { tool: "code_references", args: { repo, symbol: id } };
  }
}

// What the tab shows of a reply, or of a call that brought none (null): a note, the reply's text
// exactly as it came, or both, the note above the text.
export interface ShownReply {
  note: string | null;
  text: string | null;
}

export function shownReply(
  reply: ToolReply | null,
  builtCommit: string,
): ShownReply {
  if (reply === null) return { note: FAILED, text: null };
  if (reply.status === 0) return { note: NO_ANSWER, text: null };
  if (!reply.ok) return { note: TOOL_ERROR, text: reply.text };
  // an answer that names another build than the map's draws nothing of it
  const commit = toolCommit(reply);
  if (typeof commit === "string" && commit !== builtCommit) {
    return { note: FAILED, text: null };
  }
  return { note: null, text: reply.text };
}
