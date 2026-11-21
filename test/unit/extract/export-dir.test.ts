import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { snapshotReader } from "../../../src/extract/export-dir.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A snapshot holding sim/src/observatory/units.py, and a copy of its sim/ outside it.
function snapshot(): { dir: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-snapshot-"));
  made.push(root);
  const dir = join(root, "snapshot");
  mkdirSync(join(dir, "sim", "src", "observatory"), { recursive: true });
  writeFileSync(join(dir, "sim", "src", "observatory", "units.py"), "AU = 1\n");
  const outside = join(root, "outside");
  cpSync(join(dir, "sim"), outside, { recursive: true });
  return { dir, outside };
}

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

it("reads a regular file of the snapshot", () => {
  const { dir } = snapshot();
  expect(text(snapshotReader(dir)("sim/src/observatory/units.py"))).toBe(
    "AU = 1\n",
  );
});

// Export writes no link, so a link anywhere on a path was planted: it is refused, never followed.
it.skipIf(process.platform === "win32")(
  "refuses a link at the file, and a link at any directory above it",
  () => {
    const file = snapshot();
    const units = join(file.dir, "sim", "src", "observatory", "units.py");
    rmSync(units);
    symlinkSync(join(file.outside, "src", "observatory", "units.py"), units);
    expect(() =>
      snapshotReader(file.dir)("sim/src/observatory/units.py"),
    ).toThrow(
      "the snapshot's sim/src/observatory/units.py is not a regular file",
    );

    for (const [parts, named] of [
      [["sim"], "sim"],
      [["sim", "src"], "sim/src"],
      [["sim", "src", "observatory"], "sim/src/observatory"],
    ] as const) {
      const linked = snapshot();
      const at = join(linked.dir, ...parts);
      rmSync(at, { recursive: true });
      symlinkSync(join(linked.outside, ...parts.slice(1)), at);
      expect(() =>
        snapshotReader(linked.dir)("sim/src/observatory/units.py"),
      ).toThrow(`the snapshot's ${named} is not a directory`);
    }
  },
);

it("refuses a path whose directory is a file", () => {
  const { dir } = snapshot();
  expect(() =>
    snapshotReader(dir)("sim/src/observatory/units.py/more.py"),
  ).toThrow("the snapshot's sim/src/observatory/units.py is not a directory");
});
