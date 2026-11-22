// historyData: the store's timeline, the commits of each of the 26 weeks before the built
// commit, oldest first.
import type { Store } from "../../store/index.js";
import { builtCommitOf, rows } from "./lookup.js";
import type { HistoryData } from "./types.js";

const WEEKS_SQL =
  "SELECT week_start, commits FROM timeline ORDER BY week_start";

export function historyData(store: Store): HistoryData {
  return {
    builtCommit: builtCommitOf(store),
    weeks: rows<{ week_start: number; commits: number }>(store, WEEKS_SQL).map(
      (w) => ({ start: w.week_start, commits: w.commits }),
    ),
  };
}
