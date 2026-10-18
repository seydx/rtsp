import { delay } from '../util/abort.js';
import { sameLayout } from './input.js';

import type { Logger } from '../types.js';
import type { AvReconnectOptions } from './av.js';
import type { DemuxInput, LayoutEntry } from './input.js';

/**
 * Reconnect policy with defaults applied.
 *
 * @internal
 */
export interface ReconnectPolicy {
  delay: number;
  maxDelay: number;
  maxRetries: number;
}

/**
 * An input that is reopened after it failed or ended.
 *
 * @internal
 */
export interface ReopenTarget {
  input: DemuxInput;
  /** Layout of the first open, the reopened input must match it. */
  layout: readonly LayoutEntry[];
  /** `undefined` for a single attempt without retries. */
  policy?: ReconnectPolicy;
  /** Names the input in errors and warnings, for example `AvSource input`. */
  name: string;
  logger?: Logger;
}

/**
 * Apply the defaults to a `reconnect` option.
 *
 * @param option - The raw option value
 *
 * @returns The policy, or `undefined` when reconnecting is off
 *
 * @internal
 */
export function resolveReconnect(option: boolean | AvReconnectOptions | undefined): ReconnectPolicy | undefined {
  if (!option) return undefined;
  const config = option === true ? {} : option;
  return {
    delay: config.delay ?? 1000,
    maxDelay: config.maxDelay ?? 30_000,
    maxRetries: config.maxRetries ?? Number.POSITIVE_INFINITY,
  };
}

/**
 * Exponential backoff delay for an attempt.
 *
 * @param policy - The reconnect policy
 *
 * @param attempt - 1-based count of consecutive failed attempts
 *
 * @returns The delay in milliseconds
 *
 * @internal
 */
export function backoff(policy: ReconnectPolicy, attempt: number): number {
  return Math.min(policy.delay * 2 ** (attempt - 1), policy.maxDelay);
}

/**
 * Close and reopen an input, retrying under its reconnect policy.
 *
 * @param target - The input, its first layout and its policy
 *
 * @param attempts - Consecutive failed attempts so far
 *
 * @param signal - Cancels the retries
 *
 * @returns The updated attempt count; the caller checks `signal` for an abort
 *
 * @throws {Error} If reopening fails without a policy, the retries are
 * exhausted or the reopened input has a different stream layout
 *
 * @internal
 */
export async function reopen(target: ReopenTarget, attempts: number, signal: AbortSignal): Promise<number> {
  const { input, policy, name } = target;
  await input.close();
  for (;;) {
    if (signal.aborted) return attempts;
    try {
      const streams = await input.open(signal);
      if (!sameLayout(target.layout, streams)) throw new Error(`${name} changed its stream layout after reopening`);
      return attempts;
    } catch (error) {
      if (signal.aborted) return attempts;
      // a layout mismatch leaves the input open, retrying would only find the same streams
      if (!policy || ++attempts > policy.maxRetries || input.current) throw error;
      const wait = backoff(policy, attempts);
      target.logger?.warn?.(`[rtsp] ${name} reopen failed, retrying in ${wait}ms:`, error);
      await delay(wait, signal);
    }
  }
}
