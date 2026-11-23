// The Agent tab end to end. For a file, a definition, a component and a library it shows the call
// an agent makes, with the node's full stable ID, and then exactly the text the tool answers: the
// same text `hakutaku query` prints for the same call on the same store, so the viewer's API and
// the command line are shown to agree. An error the tool answers is shown as the tool wrote it,
// under a note. An answer from another build, a call that brings no answer, and an answer that
// arrives after the viewer has moved on draw nothing of it. Names that hold markup stay text.
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { NodeRef } from "../../dist/index.js";
import type { MapData } from "../../src/query/view/index.js";
import {
  cli,
  E2E,
  ECOSYSTEMS,
  F,
  fetchMap,
  formatId,
  openViewer,
  query,
  selectedId,
  toToken,
} from "./helpers.js";

const KEPLER = "web/src/orbits/kepler.ts";
// The fragments that open kepler.ts and its solveKepler function. The repository's secret scan
// reads a quoted value of 16 characters or more after a name such as "token" as a secret, so the
// fragments are passed by these names.
const AT_KEPLER = "web~src~orbits~kepler.ts";
const AT_SOLVE_KEPLER = "web~src~orbits~kepler.ts--solveKepler";
const OTHER_BUILD = "0123456789ab";
const LINE =
  "The same answer an agent gets: stable IDs to cite, counts, related lists to follow, and a view link that opens this spot for a person.";
const LOADING = "Loading the answer\u2026";
const FAILED = "The answer could not be loaded.";
const ERROR_NOTE = "The tool answered an error:";
const TOOL_PATH = "/api/tool/";

interface Case {
  what: "file" | "definition" | "component" | "library";
  token: string;
  tool: "code_explain" | "code_overview" | "code_references";
  args: Record<string, string>;
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name });
const agent = (page: Page): Locator => page.locator("#pane .agent");

// The call as the tab writes it, and as the page sends it.
const written = (c: Case) => `${c.tool}(${JSON.stringify(c.args)})`;

// The ID a call names: its target, component or symbol.
const named = (c: Case) => Object.values(c.args)[1];

// kepler.ts, its solveKepler function, its component as the map has it (which directory is a
// component depends on the profile the sample was mapped with), and the map's first library.
function cases(m: MapData): Case[] {
  const repo = m.repo;
  const file = m.files.findIndex((f) => f[F.path] === KEPLER);
  if (file < 0) throw new Error(`the sample has no ${KEPLER}`);
  const at = m.files[file][F.component];
  if (m.components[at] === undefined) {
    throw new Error(`the sample has no component for ${KEPLER}`);
  }
  if (m.externals.length === 0) throw new Error("the sample has no library");
  const component: NodeRef = {
    kind: "directory",
    repo,
    path: `${m.components[at][0]}/`,
  };
  const [ecosystem, name] = m.externals[0];
  const library: NodeRef = {
    kind: "external",
    repo,
    ecosystem: ECOSYSTEMS[ecosystem],
    name,
  };
  return [
    {
      what: "file",
      token: AT_KEPLER,
      tool: "code_explain",
      args: { repo, target: `${repo}:${KEPLER}` },
    },
    {
      what: "definition",
      token: AT_SOLVE_KEPLER,
      tool: "code_explain",
      args: { repo, target: `${repo}:${KEPLER}#solveKepler` },
    },
    {
      what: "component",
      token: toToken(component),
      tool: "code_overview",
      args: { repo, component: formatId(component) },
    },
    {
      what: "library",
      token: toToken(library),
      tool: "code_references",
      args: { repo, symbol: formatId(library) },
    },
  ];
}

// Records, in every document the page opens from now on, the path of each answer whose body the
// page has read, once the page has done all it does with it. The page reads a reply's text and
// hands it on through promise reactions alone, so a task queued when the text arrives runs after
// every one of them. The function returned waits until the answer at that path has been read so.
async function watchAnswersRead(
  page: Page,
): Promise<(path: string) => Promise<void>> {
  await page.addInitScript(() => {
    const read: string[] = [];
    Object.defineProperty(window, "__hakutakuAnswersRead", { value: read });
    const text = Response.prototype.text;
    Response.prototype.text = function (this: Response) {
      const body = text.call(this);
      const path = new URL(this.url).pathname;
      const after = () => {
        setTimeout(() => read.push(path), 0);
      };
      body.then(after, after);
      return body;
    };
  });
  return async (path) => {
    await page.waitForFunction(
      (p) =>
        (
          window as unknown as { __hakutakuAnswersRead: string[] }
        ).__hakutakuAnswersRead.includes(p),
      path,
    );
  };
}

// Every tool the page asks for from now on, by name, in order.
function toolRequests(page: Page): string[] {
  const asked: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith(TOOL_PATH)) asked.push(path.slice(TOOL_PATH.length));
  });
  return asked;
}

