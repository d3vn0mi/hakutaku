// The call an agent makes for a node, written one way wherever the viewer shows it: the served
// Agent tab and an exported page write it with this one function. It needs no DOM and nothing
// else, since the browser app bundles it and the build compiles it for the export as well.

// A file or a definition asks code_explain, a component code_overview and a library
// code_references, each with the repo first and then the node's full stable ID.
export type AgentCall = {
  tool: "code_explain" | "code_overview" | "code_references";
  args: Record<string, string>;
};

// The tool's name and its arguments as JSON, as an agent writes the call.
export function callText(call: AgentCall): string {
  return `${call.tool}(${JSON.stringify(call.args)})`;
}
