import { expect, it } from "vitest";
import { readEntryPoints } from "../../../src/manifests/index.js";
import type { EntryKind } from "../../../src/model/index.js";
import { input } from "./input.js";

// A secondary signal: the file is its own manifest, and its path its name, except for routes.
const own = (file: string, kind: EntryKind, line: number, name = file) => ({
  file,
  qualname: null,
  kind,
  manifest: file,
  line,
  name,
});

it("finds executables, main guards and Next.js routes", () =>
  expect(
    readEntryPoints(
      input(
        {
          "scripts/sync-sky.sh": "#!/usr/bin/env bash\nset -eu\n",
          "sim/src/observatory/__main__.py":
            "from observatory.ephemeris.cli import main\n\nmain()\n",
          "sim/src/observatory/tools/rebuild.py":
            'import sys\n\n\ndef run():\n    pass\n\n\nif __name__ == "__main__":\n    run()\n',
          "web/package.json":
            '{ "name": "@obs/web", "dependencies": { "next": "15.0.0" } }',
          "web/app/page.tsx": "",
          "web/app/api/stars/route.ts": "",
        },
        { modes: { "scripts/sync-sky.sh": "100755" } },
      ),
    ),
  ).toEqual([
    own("scripts/sync-sky.sh", "executable", 1),
    own("sim/src/observatory/__main__.py", "main-guard", 1),
    own("sim/src/observatory/tools/rebuild.py", "main-guard", 8),
    own("web/app/api/stars/route.ts", "route", 1, "/api/stars"),
    own("web/app/page.tsx", "route", 1, "/"),
  ]));

it("takes a 100755 file only with a shebang, and a main guard only at the start of a line", () =>
  expect(
    readEntryPoints(
      input(
        {
          "scripts/no-shebang.sh": "set -eu\n",
          "scripts/not-executable.sh": "#!/bin/sh\n",
          "scripts/skyctl": "#!/usr/bin/env python3\n",
          "scripts/link": "#!/bin/sh\n",
          "scripts/large": null,
          "tools/nested.py":
            'def main():\n    if __name__ == "__main__":\n        pass\n',
          "tools/quoted.py": "\uFEFFif __name__ == '__main__':\n    pass\n",
          "tools/spaced.py": 'x = 1\nif  __name__=="__main__" : x\n',
          "tools/other.py": 'if __name__ == "__other__":\n    pass\n',
          "tools/stub.pyi": 'if __name__ == "__main__": ...\n',
        },
        {
          modes: {
            "scripts/no-shebang.sh": "100755",
            "scripts/skyctl": "100755",
            "scripts/link": "120000",
            "scripts/large": "100755",
          },
        },
      ),
    ),
  ).toEqual([
    own("scripts/skyctl", "executable", 1),
    own("tools/quoted.py", "main-guard", 1),
    own("tools/spaced.py", "main-guard", 2),
  ]));

it("routes the app/ and pages/ files of a package that depends on next, by URL path", () =>
  expect(
    readEntryPoints(
      input({
        "web/package.json": '{ "devDependencies": { "next": "15.0.0" } }',
        "web/app/(sky)/stars/page.tsx": "",
        "web/app/@modal/login/page.jsx": "",
        "web/app/_parts/page.tsx": "",
        "web/app/layout.tsx": "",
        "web/app/notes/page.md": "",
        "web/pages/index.tsx": "",
        "web/pages/blog/index.js": "",
        "web/pages/api/stars.ts": "",
        "web/pages/_app.tsx": "",
        "web/src/app/page.tsx": "",
        "site/package.json": '{ "dependencies": { "react": "19.0.0" } }',
        "site/app/page.tsx": "",
      }),
    ),
  ).toEqual([
    own("web/app/(sky)/stars/page.tsx", "route", 1, "/stars"),
    own("web/app/@modal/login/page.jsx", "route", 1, "/login"),
    own("web/pages/_app.tsx", "route", 1, "/_app"),
    own("web/pages/api/stars.ts", "route", 1, "/api/stars"),
    own("web/pages/blog/index.js", "route", 1, "/blog"),
    own("web/pages/index.tsx", "route", 1, "/"),
  ]));
