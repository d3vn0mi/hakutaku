// The viewer's own server, as hakutaku view runs it: on loopback at a free port, the API only for
// the session the link carries, every request's Host header checked, no CORS, and a cap on
// request bodies. openBrowser runs the platform's opener without a shell, and hands it a page
// that sends the browser on to the link, never the link itself.
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runTool } from "../../../src/tools/index.js";
import { SECURITY_HEADERS, VIEWER_CSP } from "../../../src/viewer/csp.js";
import {
  MAX_BODY_BYTES,
  OPEN_PAGE_KEEP_MS,
  openBrowser,
  startViewerServer,
} from "../../../src/viewer/server.js";
import { tinyHost } from "./tiny-host.js";
import { tinyStore } from "./tiny-store.js";

let s: { url: string; close(): Promise<void> };
let port: string;
let session: string;
beforeAll(async () => {
  s = await startViewerServer({
    host: tinyHost(tinyStore()),
    repo: "tiny",
    open: false,
  });
  const u = new URL(s.url);
  port = u.port;
  session = u.searchParams.get("s") ?? "";
});
afterAll(() => s.close());

let pagesRoot: string | undefined;
afterAll(() => {
  if (pagesRoot !== undefined) {
    rmSync(pagesRoot, { recursive: true, force: true });
  }
});

// A fresh, empty directory for the pages openBrowser writes, under one root this file removes.
function pagesDir(): string {
  pagesRoot ??= mkdtempSync(join(tmpdir(), "hakutaku-opener-test-"));
  return mkdtempSync(join(pagesRoot, "base-"));
}

// What a stand-in for spawn was handed, as it was called: the command, its arguments and options,
// and, when the first argument names a file, that file's directory's mode, its own mode and its
// text.
interface Handed {
  command: string;
  args: string[];
  options: { detached?: unknown; stdio?: unknown; shell?: unknown };
  dirMode: number | null;
  pageMode: number | null;
  page: string | null;
}

function recorder(): { spawn: never; handed: Handed[] } {
  const handed: Handed[] = [];
  const spawn = ((command: string, args: string[], options: object) => {
    const seen: Handed = {
      command,
      args,
      options,
      dirMode: null,
      pageMode: null,
      page: null,
    };
    handed.push(seen);
    const [path = ""] = args;
    try {
      seen.dirMode = statSync(dirname(path)).mode & 0o777;
      seen.pageMode = statSync(path).mode & 0o777;
      seen.page = readFileSync(path, "utf8");
    } catch {
      // not a file: the test says what it got instead
    }
    return { unref() {}, on() {} };
  }) as never;
  return { spawn, handed };
}

