// Waits ms milliseconds.
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Calls an async function until it succeeds, up to `attempts` times, waiting twice as long after
// each failure: 250 ms, then 500 ms, then 1 s by default. The last failure is thrown.
export async function withRetry<T>(
  call: () => Promise<T>,
  attempts = 3,
  firstDelayMs = 250,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  let delay = firstDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await wait(delay);
      delay *= 2;
    }
  }
}
