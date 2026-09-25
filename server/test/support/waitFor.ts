export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Named in the timeout error, so a failure says what never happened. */
  description?: string;
}

/**
 * Polls `condition` until it holds. The suite's only way to wait: every wait is for a named, observable
 * condition (a port answering, a row changing state), never a fixed delay that is hoped to be long enough.
 */
export const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  { timeoutMs = 5_000, intervalMs = 20, description = 'condition' }: WaitForOptions = {}
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await condition()) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};
