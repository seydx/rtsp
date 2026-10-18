import { AV_LOG_ERROR, AV_LOG_WARNING } from 'node-av/constants';
import { Log } from 'node-av/lib';

import type { AVLogLevel } from 'node-av/constants';
import type { Logger } from './types.js';

/**
 * Options for {@link installNativeLogging}.
 */
export interface NativeLoggingOptions {
  /**
   * Most verbose FFmpeg level to forward.
   *
   * More verbose messages are dropped inside node-av and never reach
   * JavaScript or stderr. The default keeps warnings and errors.
   *
   * @default AV_LOG_WARNING
   */
  maxLevel?: AVLogLevel;

  /**
   * Substrings or patterns of messages to drop, on top of a built-in list of
   * known noise such as encoder statistics.
   */
  ignore?: (string | RegExp)[];
}

/**
 * Handle returned by {@link installNativeLogging}.
 */
export interface NativeLoggingHandle {
  /**
   * Remove the bridge and give FFmpeg logging back to its default handler.
   */
  dispose(): void;
}

// harmless noise: encoder teardown stats, swscale on the full-range yuvj formats MJPEG decodes to,
// the rtp jpeg packetizer and depacketizer on every frame of a camera that shares one quantization
// table (the depacketizer only rejects lengths other than 64, 128, 192 or 256), and the cuda probe of
// the device detection on every machine without an nvidia driver
const DEFAULT_IGNORE: (string | RegExp)[] = [
  'frames left in the queue',
  'Qavg',
  'deprecated pixel format used',
  'RFC 2435 suggests two quantization tables',
  /Invalid qtable length (64|192|256)\./,
  'Cannot load libcuda.so.1',
  'Could not dynamically load CUDA',
];

// av_log has one process-wide callback slot, so only one bridge can be active
let active: NativeLoggingHandle | undefined;

/**
 * Route FFmpeg's own log output into a {@link Logger}.
 *
 * node-av runs FFmpeg in process, and FFmpeg prints to stderr by default. This
 * installs FFmpeg's single process-wide log callback and maps errors to
 * `error`, warnings to `warn` and everything else to `debug`. Call it once per
 * process; a later call replaces the earlier bridge.
 *
 * @param logger - Destination of the messages
 *
 * @param options - Verbosity limit and extra patterns to drop
 *
 * @returns A handle that restores the default logging
 *
 * @example
 * ```typescript
 * import { installNativeLogging } from '@seydx/rtsp';
 *
 * const logging = installNativeLogging(console);
 * // on shutdown
 * logging.dispose();
 * ```
 */
export function installNativeLogging(logger: Logger, options: NativeLoggingOptions = {}): NativeLoggingHandle {
  active?.dispose();

  const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
  Log.setCallback(
    (level, message) => {
      if (ignore.some((pattern) => (typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message)))) return;
      const line = `[node-av] ${message}`;
      if (level <= AV_LOG_ERROR) logger.error?.(line);
      else if (level <= AV_LOG_WARNING) logger.warn?.(line);
      else logger.debug?.(line);
    },
    { maxLevel: options.maxLevel ?? AV_LOG_WARNING },
  );

  let disposed = false;
  const handle: NativeLoggingHandle = {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // a newer bridge owns the slot now, leave it alone
      if (active !== handle) return;
      Log.setCallback(null);
      active = undefined;
    },
  };
  active = handle;
  return handle;
}
