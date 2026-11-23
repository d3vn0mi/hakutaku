// The viewer's data over a read-only store: the map, one file's outline, one file's source and
// the history, as the viewer's endpoints answer them. Only the viewer reads these; the agents'
// tools never import them.
export {
  DEF_KINDS,
  ECOSYSTEMS,
  ENTRY_KINDS,
  F,
  FILE_KINDS,
  FLAG_CORE,
  FLAG_ENTRY,
  FLAG_SOURCE,
  IMPORT_KINDS,
  INLINE_OUTLINES_UP_TO,
} from "./constants.js";
export { historyData } from "./history.js";
export { buildOf, fileIdOf } from "./lookup.js";
export { mapData } from "./map.js";
export { outlineData } from "./outline.js";
export { sourceData } from "./source.js";
export type {
  HistoryData,
  MapData,
  MapFile,
  OutlineData,
  SourceData,
} from "./types.js";
