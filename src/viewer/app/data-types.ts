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
// came. Status 0 means that no answer is available here.
export interface ToolReply {
  ok: boolean;
  status: number;
  text: string;
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

// A call that brought no data: the status of the answer (0 when none came) and the error, as the
// API wrote it or, for an answer that carried none, as the page describes it.
export class ApiError extends Error {
  readonly status: number;
  readonly error: ToolError;

  constructor(status: number, error: ToolError) {
    super(error.message);
    this.name = "ApiError";
    this.status = status;
    this.error = error;
  }
}
