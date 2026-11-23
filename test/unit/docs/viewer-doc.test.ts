// docs/viewer.md against the code it describes: its byline and its ten sections, in order; every
// link token it shows, through the codec both ways; the headers and the statuses it lists, against
// the viewer's own, each status as an answer really gives it; what --open hands the opener, and
// how long its page stays; its keys, against the page's key table; and its legends and usage line,
// word for word. Run `npm run build` first: the page's and the export's policies are read from the
// built bundle.
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import {
  formatId,
  fromToken,
  parseId,
  toToken,
} from "../../../src/model/index.js";
import type { Host } from "../../../src/tools/index.js";
import { viewerApi } from "../../../src/viewer/api.js";
import { LEGEND } from "../../../src/viewer/app/map/colors.js";
import {
  BUILD_HEADER,
  SECURITY_HEADERS,
  VIEWER_CSP,
} from "../../../src/viewer/csp.js";
import { inlineViewerHtml } from "../../../src/viewer/inline.js";
import {
  MAX_BODY_BYTES,
  OPEN_PAGE_KEEP_MS,
} from "../../../src/viewer/server.js";
import { viewerStatic } from "../../../src/viewer/static.js";
import type { ViewerResponse } from "../../../src/viewer/types.js";
import { tinyHost } from "../viewer/tiny-host.js";
import { tinyStore } from "../viewer/tiny-store.js";

const doc = readFileSync("docs/viewer.md", "utf8");
const source = (path: string): string => readFileSync(path, "utf8");
// Prose as one line: a sentence the page wraps reads the same.
const flat = (text: string): string => text.replace(/\s+/g, " ");

const SECTIONS = [
  "What the viewer is",
  "Running it",
  "Reading the map",
  "Find, filters, the list view and the keys",
  "Link tokens",
  "Mounting the viewer in another server",
  "Security",
  "Performance",
  "Accessibility",
  "Credits",
];

// A section: the lines after its heading, up to the next heading of level 2.
function sectionOf(name: string): string {
  const lines = doc.split("\n");
  const from = lines.indexOf(`## ${name}`);
  if (from < 0) throw new Error(`docs/viewer.md has no section ${name}`);
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((line) => line.startsWith("## "));
  return (to < 0 ? rest : rest.slice(0, to)).join("\n");
}

// The cells of each row of the table under head, in text: none when there is no such table.
function tableRows(text: string, head: string): string[][] {
  const lines = text.split("\n");
  const at = lines.indexOf(head);
  if (at < 0) throw new Error(`docs/viewer.md has no table ${head}`);
  const rows: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  return rows;
}

// The text of a cell's first code span, or null.
const code = (cell: string): string | null =>
  cell.match(/`([^`]*)`/)?.[1] ?? null;

it("starts with its author, then holds its ten sections, in order", () => {
  expect(doc.split("\n")[0]).toBe("Author: d3vn0mi.");
  expect([...doc.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(SECTIONS);
});

// Each ID and its token, as both link-token tables give them; (empty) is the repo's empty token.
function tokenRows(): Array<[id: string, token: string]> {
  const tokens = sectionOf("Link tokens");
  const rows = [
    ...tableRows(tokens, "| Node | ID | Token |").map((cells) =>
      cells.slice(1),
    ),
    ...tableRows(tokens, "| ID | Token |"),
  ];
  return rows.map(([id, token]) => {
    const shown = code(id ?? "");
    if (shown === null) throw new Error(`a row without an ID: ${id}`);
    return [shown, token === "(empty)" ? "" : (code(token ?? "") ?? "?")];
  });
}

it("gives every link token as the codec writes it and reads it back", () => {
  const rows = tokenRows();
  // the node table's five rows and the five more cases
  expect(rows).toHaveLength(10);
  for (const [id, token] of rows) {
    const ref = parseId(id);
    if (ref === null) throw new Error(`not an ID: ${id}`);
    expect(toToken(ref), id).toBe(token);
    const back = fromToken("observatory", token);
    expect(back === null ? null : formatId(back), token).toBe(id);
  }
});

it("works its two examples, and the wrong reading the second one avoids, as the codec does", () => {
  const tokens = sectionOf("Link tokens");
  const examples: Array<[string, string]> = [
    [
      "observatory:web/src/orbits/kepler.ts#Orbit.position",
      "web~src~orbits~kepler.ts--Orbit.position",
    ],
    ["observatory:scripts/sync-#main", "scripts~sync%2D--main"],
  ];
  for (const [id, token] of examples) {
    expect(tokens).toContain(`\`${id}\``);
    expect(tokens).toContain(`\`${token}\``);
    const ref = parseId(id);
    if (ref === null) throw new Error(`not an ID: ${id}`);
    expect(toToken(ref)).toBe(token);
  }
  // without step 2, the token names another file
  const wrong = fromToken("observatory", "scripts~sync---main");
  expect(wrong === null ? null : formatId(wrong)).toBe(
    "observatory:scripts/sync#-main",
  );
  expect(tokens).toContain("`scripts~sync---main`");
  expect(tokens).toContain("`observatory:scripts/sync#-main`");
});

