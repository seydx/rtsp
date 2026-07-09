/**
 * A promise paired with its resolver and rejecter for out-of-band completion.
 *
 * @internal
 */
export interface Deferred<T> {
  /** The pending promise, settled later via {@link Deferred.resolve} or {@link Deferred.reject}. */
  promise: Promise<T>;

  /** Fulfill the promise with a value. Later calls (or after reject) are no-ops. */
  resolve: (value: T) => void;

  /** Reject the promise with an error. Later calls (or after resolve) are no-ops. */
  reject: (error: unknown) => void;
}

/**
 * Create a deferred whose promise is settled later by an external caller.
 *
 * The returned promise carries a pre-attached no-op rejection handler so a
 * deferred that is rejected while nobody happens to be awaiting it (for example
 * an SDP promise torn down between two viewers) never surfaces as an unhandled
 * rejection. Callers that do await it still observe the rejection normally.
 *
 * @returns A deferred bundling the pending promise with its settle functions
 *
 * @internal
 */
export function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  // Detached guard branch: swallows the rejection when no consumer is awaiting.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}
