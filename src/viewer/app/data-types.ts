// The data the browser app reads, and the one place it reads it from. No DOM type here: Node
// tests import this module.
import type { Id } from "../../model/types.js";
import type {
  HistoryData,
  MapData,
  OutlineData,
  SourceData,
} from "../../query/view/types.js";
import type { ToolError } from "../../tools/errors.js";
import type { ToolName } from "../../tools/types.js";

// A tool's answer as the Agent tab shows it: the response's status and its text, exactly as it
// came, and the build it comes from (MapData's build), or null when the answer names none. Status
// 0 means that no answer is available here.
export interface ToolReply {
  ok: boolean;
  status: number;
  text: string;
  build: string | null;
}

// Where the page's data comes from: the viewer's API over HTTP, or a page's embedded data.
export interface DataSource {
  readonly kind: "http" | "embedded";
  map(): Promise<MapData>;
  outline(file: Id): Promise<OutlineData>;
  source(file: Id): Promise<SourceData>;
  history(): Promise<HistoryData>;
  tool(name: ToolName, args: Record<string, unknown>): Promise<ToolReply>;
}

// A call that brought no data: the status of the answer (0 when none came), the error, as the
// API wrote it or, for an answer that carried none, as the page describes it, and the build the
// answer comes from, or null when it names none.
export class ApiError extends Error {
  readonly status: number;
  readonly error: ToolError;
  readonly build: string | null;

  constructor(status: number, error: ToolError, build: string | null = null) {
    super(error.message);
    this.name = "ApiError";
    this.status = status;
    this.error = error;
    this.build = build;
  }
}
