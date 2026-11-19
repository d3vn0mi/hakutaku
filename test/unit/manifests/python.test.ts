import { expect, it } from "vitest";
import { readEntryPoints } from "../../../src/manifests/index.js";
import { input, SIM } from "./input.js";

const script = (
  file: string,
  qualname: string | null,
  manifest: string,
  line: number,
  name: string,
) => ({ file, qualname, kind: "console-script", manifest, line, name });

it("maps a console script to its file and function", () =>
  expect(
    readEntryPoints(
      input(
        {
          "sim/pyproject.toml": [
            "[project]", // 1
            'name = "observatory"', // 2
            "", // 3
            "[project.scripts]", // 4
            'ephemeris = "observatory.ephemeris.cli:main"', // 5
          ].join("\n"),
          "sim/src/observatory/__init__.py": "",
          "sim/src/observatory/ephemeris/cli.py": "",
        },
        { profile: SIM },
      ),
    ),
  ).toEqual([
    script(
      "sim/src/observatory/ephemeris/cli.py",
      "main",
      "sim/pyproject.toml",
      5,
      "ephemeris",
    ),
  ]));

it("reads setup.cfg console_scripts with their own lines", () =>
  expect(
    readEntryPoints(
      input(
        {
          "sim/setup.cfg": [
            "[metadata]", // 1
            "name = observatory", // 2
            "", // 3
            "[options.entry_points]", // 4
            "console_scripts =", // 5
            "    ephemeris = observatory.ephemeris.cli:main", // 6
            "", // 7
            "    rebuild = observatory.tools.rebuild:run", // 8
            "gui_scripts = sky-view = observatory.view:App.run", // 9
            "observatory.plugins =", // 10: another group, not read
            "    aurora = observatory.view:load", // 11
          ].join("\n"),
          "sim/setup.py": "",
          "sim/src/observatory/ephemeris/cli.py": "",
          "sim/src/observatory/tools/rebuild.py": "",
          "sim/src/observatory/view.py": "",
        },
        { profile: SIM },
      ),
    ),
  ).toEqual([
    script(
      "sim/src/observatory/ephemeris/cli.py",
      "main",
      "sim/setup.cfg",
      6,
      "ephemeris",
    ),
    script(
      "sim/src/observatory/tools/rebuild.py",
      "run",
      "sim/setup.cfg",
      8,
      "rebuild",
    ),
    script(
      "sim/src/observatory/view.py",
      "App.run",
      "sim/setup.cfg",
      9,
      "sky-view",
    ),
  ]));

it("reads gui scripts, entry points and poetry scripts at the line of each key that counts", () =>
  expect(
    readEntryPoints(
      input(
        {
          "sim/pyproject.toml": [
            "[project]", // 1
            'name = "observatory"', // 2
            'readme = """', // 3
            "[project.scripts]", // 4: inside a string, not a header
            'ephemeris = "observatory.ephemeris.cli:main"', // 5
            '"""', // 6
            "scripts = {", // 7: an inline table over three lines
            '  ephemeris = "observatory.ephemeris.cli:main",', // 8
            "}", // 9
            "", // 10
            "[project.gui-scripts]", // 11
            '"sky-view" = "observatory.view:App.run [gui]"', // 12
            "", // 13
            '[project.entry-points."observatory.plugins"]', // 14
            'aurora = "observatory.plugins.aurora"', // 15: a module, no function
            'aurora = "observatory.plugins.other:load"', // 16: a repeated key keeps the first
            "", // 17
            "[tool.poetry]", // 18
            'scripts.rebuild = "observatory.tools.rebuild:run"', // 19
            'scripts.skyctl = { callable = "skyctl:main" }', // 20: not a string
          ].join("\n"),
          "sim/src/observatory/ephemeris/cli.py": "",
          "sim/src/observatory/view.py": "",
          "sim/src/observatory/plugins/aurora.py": "",
          "sim/src/observatory/plugins/other.py": "",
          "sim/src/observatory/tools/rebuild.py": "",
          "sim/src/skyctl.py": "",
        },
        { profile: SIM },
      ),
    ),
  ).toEqual([
    script(
      "sim/src/observatory/ephemeris/cli.py",
      "main",
      "sim/pyproject.toml",
      8,
      "ephemeris",
    ),
    script(
      "sim/src/observatory/plugins/aurora.py",
      null,
      "sim/pyproject.toml",
      15,
      "aurora",
    ),
    script(
      "sim/src/observatory/tools/rebuild.py",
      "run",
      "sim/pyproject.toml",
      19,
      "rebuild",
    ),
    script(
      "sim/src/observatory/view.py",
      "App.run",
      "sim/pyproject.toml",
      12,
      "sky-view",
    ),
  ]));
