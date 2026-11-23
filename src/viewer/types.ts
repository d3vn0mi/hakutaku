// A request to the viewer's API and its response, as a host hands one over and serves the other.
// The host owns the socket and authenticates the caller; the API sees only these.
export interface ViewerRequest {
  method: string;
  path: string; // relative to the API base: "map", "outline", "source", "history" or "tool/<name>"
  query: Record<string, string>;
  body?: string;
  // the request's content-type header, as sent: a tool call must be application/json
  contentType?: string;
}

export interface ViewerResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}