const api = (headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/api/map`, { headers });

// The status of a GET of path sent with this Host header, which fetch does not let a caller set.
function rawStatus(port: string, host: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers: { host }, setHost: false },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

it("binds to loopback and prints a session link", () => {
  expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?s=[A-Za-z0-9_-]{43}$/);
});

it("API calls need the session", async () => {
  expect((await api()).status).toBe(403);
  expect((await api({ "x-hakutaku-session": "x".repeat(43) })).status).toBe(
    403,
  );
  const ok = await api({ "x-hakutaku-session": session });
  expect([ok.status, JSON.parse(await ok.text()).repo]).toEqual([200, "tiny"]);
});

it("refuses a session of another length, or one that differs in its last character", async () => {
  for (const wrong of [
    "x",
    session.slice(0, -1),
    `${session}x`,
    `${session.slice(0, -1)}${session.endsWith("A") ? "B" : "A"}`,
  ]) {
    expect((await api({ "x-hakutaku-session": wrong })).status, wrong).toBe(
      403,
    );
  }
});

it("the Host header must name the loopback port", async () => {
  expect(await rawStatus(port, `evil.example:${port}`, "/")).toBe(421);
  expect(await rawStatus(port, `127.0.0.1:${Number(port) + 1}`, "/")).toBe(421);
  expect(await rawStatus(port, `localhost:${port}`, "/")).toBe(200);
  expect(await rawStatus(port, `LOCALHOST:${port}`, "/")).toBe(200);
  expect(await rawStatus(port, "127.0.0.1", "/")).toBe(421);
  // localhost at another port, and a name of another site that resolves to 127.0.0.1
  expect(await rawStatus(port, `localhost:${Number(port) + 1}`, "/")).toBe(421);
  expect(await rawStatus(port, `localhost.evil.example:${port}`, "/")).toBe(
    421,
  );
  expect(await rawStatus(port, `localhost:${port}.evil.example`, "/")).toBe(
    421,
  );
});

// What a raw connection is answered with: the status line, or "closed" when the connection ends
// or fails without one, or "silent" when nothing comes within a second.
function rawAnswer(
  address: string,
  text: string,
): Promise<"closed" | "silent" | string> {
  return new Promise((resolve) => {
    const socket = connect(Number(port), address, () => socket.write(text));
    let got = "";
    const finish = (answer: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => finish("silent"), 1000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      got += chunk;
      const end = got.indexOf("\r\n");
      if (end >= 0) finish(got.slice(0, end));
    });
    socket.on("error", () => finish("closed"));
    socket.on("end", () => finish("closed"));
  });
}

it("listens on 127.0.0.1 only, not on any other address of the machine", async () => {
  const request = `GET / HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nconnection: close\r\n\r\n`;
  expect(await rawAnswer("127.0.0.1", request)).toBe("HTTP/1.1 200 OK");
  // on Linux every 127.x.y.z address reaches the machine, so only a server listening on more than
  // 127.0.0.1 would answer there
  expect(
    await rawAnswer("127.0.0.2", request.replace("127.0.0.1", "127.0.0.2")),
  ).not.toMatch(/^HTTP\//);
});

it("refuses a body declared over the limit before any of it is sent", async () => {
  const head = [
    "POST /api/tool/code_explain HTTP/1.1",
    `host: 127.0.0.1:${port}`,
    `x-hakutaku-session: ${session}`,
    `content-length: ${MAX_BODY_BYTES + 1}`,
    "",
    "",
  ].join("\r\n");
  expect(await rawAnswer("127.0.0.1", head)).toBe(
    "HTTP/1.1 413 Payload Too Large",
  );
});

it("serves the page and assets without the session, the page with its CSP", async () => {
  const p = await fetch(`http://127.0.0.1:${port}/`);
  expect([p.status, p.headers.get("content-security-policy")]).toEqual([
    200,
    VIEWER_CSP,
  ]);
  expect((await fetch(`http://127.0.0.1:${port}/assets/app.js`)).status).toBe(
    200,
  );
});

it("refuses large bodies, other methods and preflights, and sends no CORS header", async () => {
  const big = await fetch(`http://127.0.0.1:${port}/api/tool/code_explain`, {
    method: "POST",
    headers: { "x-hakutaku-session": session },
    body: "x".repeat(MAX_BODY_BYTES + 1),
  });
  expect(big.status).toBe(413);
  expect(
    (await fetch(`http://127.0.0.1:${port}/`, { method: "POST" })).status,
  ).toBe(405);
  const pre = await fetch(`http://127.0.0.1:${port}/api/map`, {
    method: "OPTIONS",
    headers: { origin: "http://evil.example" },
  });
  expect([pre.status, pre.headers.get("access-control-allow-origin")]).toEqual([
    405,
    null,
  ]);
});

it("refuses a chunked body that grows past the limit, which declares no length", async () => {
  const status = (sizes: number[]) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/tool/code_explain",
          method: "POST",
          headers: {
            "x-hakutaku-session": session,
            "content-type": "application/json",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      for (const size of sizes) req.write(" ".repeat(size));
      req.end();
    });
  expect(await status([MAX_BODY_BYTES, 1])).toBe(413);
  // at the limit exactly, the body reaches the API, which says what is wrong with it
  expect(await status([MAX_BODY_BYTES - 1, 1])).toBe(400);
});

