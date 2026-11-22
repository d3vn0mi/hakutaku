// The viewer's own server, as hakutaku view runs it: on loopback at a free port, the API only for
// the session the link carries, every request's Host header checked, no CORS, and a cap on
// request bodies. openBrowser runs the platform's opener without a shell.
import { request } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runTool } from "../../../src/tools/index.js";
import { SECURITY_HEADERS, VIEWER_CSP } from "../../../src/viewer/csp.js";
import {
  MAX_BODY_BYTES,
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
          headers: { "x-hakutaku-session": session },
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
  const tool = await fetch(`http://127.0.0.1:${port}/api/tool/code_explain`, {
    method: "POST",
    headers,
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
    headers,
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

it("openBrowser runs the platform opener without a shell", () => {
  const calls: unknown[][] = [];
  const spawn = ((...a: unknown[]) => {
    calls.push(a);
    return { unref() {}, on() {} };
  }) as never;
  openBrowser("http://127.0.0.1:1/?s=x", { platform: "linux", spawn });
  openBrowser("http://127.0.0.1:1/?s=x", { platform: "darwin", spawn });
  expect(calls.map((c) => [c[0], c[1]])).toEqual([
    ["xdg-open", ["http://127.0.0.1:1/?s=x"]],
    ["open", ["http://127.0.0.1:1/?s=x"]],
  ]);
  for (const c of calls) {
    expect(c[2]).toMatchObject({ detached: true, stdio: "ignore" });
    expect((c[2] as { shell?: unknown }).shell).toBeUndefined();
  }
});

it("a browser that cannot be opened only warns", () => {
  const warned: string[] = [];
  const warn = (line: string) => {
    warned.push(line);
  };
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
    }),
  ).not.toThrow();
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
  });
  expect(unrefs).toBe(1);
  onError?.(
    Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }),
  );
  let spawned = 0;
  openBrowser("http://127.0.0.1:1/?s=x", {
    platform: "win32",
    spawn: (() => {
      spawned++;
    }) as never,
    warn,
  });
  expect(spawned).toBe(0);
  expect(warned).toHaveLength(3);
  expect(warned[0]).toContain("EACCES");
  expect(warned[1]).toContain("ENOENT");
  expect(warned[2]).toContain("win32");
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
