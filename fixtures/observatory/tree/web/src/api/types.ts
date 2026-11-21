// What the ephemeris service sends, as the sky map reads it.

// A body's orbital elements, with the mean anomaly in degrees.
export interface ElementsRecord {
  name: string;
  a: number;
  e: number;
  period: number;
  m0: number;
  epoch: string; // ISO 8601
}

export interface ClientConfig {
  baseUrl: string;
  api_key: string;
  timeoutMs: number;
}