it("gives the API the path after /api/, the first value of each query parameter, and the body", async () => {
  const headers = { "x-hakutaku-session": session };
  const outline = await fetch(
    `http://127.0.0.1:${port}/api/outline?file=tiny:src/core/graph.ts&file=tiny:src/cli/main.ts`,
    { headers },
  );
  expect([outline.status, JSON.parse(await outline.text()).file]).toEqual([
    200,
    "tiny:src/core/graph.ts",
  ]);
  const args = { target: "tiny:src/core/graph.ts" };
  const json = { ...headers, "content-type": "application/json" };
  const tool = await fetch(`http://127.0.0.1:${port}/api/tool/code_explain`, {
    method: "POST",
    headers: json,
    body: JSON.stringify(args),
  });
  const direct = runTool(tinyHost(tinyStore()), undefined, "code_explain", {
    repo: "tiny",
    ...args,
  });
  expect(direct.ok).toBe(true);
  expect([tool.status, await tool.text()]).toEqual([
    200,
    JSON.stringify((direct as { answer: object }).answer, null, 2),
  ]);
  // a body of exactly the limit reaches the API, which says what is wrong with it
  const full = await fetch(`http://127.0.0.1:${port}/api/tool/code_explain`, {
    method: "POST",
    headers: json,
    body: " ".repeat(MAX_BODY_BYTES),
  });
  expect([full.status, JSON.parse(await full.text()).error.field]).toEqual([
    400,
    "body",
  ]);
  // the path is read as sent: "//" never starts a host, and dot segments are not resolved
  expect(await rawStatus(port, `127.0.0.1:${port}`, "//api/map")).toBe(400);
  expect(
    await rawStatus(port, `127.0.0.1:${port}`, "/assets/../index.html"),
  ).toBe(404);
  const unknown = await fetch(`http://127.0.0.1:${port}/api/nope`, { headers });
  expect([unknown.status, JSON.parse(await unknown.text()).error.code]).toEqual(
    [404, "not_found"],
  );
});

it("hands the API the request's content type: a tool call runs as JSON, and a plain-text or form body is refused with 415", async () => {
  const call = (
    headers: Record<string, string>,
    body: string | URLSearchParams,
  ) =>
    fetch(`http://127.0.0.1:${port}/api/tool/code_explain`, {
      method: "POST",
      headers: { "x-hakutaku-session": session, ...headers },
      body,
    });
  const args = JSON.stringify({ target: "tiny:src/core/graph.ts" });
  const ran = await call({ "content-type": "application/json" }, args);
  const answer = await ran.text();
  expect([ran.status, JSON.parse(answer).view]).toEqual([
    200,
    "#src~core~graph.ts",
  ]);
  const charset = await call(
    { "content-type": "application/json; charset=utf-8" },
    args,
  );
  expect([charset.status, await charset.text()]).toEqual([200, answer]);
  // fetch says text/plain for a string, and a form's type for its fields: what a page of another
  // site can send with no preflight
  const refused = [
    await call({}, args),
    await call({ "content-type": "text/plain" }, args),
    await call({}, new URLSearchParams({ target: "tiny:src/core/graph.ts" })),
  ];
  for (const r of refused) {
    expect([r.status, JSON.parse(await r.text()).error]).toEqual([
      415,
      {
        code: "invalid_argument",
        message: "a tool call takes application/json only",
        field: "content-type",
      },
    ]);
  }
});

it("every answer carries the security headers, text answers are plain text, and none carries a CORS header", async () => {
  const headers = { "x-hakutaku-session": session };
  const answers: Array<[Response, number, string | null]> = [
    [await fetch(`http://127.0.0.1:${port}/`), 200, null],
    [await fetch(`http://127.0.0.1:${port}/assets/app.css`), 200, null],
    [await fetch(`http://127.0.0.1:${port}/favicon.ico`), 404, null],
    [await api(headers), 200, null],
    [await api(), 403, "forbidden\n"],
    [
      await fetch(`http://127.0.0.1:${port}/api/tool/code_explain`, {
        method: "POST",
        headers,
        body: "x".repeat(MAX_BODY_BYTES + 1),
      }),
      413,
      "payload too large\n",
    ],
    [
      await fetch(`http://127.0.0.1:${port}/assets/app.js`, {
        method: "DELETE",
      }),
      405,
      "method not allowed\n",
    ],
    [
      await fetch(`http://127.0.0.1:${port}/api/map`, {
        method: "OPTIONS",
        headers,
      }),
      405,
      "method not allowed\n",
    ],
  ];
  for (const [r, status, text] of answers) {
    expect(r.status, r.url).toBe(status);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      expect(r.headers.get(k), `${r.url} ${k}`).toBe(v);
    }
    expect(
      [...r.headers.keys()].filter((k) => k.startsWith("access-control-")),
    ).toEqual([]);
    if (text !== null) {
      expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await r.text()).toBe(text);
    } else {
      await r.arrayBuffer();
    }
  }
  const misdirected = await new Promise<{
    status: number;
    headers: Record<string, unknown>;
    body: string;
  }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/map",
        headers: { host: "evil.example", ...headers },
        setHost: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
  expect([misdirected.status, misdirected.body]).toEqual([
    421,
    "misdirected request\n",
  ]);
  expect(misdirected.headers["content-type"]).toBe("text/plain; charset=utf-8");
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    expect(misdirected.headers[k], k).toBe(v);
  }
});

