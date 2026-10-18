/**
 * Wait for the given duration, resolving early when the signal aborts.
 *
 * @param ms - Delay in milliseconds
 *
 * @param signal - Signal that ends the wait immediately when it fires
 *
 * @returns A promise that settles after `ms` or on abort, whichever comes first
 *
 * @internal
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });

    // eslint-disable-next-line jsdoc/require-jsdoc
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/**
 * Forward an abort from one signal to a controller.
 *
 * @param signal - The signal to follow
 *
 * @param controller - The controller to abort when `signal` aborts
 *
 * @returns A function that removes the link again
 *
 * @internal
 */
export function linkAbort(signal: AbortSignal, controller: AbortController): () => void {
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}
