// The Agent tab: what an agent gets for the node on screen. Its heading, the call an agent makes,
// the line that says what the answer holds, then the tool's own answer, asked of the page's data
// source each time the tab opens and set as text exactly as it came, in a box the keyboard can
// reach and scroll. Until it arrives the tab says it is loading; an error the tool answered comes
// under a note that says so, and a reply without an answer, an answer from another build, or a
// call that brought no reply leaves only a note. An answer that arrives after its pane has gone
// draws nothing.
import type { DataSource } from "../data-types.js";
import { h } from "../dom.js";
import type { Model } from "../model.js";
import type { Sel } from "../state.js";
import {
  agentCall,
  callText,
  type ShownReply,
  shownReply,
} from "./agent-call.js";
import { note } from "./overview.js";

const LINE =
  "The same answer an agent gets: stable IDs to cite, counts, related lists to follow, and a view link that opens this spot for a person.";
const LOADING = "Loading the answer\u2026";

// The word for each kind of node that has the tab.
const NOUNS = {
  file: "file",
  definition: "definition",
  component: "component",
  library: "library",
} as const;

// The note and the text of a reply, the note first.
function shown({ note: words, text }: ShownReply): HTMLElement[] {
  const parts: HTMLElement[] = [];
  if (words !== null) parts.push(note(words));
  if (text !== null) {
    parts.push(
      h("pre", {
        text,
        attrs: {
          tabindex: "0",
          role: "region",
          "aria-label": "The tool's answer",
        },
      }),
    );
  }
  return parts;
}

export function agentPane(
  model: Model,
  source: DataSource,
  sel: Exclude<Sel, null>,
): Node[] {
  const call = agentCall(model, sel);
  if (call === null || sel.kind === "group") return [];
  const wait = note(LOADING);
  const pane = h(
    "section",
    { class: "agent" },
    h("h3", { text: `What an agent gets for this ${NOUNS[sel.kind]}` }),
    h("code", { class: "call", text: callText(call) }),
    h("p", { text: LINE }),
    wait,
  );
  const { builtCommit } = model.map;
  source.tool(call.tool, call.args).then(
    (reply) => {
      if (wait.isConnected) {
        wait.replaceWith(...shown(shownReply(reply, builtCommit)));
      }
    },
    (e) => {
      console.error("hakutaku: the agent answer could not be loaded", e);
      if (wait.isConnected) {
        wait.replaceWith(...shown(shownReply(null, builtCommit)));
      }
    },
  );
  return [pane];
}
