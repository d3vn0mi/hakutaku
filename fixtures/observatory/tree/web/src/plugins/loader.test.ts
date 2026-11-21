import { expect, it } from "vitest";
import { loadPlugins } from "./loader";

it("reports a plugin that cannot be loaded, and goes on", async () => {
  const reports: string[] = [];
  const names = await loadPlugins(
    [{ dir: "/nonexistent/plugins/missing", entry: "./index.js" }],
    (message) => reports.push(message),
  );
  expect(names).toEqual([]);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatch(/^plugin \/nonexistent\/plugins\/missing: /);
});