it("lists the headers every answer carries, and each policy as the viewer sends it", () => {
  const mounting = sectionOf("Mounting the viewer in another server");
  expect(tableRows(mounting, "| Header | Value |")).toEqual(
    Object.entries(SECURITY_HEADERS).map(([name, value]) => [
      `\`${name}\``,
      `\`${value}\``,
    ]),
  );
  const page = viewerStatic("", { base: "/" });
  const asset = viewerStatic("assets/app.js", { base: "/" });
  const api = viewerApi(tinyHost(tinyStore()), null, "tiny", {
    method: "GET",
    path: "map",
    query: {},
  });
  expect(page.headers["content-security-policy"]).toBe(VIEWER_CSP);
  const prose = flat(mounting);
  expect(prose).toContain(`\`content-type: ${page.headers["content-type"]}\``);
  expect(prose).toContain(
    `\`content-security-policy: ${asset.headers["content-security-policy"]}\``,
  );
  expect(prose).toContain(`\`content-type: ${api.headers["content-type"]}\``);
  // and the build an API answer comes from, once the repo's store is open
  expect(api.headers[BUILD_HEADER]).toMatch(/^[0-9a-f]{16}$/);
  expect(prose).toContain(`\`${BUILD_HEADER}\``);
  // the policies in full: the served page's, and the export's with its two hashes named
  const security = sectionOf("Security");
  expect(security).toContain(`\`\`\`text\n${VIEWER_CSP}\n\`\`\``);
  const { csp } = inlineViewerHtml(null);
  const named = csp
    .replace(/script-src 'sha256-[^']+'/, "script-src 'sha256-<script hash>'")
    .replace(/style-src 'sha256-[^']+'/, "style-src 'sha256-<style hash>'");
  expect(named).not.toBe(csp);
  expect(security).toContain(`\`\`\`text\n${named}\n\`\`\``);
  expect(prose).toContain(`${MAX_BODY_BYTES.toLocaleString("en-US")} bytes`);
});

it("says what --open hands the opener, who can read it, and how long it stays", () => {
  const security = flat(sectionOf("Security"));
  expect(security).toContain(
    "`--open` never hands the link to the opener, nor to a browser the opener starts",
  );
  expect(security).toContain(
    "the directory of mode 0700 and the page of mode 0600",
  );
  expect(OPEN_PAGE_KEEP_MS % 1000).toBe(0);
  expect(security).toContain(
    `the page is removed ${OPEN_PAGE_KEEP_MS / 1000} seconds later, or when \`view\` stops`,
  );
});

