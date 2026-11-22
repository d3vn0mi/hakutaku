// hakutaku view <id> [--open] [--export <file.html> [--with-source]]
// Serves the map of one registered repo in a browser: the viewer's page and its API on 127.0.0.1
// at a free port, until the process is interrupted (SIGINT or SIGTERM). The one stdout line is
// the link, which carries the session the API asks for; --open also opens it in the platform's
// browser. The repo's store is opened on every request, so a rebuild is served as soon as it is
// swapped in. Exit codes: 0 once the server has closed, 1 failed (the message on stderr), as when
// the repo has no usable store, 2 a usage error.
import { parseArgs } from "node:util";
import { REPO_ID_RE } from "../../model/index.js";
import {
  findEntry,
  registryHost,
  storePathFor,
  UnknownRepoError,
} from "../../registry/index.js";
import { openStore } from "../../store/index.js";
import { startViewerServer } from "../../viewer/server.js";
import { printable } from "../table.js";
import type { CliIO, Command } from "./index.js";

const USAGE =
  "usage: hakutaku view <id> [--open] [--export <file.html> [--with-source]]\n";

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    options: {
      open: { type: "boolean" },
      export: { type: "string" },
      "with-source": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });

function usageError(io: CliIO, message: string): number {
  io.stderr(`hakutaku view: ${printable(message)}\n${USAGE}`);
  return 2;
}

async function run(argv: string[], io: CliIO): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return usageError(
      io,
      error instanceof Error ? error.message : String(error),
    );
  }
  const { values, positionals } = parsed;
  const [id] = positionals;
  if (id === undefined) return usageError(io, "name the repo to view");
  if (positionals.length > 1) return usageError(io, "name one repo");
  if (!REPO_ID_RE.test(id)) {
    return usageError(io, `not a repo id: ${JSON.stringify(id)}`);
  }
  const exporting = values.export !== undefined;
  if (values["with-source"] === true && !exporting) {
    return usageError(io, "--with-source goes with --export");
  }
  if (values.open === true && exporting) {
    return usageError(io, "pass --open or --export, not both");
  }
  const entry = findEntry(id);
  if (entry === null) {
    io.stderr(`hakutaku view: unknown repo: ${id}\n`);
    return 2;
  }
  if (exporting) return usageError(io, "--export is not available yet");

  const store = openStore(storePathFor(id));
  if ("code" in store) {
    io.stderr(
      `hakutaku view: ${id} is not built (${printable(store.reason)}); run: hakutaku map ${printable(entry.source)}\n`,
    );
    return 1;
  }
  store.close();
  let host: ReturnType<typeof registryHost>;
  try {
    host = registryHost({ repos: [id], allowRefresh: false });
  } catch (error) {
    if (!(error instanceof UnknownRepoError)) throw error;
    io.stderr(`hakutaku view: ${printable(error.message)}\n`);
    return 2;
  }
  // Listening for the signals before the link is printed: whoever reads the link may stop the
  // server at once.
  const stop = stopSignal();
  let server: Awaited<ReturnType<typeof startViewerServer>>;
  try {
    server = await startViewerServer({
      host,
      repo: id,
      open: values.open === true,
    });
  } catch (error) {
    stop.release();
    throw error;
  }
  io.stdout(`${server.url}\n`);
  await stop.signalled;
  await server.close();
  return 0;
}

// Resolves on the first SIGINT or SIGTERM, then stops listening for both, so that a second one
// ends the process as it would by default.
function stopSignal(): { signalled: Promise<void>; release(): void } {
  let release = (): void => {};
  const signalled = new Promise<void>((resolve) => {
    const stop = (): void => {
      release();
      resolve();
    };
    release = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return { signalled, release };
}

export const view: Command = {
  name: "view",
  summary: "serve the map in a browser, or export it as one page",
  run,
};