it("answers a request it cannot parse with 400 and the security headers, then closes", async () => {
  const answer = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(port), "127.0.0.1", () => {
      socket.end("NOT HTTP AT ALL\r\n\r\n");
    });
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
  const [head = "", body] = answer.split("\r\n\r\n");
  const [status, ...fields] = head.split("\r\n");
  expect([status, body]).toEqual(["HTTP/1.1 400 Bad Request", "bad request\n"]);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    expect(fields, k).toContain(`${k}: ${v}`);
  }
  expect(fields).toContain("content-type: text/plain; charset=utf-8");
  expect(fields).toContain("connection: close");
});

it("openBrowser hands the platform opener, without a shell, a page only this user can read that sends the browser on to the link, and never the link itself", () => {
  // a link as the server makes it, with a session of 43 characters, and one whose characters
  // markup reads, each with the link as the page must write it in an attribute
  const link = `http://127.0.0.1:1/?s=${"Ab9_-".repeat(8)}xyz`;
  const odd = "http://127.0.0.1:1/?s=a&b\"c<d>'e";
  const rows: Array<[url: string, href: string]> = [
    [link, link],
    [odd, "http://127.0.0.1:1/?s=a&amp;b&quot;c&lt;d&gt;&#39;e"],
  ];
  const openers = [
    ["linux", "xdg-open"],
    ["darwin", "open"],
  ] as const;
  for (const [platform, opener] of openers) {
    for (const [url, href] of rows) {
      const dir = pagesDir();
      const { spawn, handed } = recorder();
      const warned: string[] = [];
      const opened = openBrowser(url, {
        platform,
        spawn,
        dir,
        warn: (line) => {
          warned.push(line);
        },
      });
      try {
        expect(warned).toEqual([]);
        expect(handed.map((h) => h.command)).toEqual([opener]);
        const [h] = handed;
        // one argument, which other users of the machine can read: a page's path, in a fresh
        // directory of its own, with nothing of the link in it
        expect(h.args).toHaveLength(1);
        const [path = ""] = h.args;
        expect([isAbsolute(path), dirname(dirname(path)), path]).toEqual([
          true,
          dir,
          expect.stringMatching(/\.html$/),
        ]);
        expect(h.args.join(" ")).not.toContain("?s=");
        expect(h.args.join(" ")).not.toContain(url);
        expect(h.args.join(" ")).not.toContain("Ab9_-Ab9_-");
        // the page: readable by this user alone, in a directory only this user can enter, and
        // sending the browser on to the link, or letting a click do it
        expect([h.dirMode, h.pageMode]).toEqual([0o700, 0o600]);
        expect(h.page).toContain(
          `<meta http-equiv="refresh" content="0; url=${href}">`,
        );
        expect(h.page).toContain(`<a href="${href}">`);
        expect(h.options).toMatchObject({ detached: true, stdio: "ignore" });
        expect(h.options.shell).toBeUndefined();
      } finally {
        opened.remove();
      }
      // removed: the page and its directory
      expect(readdirSync(dir)).toEqual([]);
    }
  }
});

