// The rebuild guard. The page draws one build's map; when the repo is rebuilt while the page is
// open, later answers come from the new build. Every answer passes through unchanged, and the
// first one whose builtCommit is not the map's is reported once, so the page can say so instead
// of mixing two builds. No DOM here: Node tests import it.
import type { DataSource, ToolReply } from "./data-types.js";

// A tool's answer names its build in a builtCommit of its own; an error, a list of repos or a
// text that is not JSON names none.
function toolCommit(reply: ToolReply): unknown {
  try {
    const answer: unknown = JSON.parse(reply.text);
    return typeof answer === "object" && answer !== null
      ? (answer as { builtCommit?: unknown }).builtCommit
      : undefined;
  } catch {
    return undefined;
  }
}

export function guardBuild(
  source: DataSource,
  builtCommit: string,
  onRebuilt: (commit: string) => void,
): DataSource {
  let told = false;
  const check = (commit: unknown): void => {
    if (told || typeof commit !== "string" || commit === builtCommit) return;
    told = true;
    onRebuilt(commit);
  };
  const seen = <T extends { builtCommit: string }>(answer: T): T => {
    check(answer.builtCommit);
    return answer;
  };
  return {
    kind: source.kind,
    map: () => source.map().then(seen),
    outline: (file) => source.outline(file).then(seen),
    source: (file) => source.source(file).then(seen),
    history: () => source.history().then(seen),
    tool: (name, args) =>
      source.tool(name, args).then((reply) => {
        check(toolCommit(reply));
        return reply;
      }),
  };
}
