// The built viewer bundle: the page template and every asset its manifest lists, read once.
// `npm run build` writes it into dist/viewer, next to this module's own built file, so the
// built package finds it beside this module; tests, which run this module from src/viewer,
// find it in the repo's dist/viewer instead.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ViewerBundle {
  page: string; // the template, with {{HEAD}} and {{TAIL}} once each
  assets: ReadonlyMap<string, { type: string; bytes: Uint8Array }>;
}

const HEAD = "{{HEAD}}";
const TAIL = "{{TAIL}}";
// An asset's name is a plain file name: no directory part, and no leading dot.
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

let cached: ViewerBundle | undefined;

// The bundle, read on the first call and kept; null while no usable bundle is found, so that a
// bundle built later is still picked up.
export function readBundle(): ViewerBundle | null {
  if (cached === undefined) {
    const dir = bundleDir();
    const found = dir === null ? null : loadBundle(dir);
    if (found === null) return null;
    cached = found;
  }
  return cached;
}

// The page template with its two placeholders filled. The template holds each exactly once, and
// the text goes in as it is: no replacement pattern in it is ever read.
export function fillPage(template: string, head: string, tail: string): string {
  const [beforeHead, afterHead] = template.split(HEAD);
  const [beforeTail, afterTail] = (afterHead ?? "").split(TAIL);
  return `${beforeHead}${head}${beforeTail}${tail}${afterTail}`;
}

function bundleDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [here, join(here, "../../dist/viewer")]) {
    if (existsSync(join(dir, "manifest.json"))) return dir;
  }
  return null;
}

const count = (text: string, part: string): number =>
  text.split(part).length - 1;

// The bundle in dir, or null when it is missing or does not match its manifest: an unknown page,
// a template without its two placeholders in order, an asset with a name that is not a plain
// file name, or an asset whose size or hash differs.
export function loadBundle(dir: string): ViewerBundle | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8"),
    ) as {
      page: unknown;
      assets: Record<string, { type: string; bytes: number; sha256: string }>;
    };
    if (manifest.page !== "page.html") return null;
    const page = readFileSync(join(dir, "page.html"), "utf8");
    if (count(page, HEAD) !== 1 || count(page, TAIL) !== 1) return null;
    if (page.indexOf(HEAD) > page.indexOf(TAIL)) return null;
    const assets = new Map<string, { type: string; bytes: Uint8Array }>();
    for (const [name, asset] of Object.entries(manifest.assets)) {
      if (!ASSET_NAME.test(name) || typeof asset.type !== "string") {
        return null;
      }
      const bytes = readFileSync(join(dir, "assets", name));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== asset.bytes || sha256 !== asset.sha256) return null;
      assets.set(name, { type: asset.type, bytes: new Uint8Array(bytes) });
    }
    return { page, assets };
  } catch {
    return null;
  }
}
