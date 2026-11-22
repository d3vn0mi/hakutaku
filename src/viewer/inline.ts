// inlineViewerHtml: the whole viewer as one self-contained page, which requests nothing. Its
// styles go into one <style> block, with each font as a data: URI, and its script into one
// <script>; a CSP <meta>, first in the head, allows exactly those two by their SHA-256 hashes.
import { createHash } from "node:crypto";
import { fillPage, readBundle, type ViewerBundle } from "./bundle-files.js";

// A font as the bundled styles name it: url(<name>.woff2), quoted or not.
const FONT_URL = /url\((["']?)([A-Za-z0-9][A-Za-z0-9._-]*\.woff2)\1\)/g;

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("base64");

function assetText(bundle: ViewerBundle, name: string): string {
  const asset = bundle.assets.get(name);
  if (asset === undefined) throw new Error(`the viewer bundle has no ${name}`);
  return Buffer.from(asset.bytes).toString("utf8");
}

// The styles, with each font they name replaced by its bytes as a data: URI.
function inlineFonts(bundle: ViewerBundle, css: string): string {
  return css.replace(FONT_URL, (_match, _quote, name: string) => {
    const font = bundle.assets.get(name);
    if (font === undefined) throw new Error(`the viewer bundle has no ${name}`);
    return `url(data:font/woff2;base64,${Buffer.from(font.bytes).toString("base64")})`;
  });
}

// dataJson, when given, is the page's data block: JSON in which no "<" is left, so that nothing
// in it can end the block. Returns the page and the CSP its <meta> holds.
export function inlineViewerHtml(dataJson: string | null): {
  html: string;
  csp: string;
} {
  const bundle = readBundle();
  if (bundle === null) throw new Error("viewer bundle missing");
  if (dataJson?.includes("<")) {
    throw new TypeError('the data block must hold no "<"');
  }
  const css = inlineFonts(bundle, assetText(bundle, "app.css"));
  const js = assetText(bundle, "app.js");
  const csp = `default-src 'none'; script-src 'sha256-${sha256(js)}'; style-src 'sha256-${sha256(css)}'; font-src data:; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><style>${css}</style>`;
  const data =
    dataJson === null
      ? ""
      : `<script type="application/json" id="hakutaku-data">${dataJson}</script>`;
  return {
    html: fillPage(bundle.page, head, `${data}<script>${js}</script>`),
    csp,
  };
}