test("the Agent tab shows exactly what the tool answers, for every kind of node", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  for (const c of cases(m)) {
    await openViewer(page, E2E.sample, { token: c.token });
    expect(await selectedId(page)).toBe(named(c));
    const sent = page.waitForRequest(
      (r) => new URL(r.url()).pathname === `${TOOL_PATH}${c.tool}`,
    );
    await tab(page, "Agent").click();
    await expect(tab(page, "Agent")).toHaveAttribute("aria-selected", "true");
    // the page sends the call it shows, exactly
    expect((await sent).postData()).toBe(JSON.stringify(c.args));
    await expect(agent(page).getByRole("heading")).toHaveText(
      `What an agent gets for this ${c.what}`,
    );
    await expect(agent(page).locator(".call")).toHaveText(written(c));
    await expect(agent(page).locator("p").first()).toHaveText(LINE);
    const answer = query(c.tool, m.repo, c.args);
    expect(JSON.parse(answer).builtCommit).toBe(m.builtCommit);
    expect(await agent(page).locator("pre").textContent()).toBe(answer);
    await expect(agent(page).locator(".note")).toHaveCount(0);
    // the answer is a region of its own, which the keyboard can reach and scroll
    await expect(
      page.getByRole("region", { name: "The tool's answer" }),
    ).toHaveAttribute("tabindex", "0");
  }
});

test("an error the tool answers is shown as the tool wrote it, under a note", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  // the page asks about kepler.ts; the server is asked about a file the store does not hold, and
  // its own error comes back to the page
  const args = { repo: m.repo, target: `${m.repo}:web/src/orbits/nowhere.ts` };
  await page.route(`**${TOOL_PATH}code_explain`, (route) =>
    route.continue({ postData: JSON.stringify(args) }),
  );
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Agent").click();
  const r = cli([
    "query",
    "code_explain",
    m.repo,
    "--args",
    JSON.stringify(args),
  ]);
  expect(r.status).toBe(4);
  expect(JSON.parse(r.stdout).error.code).toBe("not_found");
  await expect(agent(page).locator(".note")).toHaveText(ERROR_NOTE);
  expect(await agent(page).locator("pre").textContent()).toBe(
    r.stdout.trimEnd(),
  );
  // the note sits above the text, after the call and the line
  await expect(agent(page).locator(":scope > *")).toHaveCount(5);
  await expect(agent(page).locator(".note + pre")).toHaveCount(1);
  await expect(agent(page).locator(".call")).toHaveText(
    `code_explain(${JSON.stringify({ repo: "observatory", target: `observatory:${KEPLER}` })})`,
  );
  // an error names no build, so no rebuild is reported
  await expect(page.locator("#toast")).toBeHidden();
});

test("the Agent tab asks each time it opens, and draws nothing of another build's answer", async ({
  page,
}) => {
  const asked = toolRequests(page);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Agent").click();
  await expect(agent(page).locator("pre")).toBeVisible();
  await tab(page, "Overview").click();
  await expect(agent(page)).toHaveCount(0);
  await tab(page, "Agent").click();
  await expect(agent(page).locator("pre")).toBeVisible();
  expect(asked).toEqual(["code_explain", "code_explain"]);
  await page.route(`**${TOOL_PATH}code_explain`, async (route) => {
    const response = await route.fetch();
    const answer = await response.json();
    await route.fulfill({
      response,
      json: { ...answer, builtCommit: OTHER_BUILD },
    });
  });
  await tab(page, "Overview").click();
  await tab(page, "Agent").click();
  await expect(page.locator("#toast")).toContainText(
    `The map was rebuilt at ${OTHER_BUILD}. Reload to see it.`,
  );
  await expect(agent(page).locator(".note")).toHaveText(FAILED);
  await expect(agent(page).locator("pre")).toHaveCount(0);
  // the call is this map's, and stays
  await expect(agent(page).locator(".call")).toHaveText(
    `code_explain(${JSON.stringify({ repo: "observatory", target: `observatory:${KEPLER}` })})`,
  );
  expect(asked).toEqual(["code_explain", "code_explain", "code_explain"]);
});

