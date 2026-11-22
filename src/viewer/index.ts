// The viewer as the library gives it: the JSON API and the static page a host mounts, the served
// page's CSP and the headers every viewer response carries. Nothing here opens a socket or starts
// a process: a host that mounts the viewer serves it with its own server.
export { viewerApi } from "./api.js";
export { SECURITY_HEADERS, VIEWER_CSP } from "./csp.js";
export { viewerStatic } from "./static.js";
export type { ViewerRequest, ViewerResponse } from "./types.js";
