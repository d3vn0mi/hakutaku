// inlineViewerHtml: the whole viewer as one self-contained page, which requests nothing. Its
// styles go into one <style> block, with each font as a data: URI, and its script into one
// <script>; a CSP <meta>, first in the head, allows exactly those two by their SHA-256 hashes.
// The HTML parser ends a <script> at the first "</script" it meets, and a <style> at the first
// "</style", so a bundle whose text holds one, or a script that holds what keeps "</script>" from
// ending it, is refused: that page would not run as written.
import { createHash } from "node:crypto";
import { fillPage, readBundle, type ViewerBundle } from "./bundle-files.js";

// A font as the bundled styles name it: url(<name>.woff2), quoted or not.
const FONT_URL = /url\((["']?)([A-Za-z0-9][A-Za-z0-9._-]*\.woff2)\1\)/g;

// ASCII letters in either case, as the HTML parser reads tag names.
const SCRIPT_END = /<\/script/i;
const SCRIPT_START = /<script/gi;
const STYLE_END = /<\/style/i;

// The first thing in an inline script's text that would end its <script> element early, or keep
// its end tag from ending it, or null. "</script" ends the element wherever it stands. "<!--"
// puts the parser in a state where a "<script" that follows, before the next "-->", makes it
// skip the next "</script>" (the "-->" may begin at the comment's own "--": "<!-->" closes it).
export function scriptHazard(text: string): string | null {
  if (SCRIPT_END.test(text)) return '"</script"';
  for (const comment of text.matchAll(/<!--/g)) {
    const close = text.indexOf("-->", comment.index + 2);
    SCRIPT_START.lastIndex = comment.index + 4;
    const start = SCRIPT_START.exec(text);
    if (start !== null && (close < 0 || start.index < close)) {
      return '"<!--" followed by "<script" before "-->"';
    }
  }
  return null;
}

// The first thing in an inline style's text that would end its <style> element early, or null.
export function styleHazard(text: string): string | null {
  return STYLE_END.test(text) ? '"</style"' : null;
}

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
// in it can end the block. Returns the page and the CSP its <meta> holds. Throws an Error when the
// bundle's script or styles could not go inline as they are.
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
  for (const [name, hazard] of [
    ["app.js", scriptHazard(js)],
    ["app.css", styleHazard(css)],
  ]) {
    if (hazard !== null) {
      throw new Error(
        `the viewer cannot go inline in one page: ${name} holds ${hazard}`,
      );
    }
  }
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
