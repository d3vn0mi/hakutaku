import { type Clock, systemClock } from "../time/clock";

// A map whose entries expire ttlMs after they are set, by the clock it is given.
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock = systemClock,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expires <= this.clock.now().getTime()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.set(key, { value, expires: this.clock.now().getTime() + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }
}
