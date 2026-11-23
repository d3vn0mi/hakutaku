// What the Agent tab asks and how it shows the reply: each kind of node asks its tool with its
// full stable ID, the call is written as an agent writes it, by one function that imports
// nothing, and a reply is shown as it came, under a note when the tool answered an error, or
// only as a note when there is no answer or it comes from another build.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { F } from "../../../../src/query/view/constants.js";
import type { MapData } from "../../../../src/query/view/types.js";
import {
  agentCall,
  callText,
  shownReply,
} from "../../../../src/viewer/app/detail/agent-call.js";
import { buildModel, type Model } from "../../../../src/viewer/app/model.js";
import type { Sel } from "../../../../src/viewer/app/state.js";
import { tinyModel } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OTHER_BUILD = "0123456789ab";

let m: Model;
beforeAll(() => {
  m = tinyModel();
});

it("asks each tool with the node's stable ID", () => {
  expect(agentCall(m, { kind: "file", file: 3 })).toEqual({
    tool: "code_explain",
    args: { repo: "tiny", target: "tiny:src/core/graph.ts" },
  });
  expect(agentCall(m, { kind: "definition", file: 3, def: 4 })).toEqual({
    tool: "code_explain",
    args: { repo: "tiny", target: "tiny:src/core/graph.ts#helper(2)" },
  });
  expect(agentCall(m, { kind: "component", component: 1 })).toEqual({
    tool: "code_overview",
    args: { repo: "tiny", component: "tiny:src/core/" },
  });
  expect(agentCall(m, { kind: "library", external: 1 })).toEqual({
    tool: "code_references",
    args: { repo: "tiny", symbol: "tiny:npm:kleur" },
  });
  expect([
    agentCall(m, null),
    agentCall(m, { kind: "group", key: "src" }),
  ]).toEqual([null, null]);
});

it("writes the call as an agent would", () => {
  expect(
    callText({
      tool: "code_explain",
      args: { repo: "tiny", target: "tiny:src/core/graph.ts" },
    }),
  ).toBe('code_explain({"repo":"tiny","target":"tiny:src/core/graph.ts"})');
});

it("writes the repo first, then the node, for every kind of node", () => {
  const written = (sel: Sel) => {
    const call = agentCall(m, sel);
    if (call === null) throw new Error(`no call for ${JSON.stringify(sel)}`);
    return callText(call);
  };
  expect(written({ kind: "file", file: 0 })).toBe(
    'code_explain({"repo":"tiny","target":"tiny:package.json"})',
  );
  expect(written({ kind: "definition", file: 3, def: 2 })).toBe(
    'code_explain({"repo":"tiny","target":"tiny:src/core/graph.ts#Graph.add"})',
  );
  expect(written({ kind: "component", component: 0 })).toBe(
    'code_overview({"repo":"tiny","component":"tiny:src/cli/"})',
  );
  expect(written({ kind: "library", external: 1 })).toBe(
    'code_references({"repo":"tiny","symbol":"tiny:npm:kleur"})',
  );
});

it("names a path that holds # : % or a quote by its full ID, and the root component by ./", () => {
  const map: MapData = structuredClone(tinyModel().map);
  map.files[3][F.path] = 'src/c#d%e:f/"q".ts';
  map.components[0][0] = ".";
  const odd = buildModel(map);
  const def = agentCall(odd, { kind: "definition", file: 3, def: 4 });
  expect(def).toEqual({
    tool: "code_explain",
    args: { repo: "tiny", target: 'tiny:src/c%23d%25e%3Af/"q".ts#helper(2)' },
  });
  if (def === null) throw new Error("no call for the definition");
  expect(callText(def)).toBe(
    'code_explain({"repo":"tiny","target":"tiny:src/c%23d%25e%3Af/\\"q\\".ts#helper(2)"})',
  );
  expect(agentCall(odd, { kind: "component", component: 0 })).toEqual({
    tool: "code_overview",
    args: { repo: "tiny", component: "tiny:./" },
  });
});

it("shows an answer as it came, and nothing of an answer from another build", () => {
  const built = m.map;
  const text = JSON.stringify(
    { id: "tiny:src/core/graph.ts", kind: "file", builtCommit: built },
    null,
    2,
  );
  expect(
    shownReply({ ok: true, status: 200, text, build: null }, built),
  ).toEqual({
    note: null,
    text,
  });
  const other = JSON.stringify(
    { id: "tiny:src/core/graph.ts", kind: "file", builtCommit: OTHER_BUILD },
    null,
    2,
  );
  expect(
    shownReply({ ok: true, status: 200, text: other, build: null }, built),
  ).toEqual({
    note: "The answer could not be loaded.",
    text: null,
  });
  // a text that names no build of its own is shown as it came
  for (const plain of [
    "not JSON",
    "[1, 2]",
    "null",
    "{}",
    '{"builtCommit":null}',
    '{"answer":{"builtCommit":"0123456789ab"}}',
  ]) {
    expect(
      shownReply({ ok: true, status: 200, text: plain, build: null }, built),
      plain,
    ).toEqual({ note: null, text: plain });
  }
});

it("shows nothing of a reply whose build is another of the map's commit, an answer or an error", () => {
  const built = m.map;
  const text = JSON.stringify(
    { id: "tiny:src/core/graph.ts", builtCommit: built.builtCommit },
    null,
    2,
  );
  const error = JSON.stringify(
    { error: { code: "not_found", message: "tiny:web/ is not in the store" } },
    null,
    2,
  );
  for (const reply of [
    { ok: true, status: 200, text, build: "fedcba9876543210" },
    { ok: false, status: 422, text: error, build: "fedcba9876543210" },
  ]) {
    expect(shownReply(reply, built), String(reply.status)).toEqual({
      note: "The answer could not be loaded.",
      text: null,
    });
  }
  // the map's own build is shown as it came
  expect(
    shownReply({ ok: true, status: 200, text, build: built.build }, built),
  ).toEqual({ note: null, text });
  expect(
    shownReply(
      { ok: false, status: 422, text: error, build: built.build },
      built,
    ),
  ).toEqual({ note: "The tool answered an error:", text: error });
});

it("says the tool answered an error above its text, and says when there is no answer", () => {
  const built = m.map;
  const error = JSON.stringify(
    {
      error: { code: "not_found", message: "src/nope.ts is not in the store" },
    },
    null,
    2,
  );
  for (const status of [422, 400, 404, 500, 503]) {
    expect(
      shownReply({ ok: false, status, text: error, build: null }, built),
    ).toEqual({
      note: "The tool answered an error:",
      text: error,
    });
  }
  // status 0: the page holds no answer for this node, as an exported page may not
  expect(
    shownReply({ ok: false, status: 0, text: "", build: null }, built),
  ).toEqual({
    note: "This export holds no agent answer for this node.",
    text: null,
  });
  // no reply at all: the call brought none
  expect(shownReply(null, built)).toEqual({
    note: "The answer could not be loaded.",
    text: null,
  });
});

it("writes the call by one function that imports nothing, so an exported page writes the same", () => {
  const s = readFileSync(`${ROOT}src/viewer/call-text.ts`, "utf8");
  expect(s).toMatch(/export function callText\(/); // the scan reads the real file
  expect(s).not.toMatch(/^\s*import\b|\bfrom\s+["']|\brequire\(|\bimport\(/m);
  expect(s).not.toMatch(/\b(document|window|globalThis)\b/);
});
