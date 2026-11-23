// What an exported page holds in its data block: the map, its history, the tools' own answers for
// every node and, when asked for, the redacted sources. Types only, with no Node and no DOM: the
// export writes it, and the browser app, which bundles none of the export's code, reads it.
import type { Id } from "../model/types.js";
import type { HistoryData, MapData, SourceData } from "../query/view/types.js";

// One node's answer for the Agent tab: the call an agent makes, as callText writes it, and the
// text the tool answered, its answer or its error, as indented JSON; ok is false for an error.
export interface StoredAnswer {
  call: string;
  text: string;
  ok: boolean;
}

export interface StaticBundle {
  format: 1;
  map: MapData;
  history: HistoryData;
  // by file ID; null when the page holds no source
  sources: Record<Id, SourceData> | null;
  // by the node's ID; null when the repo has more production files than the page answers for
  agent: Record<Id, StoredAnswer> | null;
}