it("removes the page once the browser has had time to read it, or as the process exits, and keeps no exit hook after", () => {
  const hooks = process.listeners("exit");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const dir = pagesDir();
    const opened = openBrowser("http://127.0.0.1:1/?s=x", {
      platform: "linux",
      spawn: recorder().spawn,
      dir,
    });
    expect(readdirSync(dir)).toHaveLength(1);
    expect(process.listeners("exit")).toHaveLength(hooks.length + 1);
    vi.advanceTimersByTime(OPEN_PAGE_KEEP_MS - 1);
    expect(readdirSync(dir)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(process.listeners("exit")).toEqual(hooks);
    // removing it again does nothing
    expect(() => opened.remove()).not.toThrow();
  } finally {
    vi.useRealTimers();
  }
  // a process that exits before then removes it on its way out
  const dir = pagesDir();
  openBrowser("http://127.0.0.1:1/?s=x", {
    platform: "linux",
    spawn: recorder().spawn,
    dir,
  });
  const added = process.listeners("exit").filter((l) => !hooks.includes(l));
  expect([added.length, readdirSync(dir).length]).toEqual([1, 1]);
  (added[0] as (code: number) => void)(0);
  expect(readdirSync(dir)).toEqual([]);
  expect(process.listeners("exit")).toEqual(hooks);
});

it("a browser that cannot be opened only warns, and leaves no page behind", () => {
  const hooks = process.listeners("exit").length;
  const warned: string[] = [];
  const warn = (line: string) => {
    warned.push(line);
  };
  // the opener cannot be started
  const thrown = pagesDir();
  const throwing = (() => {
    throw Object.assign(new Error("spawn xdg-open EACCES"), {
      code: "EACCES",
    });
  }) as never;
  expect(() =>
    openBrowser("http://127.0.0.1:1/?s=x", {
      platform: "linux",
      spawn: throwing,
      warn,
      dir: thrown,
    }),
  ).not.toThrow();
  expect(readdirSync(thrown)).toEqual([]);
  // the opener fails once started
  const failed = pagesDir();
  let onError: ((e: Error) => void) | undefined;
  let unrefs = 0;
  const failing = (() => ({
    unref() {
      unrefs++;
    },
    on(event: string, listener: (e: Error) => void) {
      if (event === "error") onError = listener;
    },
  })) as never;
  openBrowser("http://127.0.0.1:1/?s=x", {
    platform: "linux",
    spawn: failing,
    warn,
    dir: failed,
  });
  expect([unrefs, readdirSync(failed).length]).toEqual([1, 1]);
  onError?.(
    Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }),
  );
  expect(readdirSync(failed)).toEqual([]);
  // no opener on this platform: no page is written
  const none = pagesDir();
  let spawned = 0;
  openBrowser("http://127.0.0.1:1/?s=x", {
    platform: "win32",
    spawn: (() => {
      spawned++;
    }) as never,
    warn,
    dir: none,
  });
  expect([spawned, readdirSync(none)]).toEqual([0, []]);
  // no page can be written: the opener is never asked, least of all with the link
  const { spawn, handed } = recorder();
  openBrowser("http://127.0.0.1:1/?s=x", {
    platform: "linux",
    spawn,
    warn,
    dir: join(pagesDir(), "missing"),
  });
  expect(handed).toEqual([]);
  expect(warned).toHaveLength(4);
  expect(warned[0]).toContain("EACCES");
  expect(warned[1]).toContain("ENOENT");
  expect(warned[2]).toContain("win32");
  expect(warned[3]).toContain("ENOENT");
  expect(process.listeners("exit")).toHaveLength(hooks);
});

it("close() stops listening", async () => {
  const t = await startViewerServer({
    host: tinyHost(tinyStore()),
    repo: "tiny",
    open: false,
  });
  await t.close();
  await expect(fetch(t.url)).rejects.toThrow();
});

it("close() also ends a connection whose request is still arriving", async () => {
  const t = await startViewerServer({
    host: tinyHost(tinyStore()),
    repo: "tiny",
    open: false,
  });
  const socket = connect(Number(new URL(t.url).port), "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  const ended = new Promise<void>((resolve) => socket.once("close", resolve));
  socket.on("error", () => {});
  // a request line and no end of headers: the server waits for the rest
  socket.write("GET / HTTP/1.1\r\n");
  const closed = await Promise.race([
    t.close().then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("still open"), 2000)),
  ]);
  socket.destroy();
  await ended;
  expect(closed).toBe("closed");
});
