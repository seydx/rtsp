import { Demuxer } from 'node-av';

import { wrapAvPacket } from '../av-packet.js';
import { toTrackInfo } from './stream-info.js';

import type { Logger, MediaPacket, Source, StreamInfo, TrackInfo } from '../types.js';
import type { Readable } from 'node:stream';

/**
 * Configuration for a single input of a {@link MultiSource}.
 *
 * Describes one media input that a {@link MultiSource} should open as its own
 * demuxer. Each input contributes its streams to the combined, flattened track
 * space exposed to downstream sinks.
 */
export interface MultiSourceInput {
  /**
   * The media input to open.
   *
   * A libav-compatible input: a local file path, a network URL, an in-memory
   * Buffer, or a Node.js readable stream. Passed directly to the underlying
   * demuxer.
   */
  input: string | Buffer | Readable;

  /**
   * Explicit input format hint.
   *
   * Required for raw elementary streams that carry no container (for example
   * `h264` or `aac`), since the demuxer cannot probe a format for them. May be
   * omitted for inputs whose container is self-describing.
   */
  format?: string;

  /**
   * Additional demuxer options.
   *
   * Key-value pairs forwarded verbatim to the underlying libav demuxer, for
   * tuning transport, buffering, or format-specific behavior.
   */
  options?: Record<string, string | number>;
}

/**
 * A demuxer that has been opened together with its track-space offset.
 *
 * @internal
 */
interface OpenedInput {
  demuxer: Demuxer;

  /**
   * Global index of this demuxer's first stream.
   *
   * Added to each local stream index so every input occupies a distinct,
   * non-overlapping range in the flattened track space.
   */
  offset: number;
}

/**
 * Aggregates several independent inputs into one combined source.
 *
 * Opens each configured input as its own demuxer and presents their streams as
 * a single multi-track source, flattening the per-input stream indices into one
 * global index space. This is the common pattern for cameras that expose their
 * audio and video as separate raw elementary streams, which cannot be opened as
 * a single libav input. While running, every demuxer is pumped concurrently and
 * its packets are interleaved into a shared output stream.
 *
 * @example
 * ```typescript
 * import { MultiSource } from '@seydx/rtsp';
 *
 * const source = new MultiSource([
 *   { input: 'rtsp://camera/video' },
 *   { input: 'rtsp://camera/audio' },
 * ]);
 *
 * const info = await source.open();
 * const controller = new AbortController();
 * for await (const packet of source.packets(controller.signal)) {
 *   // route packet by its flattened streamIndex
 *   packet.free();
 * }
 * await source.close();
 * ```
 *
 * @see {@link Source} For the source contract this implements
 */
export class MultiSource implements Source {
  private opened: OpenedInput[] = [];

  /**
   * Create a source that combines multiple inputs.
   *
   * @param inputs - The inputs to open and aggregate, in track-space order
   *
   * @param opts - Optional settings
   *
   * @param opts.logger - Logger for non-fatal errors raised while reading inputs
   */
  constructor(
    private readonly inputs: MultiSourceInput[],
    private readonly opts: { logger?: Logger } = {},
  ) {}

  /**
   * Open every input and resolve the combined stream layout.
   *
   * Opens each configured input as a separate demuxer, assigns it a contiguous
   * offset in the flattened track space, and collects every stream into a single
   * track list that downstream sinks see as one multi-track source.
   *
   * @returns The combined stream info across all inputs
   *
   * @throws {Error} If any input fails to open
   *
   * @example
   * ```typescript
   * const info = await source.open();
   * console.log(`${info.tracks.length} tracks across all inputs`);
   * ```
   */
  async open(): Promise<StreamInfo> {
    const tracks: TrackInfo[] = [];
    let offset = 0;
    for (const input of this.inputs) {
      const demuxer = await Demuxer.open(input.input as never, {
        format: input.format as never,
        options: input.options as never,
      });
      this.opened.push({ demuxer, offset });
      for (const stream of demuxer.streams) tracks.push(toTrackInfo(stream, offset + stream.index));
      offset += demuxer.streams.length;
    }
    return { tracks };
  }

  /**
   * Yield interleaved packets from every input until aborted or exhausted.
   *
   * Pumps all opened demuxers concurrently into a shared queue and emits their
   * packets as they arrive, rewriting each packet's stream index into the
   * flattened global space. Iteration ends when every input has been drained or
   * the signal aborts; any unconsumed packets are released. If a demuxer fails
   * while reading and the signal has not aborted, the failure surfaces once the
   * iterator finishes.
   *
   * @param signal - Abort signal that stops iteration and frees pending packets
   *
   * @yields {MediaPacket} Interleaved packets in the flattened track space (each must be freed by the caller)
   *
   * @throws {Error} If an input fails while reading and the signal is not aborted
   *
   * @example
   * ```typescript
   * const controller = new AbortController();
   * for await (const packet of source.packets(controller.signal)) {
   *   handle(packet);
   *   packet.free();
   * }
   * ```
   */
  async *packets(signal: AbortSignal): AsyncIterable<MediaPacket> {
    const queue: MediaPacket[] = [];
    let waiters: (() => void)[] = [];
    let live = this.opened.length;
    let failure: Error | undefined;

    const notify = (): void => {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    };

    // Pump every demuxer concurrently into a shared queue.
    for (const { demuxer, offset } of this.opened) {
      void (async () => {
        try {
          for await (const packet of demuxer.packets()) {
            if (signal.aborted) {
              packet?.free();
              break;
            }
            if (!packet) continue;
            queue.push(wrapAvPacket(packet, offset + packet.streamIndex));
            notify();
          }
        } catch (error) {
          if (!signal.aborted) failure = error instanceof Error ? error : new Error('MultiSource read failed');
        } finally {
          live--;
          notify();
        }
      })();
    }

    try {
      while (!signal.aborted) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (live === 0) break;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    } finally {
      for (const packet of queue) packet.free();
      queue.length = 0;
    }

    if (failure && !signal.aborted) throw failure;
  }

  /**
   * Close every opened input and release its resources.
   *
   * Closes all demuxers in parallel; a failure to close any individual input is
   * logged via the configured logger rather than thrown, so teardown always
   * runs to completion.
   *
   * @returns A promise that resolves once all inputs have been closed
   *
   * @example
   * ```typescript
   * await source.close();
   * ```
   */
  async close(): Promise<void> {
    const opened = this.opened;
    this.opened = [];
    await Promise.all(opened.map((o) => o.demuxer.close().catch((error) => this.opts.logger?.error?.('[rtsp] MultiSource close failed:', error))));
  }
}