// What the API and the static files can answer, read from their code: every status they write,
// and every error code they make themselves (a 422 carries the tool's own).
function statusesInCode(): { statuses: number[]; codes: string[] } {
  const text = ["src/viewer/api.ts", "src/viewer/static.ts"]
    .map(source)
    .join("\n");
  const statuses = [
    ...text.matchAll(
      /\b(?:failure|respond)\(\s*(\d{3})\b|\bstatus: (\d{3})\b/g,
    ),
  ].map((m) => Number(m[1] ?? m[2]));
  const codes = [...text.matchAll(/\btoolError\(\s*"([a-z_]+)"/g)].map(
    (m) => m[1] ?? "",
  );
  return {
    statuses: [...new Set(statuses)].sort(),
    codes: [...new Set(codes)].sort(),
  };
}

// An answer of each kind the status table names, as the API or the static files give it.
const API = (
  host: Host,
  req: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: string;
  },
  repo = "tiny",
): ViewerResponse => viewerApi(host, null, repo, { query: {}, ...req });
const SCENARIOS: Record<string, () => ViewerResponse> = {
  "200": () => API(tinyHost(tinyStore()), { method: "GET", path: "map" }),
  "400 invalid_argument": () =>
    API(tinyHost(tinyStore()), {
      method: "GET",
      path: "outline",
      query: { file: "not an ID" },
    }),
  "404 not_found": () =>
    API(tinyHost(tinyStore()), { method: "GET", path: "no-such-path" }),
  "404 denied_file": () =>
    API(tinyHost(tinyStore()), {
      method: "GET",
      path: "source",
      query: { file: "tiny:.env" },
    }),
  "404 no_source": () =>
    API(tinyHost(tinyStore(), { snippets: false }), {
      method: "GET",
      path: "source",
      query: { file: "tiny:src/core/graph.ts" },
    }),
  "404 unknown_repo": () =>
    API(tinyHost(tinyStore()), { method: "GET", path: "map" }, "elsewhere"),
  "405 invalid_argument": () =>
    API(tinyHost(tinyStore()), { method: "POST", path: "map" }),
  "422 the tool's own": () =>
    API(tinyHost(tinyStore()), {
      method: "POST",
      path: "tool/code_explain",
      body: JSON.stringify({ target: "tiny:no/such/file.ts" }),
    }),
  "500 internal": () => {
    // the exception's details go to the host's log, which is quiet here
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      return API(
        {
          ...tinyHost(tinyStore()),
          open: () => {
            throw new Error("a host that fails");
          },
        },
        { method: "GET", path: "map" },
      );
    } finally {
      log.mockRestore();
    }
  },
  "503 not_built": () =>
    API(tinyHost("/no/such/store.sqlite"), { method: "GET", path: "map" }),
};

it("lists every status the API and the static files answer, each as they give it", () => {
  const rows = tableRows(
    sectionOf("Mounting the viewer in another server"),
    "| Status | Error code | When |",
  );
  const listed = rows.map(([status, cell]) => {
    const errorCode = code(cell ?? "") ?? (cell === "" ? "" : (cell ?? ""));
    return { status: Number(status), errorCode };
  });
  const inCode = statusesInCode();
  expect([...new Set(listed.map((r) => r.status))].sort()).toEqual(
    inCode.statuses,
  );
  expect(inCode.statuses).toEqual([200, 400, 404, 405, 422, 500, 503]);
  expect(
    [...new Set(listed.map((r) => r.errorCode))]
      .filter((c) => c !== "" && c !== "the tool's own")
      .sort(),
  ).toEqual(inCode.codes);
  expect(listed.map((r) => `${r.status} ${r.errorCode}`.trim())).toEqual(
    Object.keys(SCENARIOS),
  );
  for (const { status, errorCode } of listed) {
    const key = `${status} ${errorCode}`.trim();
    const answer = SCENARIOS[key]?.();
    if (answer === undefined) throw new Error(`no answer for ${key}`);
    expect(answer.status, key).toBe(status);
    const body = JSON.parse(String(answer.body));
    if (status === 200) {
      expect(body.error, key).toBeUndefined();
    } else if (status === 422) {
      // the tool's own error, which the tool names, here not_found
      expect(body.error.code, key).toBe("not_found");
    } else {
      expect(body.error.code, key).toBe(errorCode);
    }
  }
  // a static file the viewer does not have
  const missing = viewerStatic("assets/no-such-asset.js", { base: "/" });
  expect([missing.status, JSON.parse(String(missing.body)).error.code]).toEqual(
    [404, "not_found"],
  );
});

