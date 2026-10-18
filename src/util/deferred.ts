/**
 * A promise with its resolve and reject functions.
 *
 * @internal
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * Create a promise that is settled from outside.
 *
 * A rejection nobody awaits is swallowed, for example an SDP promise torn down
 * between two viewers. Callers that await it still see the rejection.
 *
 * @returns The deferred
 *
 * @internal
 */
export function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}
