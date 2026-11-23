// The rebuild guard. The page draws one build's map; when the repo is rebuilt while the page is
// open, later answers come from the new build. Every answer passes through unchanged, and the
// first one that names another build than the map's is reported once, so the page can say so
// instead of mixing two builds. A build is the commit and the store's own build together: a rebuild
// at the same commit (another detail, without sources, another profile) is another build too. An
// answer names its build in its body (builtCommit and build), and a tool's reply and a refusal in
// their build; a tool's answer also in its own builtCommit. No DOM here: Node tests import it.
import { ApiError, type DataSource, type ToolReply } from "./data-types.js";

// The build an answer comes from, as the map names it.
export interface Build {
  builtCommit: string;
  build: string;
}

// A tool's answer names its build in a builtCommit of its own; an error, a list of repos or a
// text that is not JSON names none. The Agent tab reads it too, to draw nothing of another build.
export function toolCommit(reply: ToolReply): unknown {
  try {
    const answer: unknown = JSON.parse(reply.text);
    return typeof answer === "object" && answer !== null
      ? (answer as { builtCommit?: unknown }).builtCommit
      : undefined;
  } catch {
    return undefined;
  }
}

// Whether a data answer is of the map's build: the same commit and the same store build.
export const sameBuild = (answer: Build, map: Build): boolean =>
  answer.builtCommit === map.builtCommit && answer.build === map.build;

// Whether a tool's reply names another build than the map's, by its build or its own builtCommit.
export function replyOfOtherBuild(reply: ToolReply, map: Build): boolean {
  const commit = toolCommit(reply);
  return (
    (typeof reply.build === "string" && reply.build !== map.build) ||
    (typeof commit === "string" && commit !== map.builtCommit)
  );
}

// Whether a refusal names another build than the map's.
export const refusalOfOtherBuild = (e: unknown, map: Build): boolean =>
  e instanceof ApiError && typeof e.build === "string" && e.build !== map.build;

// onRebuilt gets the commit of the build the answer comes from, or null when the answer names no
// commit (a tool's error, a refusal).
export function guardBuild(
  source: DataSource,
  map: Build,
  onRebuilt: (commit: string | null) => void,
): DataSource {
  let told = false;
  const tell = (commit: string | null): void => {
    if (told) return;
    told = true;
    onRebuilt(commit);
  };
  const seen = <T extends Build>(answer: T): T => {
    if (
      answer.builtCommit !== map.builtCommit ||
      (typeof answer.build === "string" && answer.build !== map.build)
    ) {
      tell(answer.builtCommit);
    }
    return answer;
  };
  const refused = (e: unknown): never => {
    if (refusalOfOtherBuild(e, map)) tell(null);
    throw e;
  };
  return {
    kind: source.kind,
    map: () => source.map().then(seen, refused),
    outline: (file) => source.outline(file).then(seen, refused),
    source: (file) => source.source(file).then(seen, refused),
    history: () => source.history().then(seen, refused),
    tool: (name, args) =>
      source.tool(name, args).then((reply) => {
        if (replyOfOtherBuild(reply, map)) {
          const commit = toolCommit(reply);
          tell(typeof commit === "string" ? commit : null);
        }
        return reply;
      }, refused),
  };
}