test("a reply from another build of the same commit, an answer or an error, draws only the note", async ({
  page,
  context,
}) => {
  const m = await fetchMap(E2E.sample);
  const OTHER =
    m.build === "fedcba9876543210" ? "0123456789abcdef" : "fedcba9876543210";
  // a rebuild at the map's commit answers with its own build in the header: an answer whose own
  // builtCommit is the map's, then the error a component the new profile does not make gets
  for (const target of [
    `${m.repo}:${KEPLER}`,
    `${m.repo}:web/src/orbits/nowhere.ts`,
  ]) {
    const page2 = target.endsWith(KEPLER) ? page : await context.newPage();
    await page2.route(`**${TOOL_PATH}code_explain`, async (route) => {
      const response = await route.fetch({
        postData: JSON.stringify({ repo: m.repo, target }),
      });
      expect(response.headers()["x-hakutaku-build"]).toBe(m.build);
      await route.fulfill({
        response,
        headers: { ...response.headers(), "x-hakutaku-build": OTHER },
      });
    });
    await openViewer(page2, E2E.sample, { token: AT_KEPLER });
    await tab(page2, "Agent").click();
    await expect(page2.locator("#toast")).toContainText(
      target.endsWith(KEPLER)
        ? `The map was rebuilt at ${m.builtCommit}. Reload to see it.`
        : "The map was rebuilt. Reload to see it.",
    );
    await expect(agent(page2).locator(".note")).toHaveText(FAILED);
    await expect(agent(page2).locator("pre")).toHaveCount(0);
    await expect(agent(page2).locator(".call")).toHaveText(
      `code_explain(${JSON.stringify({ repo: "observatory", target: `observatory:${KEPLER}` })})`,
    );
    if (page2 !== page) await page2.close();
  }
});

test("the answer is shown as it came, never written again", async ({
  page,
}) => {
  let original = "";
  let sent = "";
  // the same answer, each "/" sent as the escape JSON also reads as "/": a page that parsed the
  // answer and wrote it again, indented or not, would show "/" instead
  await page.route(`**${TOOL_PATH}code_explain`, async (route) => {
    const response = await route.fetch();
    original = await response.text();
    sent = original.replaceAll("/", "\\/");
    await route.fulfill({ response, body: sent });
  });
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Agent").click();
  await expect(agent(page).locator("pre")).toBeVisible();
  expect(sent).toContain("\\/");
  expect(JSON.parse(sent)).toEqual(JSON.parse(original));
  expect(await agent(page).locator("pre").textContent()).toBe(sent);
  await expect(agent(page).locator(".note")).toHaveCount(0);
});

test("a call that brings no answer says so", async ({ page }) => {
  await page.route(`**${TOOL_PATH}**`, (route) => route.abort());
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Agent").click();
  await expect(agent(page).locator(".note")).toHaveText(FAILED);
  await expect(agent(page).locator("pre")).toHaveCount(0);
  await expect(agent(page).locator(".call")).toHaveCount(1);
  await expect(page.locator("#toast")).toBeHidden();
});

test("an answer that arrives after the viewer has moved on is not drawn", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  const component = cases(m)[2];
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${TOOL_PATH}code_explain`, async (route) => {
    await held;
    await route.continue();
  });
  const answerRead = await watchAnswersRead(page);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Agent").click();
  await expect(agent(page).locator(".note")).toHaveText(LOADING);
  await expect(agent(page).locator("pre")).toHaveCount(0);
  // kepler.ts's component, on the Agent tab still, while kepler.ts's answer is held
  await page.evaluate((t) => {
    location.hash = t;
  }, component.token);
  await expect(agent(page).locator(".call")).toHaveText(written(component));
  const answer = query(component.tool, m.repo, component.args);
  expect(await agent(page).locator("pre").textContent()).toBe(answer);
  release();
  // the page has read kepler.ts's late answer and done all it does with it, which must not draw
  await answerRead(`${TOOL_PATH}code_explain`);
  await expect(agent(page).locator("pre")).toHaveCount(1);
  expect(await agent(page).locator("pre").textContent()).toBe(answer);
  await expect(agent(page).locator(".call")).toHaveText(written(component));
  expect(await selectedId(page)).toBe(named(component));
});

test("names that hold markup stay text in the Agent tab", async ({ page }) => {
  test.setTimeout(120_000);
  const m = await fetchMap(E2E.markup);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await openViewer(page, E2E.markup);
  expect(m.files.some((f) => f[F.path].includes("<"))).toBe(true);
  for (const f of m.files) {
    const ref: NodeRef = { kind: "file", repo: m.repo, path: f[F.path] };
    await page.evaluate((t) => {
      location.hash = t;
    }, toToken(ref));
    await expect(page.locator("#detail h2")).toHaveText(f[F.path]);
    await tab(page, "Agent").click();
    const args = { repo: m.repo, target: formatId(ref) };
    await expect(agent(page).locator(".call")).toHaveText(
      `code_explain(${JSON.stringify(args)})`,
    );
    expect(await agent(page).locator("pre").textContent()).toBe(
      query("code_explain", m.repo, args),
    );
  }
  expect(
    await page.evaluate(() => ({
      elements: document.querySelectorAll("#detail img, #detail svg").length,
      handlers: [...document.querySelectorAll("#detail *")].filter((e) =>
        [...e.attributes].some((x) => x.name.startsWith("on")),
      ).length,
    })),
  ).toEqual({ elements: 0, handlers: 0 });
  expect(dialogs).toEqual([]);
});
