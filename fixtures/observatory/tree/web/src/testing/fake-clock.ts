import type { Clock } from "../time/clock";

// A clock for tests: it stands still until a test moves it.
export class FakeClock implements Clock {
  private ms: number;

  constructor(start = "2026-03-20T12:00:00Z") {
    this.ms = Date.parse(start);
  }

  now(): Date {
    return new Date(this.ms);
  }

  advance(ms: number): void {
    this.ms += ms;
  }

  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
}
