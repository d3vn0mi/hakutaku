// startViewerServer: the viewer's own server, which hakutaku view runs. It listens on 127.0.0.1 at
// a free port and serves one repo: the page and its assets to whoever reaches it, and the API only
// to a caller that sends the session the link carries. Every request must name this address and
// port in its Host header, so that a page of another site, reached through a DNS name that
// resolves to 127.0.0.1, cannot talk to it. It sends no CORS header, answers no preflight, and
// nothing it serves writes. openBrowser: the platform's opener, for --open.
//
// Not exported by the library: a host that mounts the viewer serves viewerApi and viewerStatic
// with its own server and its own authentication.
import { spawn as spawnProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { RepoId } from "../model/index.js";
import { printable } from "../redact/printable.js";
import type { Host } from "../tools/index.js";
import { viewerApi } from "./api.js";
import { SECURITY_HEADERS } from "./csp.js";
import { viewerStatic } from "./static.js";
import type { ViewerResponse } from "./types.js";

// The largest request body the API reads; the tools' arguments are far smaller.
export const MAX_BODY_BYTES = 65_536;

const API = "/api/";
const SESSION_HEADER = "x-hakutaku-session";
const TEXT = "text/plain; charset=utf-8";

interface Served {
  host: Host;
  repo: RepoId;
  port: number;
  session: Buffer;
}

export function startViewerServer(opts: {
  host: Host;
  repo: RepoId;
  open: boolean;
}): Promise<{ url: string; close(): Promise<void> }> {
  const session = randomBytes(32).toString("base64url");
  const served: Served = {
    host: opts.host,
    repo: opts.repo,
    port: 0,
    session: Buffer.from(session, "utf8"),
  };
  const server = createServer((req, res) => {
    try {
      handle(served, req, res);
    } catch (err) {
      fail(res, err);
    }
  });
  server.on("clientError", refuseMalformed);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      server.on("error", (err) => {
        console.error("hakutaku view:", err);
      });
      served.port = (server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${served.port}/?s=${session}`;
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        closing ??= new Promise<void>((done, failed) => {
          server.close((err) => (err === undefined ? done() : failed(err)));
          server.closeAllConnections();
        });
        return closing;
      };
      if (opts.open) openBrowser(url);
      resolve({ url, close });
    });
  });
}

// The rules, in order: the Host header; no preflight; the API, behind the session and the body
// cap; then the page and its assets, by GET only.
function handle(
  served: Served,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const named = (req.headers.host ?? "").toLowerCase();
  if (
    named !== `127.0.0.1:${served.port}` &&
    named !== `localhost:${served.port}`
  ) {
    text(res, 421, "misdirected request\n");
    return;
  }
  if (req.method === "OPTIONS") {
    text(res, 405, "method not allowed\n");
    return;
  }
  // The request target as sent, split at "?" by hand: no URL parser resolves its dot segments,
  // decodes its path or reads "//name" as a host.
  const target = req.url ?? "";
  if (!target.startsWith("/") || target.startsWith("//")) {
    text(res, 400, "bad request\n");
    return;
  }
  const mark = target.indexOf("?");
  const path = mark < 0 ? target : target.slice(0, mark);
  if (path.startsWith(API)) {
    if (!hasSession(req, served.session)) {
      text(res, 403, "forbidden\n");
      return;
    }
    readBody(req, (body) => {
      if (body === null) {
        text(res, 413, "payload too large\n");
        return;
      }
      try {
        send(
          res,
          viewerApi(served.host, null, served.repo, {
            method: req.method ?? "",
            path: path.slice(API.length),
            query: firstValues(mark < 0 ? "" : target.slice(mark + 1)),
            ...(body.length > 0 ? { body: body.toString("utf8") } : {}),
          }),
        );
      } catch (err) {
        fail(res, err);
      }
    });
    return;
  }
  if (req.method !== "GET") {
    text(res, 405, "method not allowed\n");
    return;
  }
  send(res, viewerStatic(path.slice(1), { base: "/" }));
}

// The session header, compared in constant time once the lengths agree.
function hasSession(req: IncomingMessage, session: Buffer): boolean {
  const given = req.headers[SESSION_HEADER];
  if (typeof given !== "string") return false;
  const bytes = Buffer.from(given, "utf8");
  return bytes.length === session.length && timingSafeEqual(bytes, session);
}

// The whole body, or null once it is over the cap. A body declared too large is refused before
// a byte of it is read. The rest of a refused body is still read and dropped, never left on the
// socket: closing a socket that holds unread data resets the connection, and the client could
// lose the answer.
function readBody(
  req: IncomingMessage,
  done: (body: Buffer | null) => void,
): void {
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
    req.resume();
    done(null);
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  req.on("data", (chunk: Buffer) => {
    if (over) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      over = true;
      chunks.length = 0;
      done(null);
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (!over) done(Buffer.concat(chunks, size));
  });
  // A client that goes away mid-body gets no answer; there is nothing left to answer.
  req.on("error", () => {});
}

// The first value of each query parameter, in an object with no prototype, so that no parameter
// name reaches Object.prototype.
function firstValues(search: string): Record<string, string> {
  const query: Record<string, string> = Object.create(null);
  for (const [key, value] of new URLSearchParams(search)) {
    if (!Object.hasOwn(query, key)) query[key] = value;
  }
  return query;
}

function send(res: ServerResponse, r: ViewerResponse): void {
  res.writeHead(r.status, { ...SECURITY_HEADERS, ...r.headers });
  res.end(r.body);
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": TEXT });
  res.end(body);
}

// viewerApi and viewerStatic never throw for a request, so this is a bug: its details go to the
// log only.
function fail(res: ServerResponse, err: unknown): void {
  console.error("hakutaku view:", err);
  if (res.headersSent) {
    res.destroy();
  } else {
    text(res, 500, "internal error\n");
  }
}

// A request Node cannot parse gets a 400 that carries the security headers too, then the
// connection closes.
const MALFORMED = [
  "HTTP/1.1 400 Bad Request",
  ...Object.entries({ ...SECURITY_HEADERS, "content-type": TEXT }).map(
    ([k, v]) => `${k}: ${v}`,
  ),
  "content-length: 12",
  "connection: close",
  "",
  "bad request\n",
].join("\r\n");

function refuseMalformed(_err: Error, socket: Socket): void {
  if (socket.writable) {
    socket.end(MALFORMED);
  } else {
    socket.destroy();
  }
}

// Opens url in the platform's browser: xdg-open on Linux, open on macOS, as a detached process
// with no shell and no stdio, which this process does not wait for. A failure only warns.
export function openBrowser(
  url: string,
  deps: {
    platform?: NodeJS.Platform;
    spawn?: typeof import("node:child_process").spawn;
    warn?: (line: string) => void;
  } = {},
): void {
  const platform = deps.platform ?? process.platform;
  const warn =
    deps.warn ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  const opener =
    platform === "linux" ? "xdg-open" : platform === "darwin" ? "open" : null;
  if (opener === null) {
    warn(
      `hakutaku view: no browser opener on ${platform}; open the link yourself`,
    );
    return;
  }
  const failed = (err: unknown): void => {
    warn(
      `hakutaku view: could not open a browser (${printable(reasonOf(err))}); open the link yourself`,
    );
  };
  try {
    const child = (deps.spawn ?? spawnProcess)(opener, [url], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", failed);
    child.unref();
  } catch (err) {
    failed(err);
  }
}

const reasonOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code !== "") return code;
  return err instanceof Error ? err.message : String(err);
};
