// Where the sky map reads the time: the system clock, or a clock that replays a night faster.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

// A clock that starts at `start` and runs `rate` times faster than the clock beneath it.
export class ReplayClock implements Clock {
  private readonly startedAt: number;

  constructor(
    private readonly start: Date,
    private readonly rate = 60,
    private readonly beneath: Clock = systemClock,
  ) {
    this.startedAt = beneath.now().getTime();
  }

  now(): Date {
    const elapsed = this.beneath.now().getTime() - this.startedAt;
    return new Date(this.start.getTime() + elapsed * this.rate);
  }
}
