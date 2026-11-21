// The code, test and test-support files of a store, per language: code_repos' languages, the
// same counts as code_overview's repo answer gives. One aggregate over the files table, so
// listing the repos builds no index of any store. coverage.indexed counts something else: the
// files whose imports an import engine read.
import { comparePaths, type Lang } from "../model/index.js";
import type { Store } from "../store/index.js";

export function fileLanguages(store: Store): Record<Lang, number> {
  const rows = store.db
    .prepare(
      "SELECT lang, COUNT(*) AS n FROM files WHERE kind IN ('code', 'test', 'test-support') AND lang IS NOT NULL GROUP BY lang",
    )
    .all() as unknown as Array<{ lang: Lang; n: number | bigint }>;
  // by language id in path order, as code_overview writes them
  return Object.fromEntries(
    rows
      .map(({ lang, n }): [Lang, number] => [lang, Number(n)])
      .sort(([a], [b]) => comparePaths(a, b)),
  );
}
