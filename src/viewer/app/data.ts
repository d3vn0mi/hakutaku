// The page's data: over HTTP, the viewer's API at the address the page names, with the session
// from the page's own address when it carries one; or, in an exported page, the data block the
// page holds (embedded.ts).
import type { Id } from "../../model/types.js";
import type {
  HistoryData,
  MapData,
  OutlineData,
  SourceData,
} from "../../query/view/types.js";
import type { ToolError } from "../../tools/errors.js";
import type { ToolName } from "../../tools/types.js";
import { ApiError, type DataSource, type ToolReply } from "./data-types.js";
import { embeddedSource, parseEmbedded } from "./embedded.js";

export { embeddedSource } from "./embedded.js";

const SESSION_HEADER = "x-hakutaku-session";
// The data block an exported page holds, right before its script.
const DATA_BLOCK = 'script#hakutaku-data[type="application/json"]';

// The error an answer's body carries, when it is the API's { "error": ToolError }.
function errorIn(text: string): ToolError | null {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null || !("error" in body)) {
      return null;
    }
    const error: unknown = body.error;
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      "message" in error &&
      typeof error.message === "string"
      ? (error as ToolError)
      : null;
  } catch {
    return null;
  }
}

// The API under apiBase, which ends in "/". Every call carries x-hakutaku-session when session
// is given. A data call that brings no data rejects with an ApiError: the API's own error, or
// for an answer without one (a host's or a proxy's), code internal with the HTTP status.
export function httpSource(apiBase: URL, session: string | null): DataSource {
  const headers: Record<string, string> =
    session === null ? {} : { [SESSION_HEADER]: session };

  const url = (path: string, file?: Id): URL => {
    const u = new URL(path, apiBase);
    if (file !== undefined) u.searchParams.set("file", file);
    return u;
  };

  const send = async (u: URL, init: RequestInit): Promise<Response> => {
    try {
      return await fetch(u, { ...init, cache: "no-store" });
    } catch {
      throw new ApiError(0, {
        code: "internal",
        message: "no answer from the server",
      });
    }
  };

  const get = async <T>(u: URL): Promise<T> => {
    const res = await send(u, { headers });
    const text = await res.text();
    if (!res.ok) {
      throw new ApiError(
        res.status,
        errorIn(text) ?? { code: "internal", message: `HTTP ${res.status}` },
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(res.status, {
        code: "internal",
        message: "the answer is not JSON",
      });
    }
  };

  return {
    kind: "http",
    map: () => get<MapData>(url("map")),
    outline: (file) => get<OutlineData>(url("outline", file)),
    source: (file) => get<SourceData>(url("source", file)),
    history: () => get<HistoryData>(url("history")),
    tool: async (
      name: ToolName,
      args: Record<string, unknown>,
    ): Promise<ToolReply> => {
      const res = await send(url(`tool/${name}`), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      return { ok: res.ok, status: res.status, text: await res.text() };
    },
  };
}

// The data source this page names: the data block it holds, when it is an exported page; else the
// API address in its hakutaku-api meta tag, resolved against the page's origin (api/ under the
// document's base when there is none), and the session from its own address's s parameter.
// Throws an ApiError when the data block is not a page's map.
export function pickSource(doc: Document, loc: Location): DataSource {
  const block = doc.querySelector(DATA_BLOCK);
  if (block !== null) {
    return embeddedSource(parseEmbedded(block.textContent ?? ""));
  }
  const api = doc
    .querySelector('meta[name="hakutaku-api"]')
    ?.getAttribute("content");
  const apiBase =
    api === null || api === undefined
      ? new URL("api/", doc.baseURI)
      : new URL(api, loc.origin);
  return httpSource(apiBase, new URLSearchParams(loc.search).get("s"));
}
