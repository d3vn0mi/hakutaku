// The data source of an exported page: the bundle its data block holds, and nothing else. It
// fetches nothing. The map holds every outline, so none is asked of it; a source is the one the
// page holds for that file; a tool's reply is the answer stored for exactly the call the Agent tab
// makes, with status 200, the tool's error with 422, or status 0 when the page holds no answer for
// that call. No DOM here: Node tests import it.
import type { ToolName } from "../../tools/types.js";
import { type AgentCall, callText } from "../call-text.js";
import type { StaticBundle, StoredAnswer } from "../static-bundle.js";
import { ApiError, type DataSource, type ToolReply } from "./data-types.js";

// The argument that names the node, for each tool the Agent tab asks.
const NODE_ARG: ReadonlyMap<string, string> = new Map([
  ["code_explain", "target"],
  ["code_overview", "component"],
  ["code_references", "symbol"],
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The bundle a page's data block holds, from the block's text; an ApiError when the text is not
// the data of a page this viewer reads.
export function parseEmbedded(text: string): StaticBundle {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (
    !isObject(value) ||
    value.format !== 1 ||
    !isObject(value.map) ||
    !isObject(value.history) ||
    !(value.sources === null || isObject(value.sources)) ||
    !(value.agent === null || isObject(value.agent))
  ) {
    throw new ApiError(0, {
      code: "internal",
      message: "the page's data is not a map this viewer reads",
    });
  }
  return value as unknown as StaticBundle;
}

// The answer stored for exactly this call: the node's ID under the tool's own argument, and the
// call, as callText writes it, the one the page stored. Null for any other call.
function storedFor(
  bundle: StaticBundle,
  name: ToolName,
  args: Record<string, unknown>,
): StoredAnswer | null {
  const key = NODE_ARG.get(name);
  const id = key === undefined ? undefined : args[key];
  const { agent } = bundle;
  if (typeof id !== "string" || agent === null || !Object.hasOwn(agent, id)) {
    return null;
  }
  // NODE_ARG named one of the tab's three tools; callText writes the arguments as JSON whatever
  // they hold, so arguments that are not the stored call's strings never equal it
  const stored = agent[id];
  const asked = callText({
    tool: name as AgentCall["tool"],
    args: args as Record<string, string>,
  });
  return stored.call === asked ? stored : null;
}

export function embeddedSource(bundle: StaticBundle): DataSource {
  return {
    kind: "embedded",
    map: () => Promise.resolve(bundle.map),
    outline: (file) =>
      Promise.reject(
        new ApiError(404, {
          code: "not_found",
          message: `this page's map holds every outline, ${file}'s too`,
        }),
      ),
    source: (file) => {
      const { sources } = bundle;
      return sources !== null && Object.hasOwn(sources, file)
        ? Promise.resolve(sources[file])
        : Promise.reject(
            new ApiError(404, {
              code: "no_source",
              message: `this page holds no source for ${file}`,
            }),
          );
    },
    history: () => Promise.resolve(bundle.history),
    tool: (name, args) => {
      const stored = storedFor(bundle, name, args);
      const reply: ToolReply =
        stored === null
          ? { ok: false, status: 0, text: "" }
          : stored.ok
            ? { ok: true, status: 200, text: stored.text }
            : { ok: false, status: 422, text: stored.text };
      return Promise.resolve(reply);
    },
  };
}
