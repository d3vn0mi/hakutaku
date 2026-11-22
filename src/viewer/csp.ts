// The served page's Content-Security-Policy, and the headers every viewer response carries.

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
