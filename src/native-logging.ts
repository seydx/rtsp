import { AV_LOG_ERROR, AV_LOG_WARNING, Log } from 'node-av';

import type { AVLogLevel } from 'node-av';
import type { Logger } from './types.js';

/**
 * Options for {@link installNativeLogging}.
 */
export interface NativeLoggingOptions {
  /**
   * Highest (most verbose) FFmpeg level to forward.
   *
   * Messages more verbose than this are dropped inside node-av before they ever
   * reach JavaScript, so they neither hit the logger nor leak to stderr. Defaults
   * to {@link AV_LOG_WARNING}, which keeps only warnings and errors and silently
   * discards the usual encoder/muxer chatter (e.g. `Qavg`, queue-flush notices).
   */
  maxLevel?: AVLogLevel;

  /**
   * Extra substrings/patterns whose messages should be dropped.
   *
   * Merged with a small built-in list of known-noise lines. Useful when a higher
   * `maxLevel` is chosen for debugging but a few chatty lines should still be
   * suppressed.
   */
  ignore?: (string | RegExp)[];
}

/**
 * Handle returned by {@link installNativeLogging}.
 */
export interface NativeLoggingHandle {
  /** Remove the bridge and hand FFmpeg logging back to its default handler. */
  dispose(): void;
}

// FFmpeg lines that are pure noise even at warning level / when verbosity is raised.
const DEFAULT_IGNORE: (string | RegExp)[] = ['frames left in the queue', 'Qavg'];

// FFmpeg's av_log callback is a single process-global slot, so only one bridge can
// be active at a time. Track it so re-installing replaces cleanly (idempotent).
let active: NativeLoggingHandle | null = null;

/**
 * Bridge FFmpeg's internal logging into a {@link Logger}.
 *
 * node-av embeds FFmpeg in-process, and FFmpeg's `av_log` callback is a single
 * process-global slot. This installs that one callback and routes each message to
 * the given logger by severity, instead of letting FFmpeg print to stderr. Call it
 * **once per process** (e.g. at a worker/plugin bootstrap) with the process's
 * logger — not per stream/relay, since a later call replaces the previous bridge.
 *
 * Because every forked process has its own FFmpeg instance, separate processes are
 * already isolated; this simply captures the FFmpeg output of the current process.
 *
 * @param logger - Destination logger; messages are mapped error/warn → `error`/`warn`, everything else → `debug`.
 *
 * @param options - Verbosity ceiling and extra ignore patterns.
 *
 * @returns A handle whose `dispose()` restores FFmpeg's default logging.
 *
 * @example
 * ```typescript
 * import { installNativeLogging } from '@seydx/rtsp';
 *
 * const logging = installNativeLogging(myLogger);
 * // ...on shutdown
 * logging.dispose();
 * ```
 */
export function installNativeLogging(logger: Logger, options: NativeLoggingOptions = {}): NativeLoggingHandle {
  // Single global slot: drop any previous bridge before installing a new one.
  active?.dispose();

  const maxLevel = options.maxLevel ?? AV_LOG_WARNING;
  const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
  const ignored = (message: string): boolean => ignore.some((p) => (typeof p === 'string' ? message.includes(p) : p.test(message)));

  Log.setCallback(
    (level, message) => {
      if (ignored(message)) return;
      const line = `[node-av] ${message}`;
      if (level <= AV_LOG_ERROR) logger.error?.(line);
      else if (level <= AV_LOG_WARNING) logger.warn?.(line);
      else logger.debug?.(line);
    },
    { maxLevel },
  );

  let disposed = false;
  const handle: NativeLoggingHandle = {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Only relinquish the global slot if we still own it.
      if (active === handle) {
        Log.setCallback(null);
        active = null;
      }
    },
  };
  active = handle;
  return handle;
}