it("lists every plain-text answer of hakutaku view's server, as the server writes it", () => {
  const rows = tableRows(
    sectionOf("Mounting the viewer in another server"),
    "| Status | Body | When |",
  );
  const listed = rows.map(([status, body]) => `${status} ${code(body ?? "")}`);
  const written = [
    ...source("src/viewer/server.ts").matchAll(
      /\btext\(\s*res,\s*(\d{3}),\s*"([^"\\]*)\\n"\s*\)/g,
    ),
  ].map((m) => `${m[1]} ${m[2]}`);
  expect(written.length).toBeGreaterThan(0);
  expect(listed).toEqual([...new Set(written)].sort());
});

// The keys the page binds, read from its key table: each key as KeyboardEvent.key names it, and
// the action it runs, with the lens it picks.
function boundKeys(): Map<string, string> {
  const table = [
    ...source("src/viewer/app/keys.ts").matchAll(
      /\["([^"]+)",\s*\(\)\s*=>\s*actions\.(\w+)\((?:"(\w+)")?\)\]/g,
    ),
  ];
  return new Map(
    table.map((m) => [
      m[1] ?? "",
      m[3] === undefined ? `${m[2]}` : `${m[2]} ${m[3]}`,
    ]),
  );
}

// The KeyboardEvent.key values a key the page's text names stands for: a letter in either case.
function keyValues(name: string): string[] {
  if (name === "Esc") return ["Escape"];
  return /^[A-Z]$/.test(name) ? [name.toLowerCase(), name] : [name];
}

// How the keys table says each action.
const ACTION_WORDS: Readonly<Record<string, string>> = {
  find: "Find",
  back: "Back",
  "lens structure": "The Structure lens",
  "lens risk": "The Risk lens",
  "lens history": "The History lens",
  depth: "The next depth",
  list: "The list view",
};

it("lists every key the page binds, with what it does", () => {
  const bound = boundKeys();
  expect(bound.size).toBeGreaterThan(0);
  const rows = tableRows(
    sectionOf("Find, filters, the list view and the keys"),
    "| Key | What it does |",
  );
  const covered: string[] = [];
  for (const [keys, what] of rows) {
    const values = [...(keys ?? "").matchAll(/`([^`]+)`/g)].flatMap((m) =>
      keyValues(m[1] ?? ""),
    );
    const actions = [...new Set(values.map((v) => bound.get(v)))];
    expect(actions, keys).toHaveLength(1);
    const words = ACTION_WORDS[actions[0] ?? ""];
    if (words === undefined) throw new Error(`no words for ${keys}`);
    expect(what, keys).toContain(words);
    covered.push(...values);
  }
  expect(covered.sort()).toEqual([...bound.keys()].sort());
});

it("quotes each legend word for word, and the usage line as view prints it", () => {
  for (const legend of Object.values(LEGEND)) {
    expect(flat(doc)).toContain(`"${legend}"`);
  }
  const usage = source("src/cli/commands/view.ts").match(
    /const USAGE =\s*"(usage: hakutaku view [^"\\]*)\\n";/,
  )?.[1];
  if (usage === undefined) throw new Error("view.ts has no USAGE line");
  expect(sectionOf("Running it")).toContain(`\`\`\`text\n${usage}\n\`\`\``);
});
