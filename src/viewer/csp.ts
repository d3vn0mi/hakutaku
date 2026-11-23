// The served page's Content-Security-Policy, the headers every viewer response carries, and the one
// that names the build an API answer comes from.

// The page loads its script, styles, fonts and data from its own server and nothing else, so only
// 'self' is allowed, with data: images besides; frame-ancestors 'none' keeps any other page from
// framing it.
export const VIEWER_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

// nosniff: a browser reads each answer only as its declared type. no-referrer: the page's address,
// which can carry the session, never leaves in a Referer header. no-store: no answer outlives its
// build in a cache. same-origin: no page of another site can load an answer as a resource.
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze(
  {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-origin",
  },
);

// The API answer's build, as MapData's build: on every answer made once the repo's store is open,
// a tool's and a refusal's included, whose bodies cannot carry it.
export const BUILD_HEADER = "x-hakutaku-build";
