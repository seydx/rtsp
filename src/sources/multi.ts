import { AV_NOPTS_VALUE, Demuxer } from 'node-av';

import { wrapAvPacket } from '../av-packet.js';
import { toTrackInfo } from './stream-info.js';

import type { Packet, Stream } from 'node-av';
import type { Readable } from 'node:stream';
import type { Logger, MediaPacket, Source, StreamInfo, TrackInfo } from '../types.js';

const RAW_ES_PROBE = { analyzeduration: '500000', probesize: '65536' } as const;

/**
 * Derive a per-frame duration (in the stream's own time base) from its frame
 * rate, used as a fallback when the demuxer leaves packet durations unset.
 *
 * Raw elementary video streams carry no container timing, so the demuxer cannot
 * always populate a packet duration. When it can't, a constant-frame-rate
 * estimate from `r_frame_rate` (falling back to `avg_frame_rate`) keeps the
 * synthesized timeline monotonic.
 *
 * @param stream - The demuxer stream to derive a frame duration for.
 *
 * @returns The per-frame duration in time-base units, or `0n` when no usable
 * frame rate is known (in which case timestamps are left untouched).
 *
 * @internal
 */
function fallbackFrameDuration(stream: Stream): bigint {
  const tb = stream.timeBase;
  const fr = stream.rFrameRate.num > 0 ? stream.rFrameRate : stream.avgFrameRate;
  if (tb.num <= 0 || tb.den <= 0 || fr.num <= 0 || fr.den <= 0) return 0n;
  // duration[tb] = (1 / fps) / timeBase = (tb.den * fr.den) / (tb.num * fr.num)
  return BigInt(Math.round((tb.den * fr.den) / (tb.num * fr.num)));
}

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

  /** Aborts the demuxer reads on teardown so close() never frees a demuxer mid-read. */
  private abort?: AbortController;

  /** Background per-demuxer pump loops, awaited by close() before the demuxers are freed. */
  private pumps: Promise<void>[] = [];

  /** Fallback per-frame duration (time-base units) per global stream index, for timestamp synthesis. */
  private readonly frameDuration = new Map<number, bigint>();

  /** Running synthesized PTS per global stream index, advanced as timeless packets are stamped. */
  private nextPts = new Map<number, bigint>();

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
    this.abort = new AbortController();
    const { signal } = this.abort;

    // Open every input concurrently so probe latency overlaps instead of summing.
    // For multiple realtime raw streams (e.g. separate video + audio), sequential
    // opening would add each input's find_stream_info wall-clock wait in series.
    const results = await Promise.allSettled(
      this.inputs.map((input) =>
        Demuxer.open(input.input as never, {
          format: input.format as never,
          // Explicit-format inputs get fast-probe defaults, overridable per input.
          options: { ...(input.format ? RAW_ES_PROBE : undefined), ...input.options } as never,
          // Make reads abortable so teardown can interrupt a blocked read instead
          // of closing the demuxer underneath it.
          signal,
        }),
      ),
    );

    const demuxers = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) {
      // Don't leak the inputs that did open before one failed.
      await Promise.all(demuxers.map((d) => d.close().catch(() => undefined)));
      throw failed.reason;
    }

    const tracks: TrackInfo[] = [];
    let offset = 0;
    for (const demuxer of demuxers) {
      this.opened.push({ demuxer, offset });
      for (const stream of demuxer.streams) {
        const index = offset + stream.index;
        tracks.push(toTrackInfo(stream, index));
        this.frameDuration.set(index, fallbackFrameDuration(stream));
      }
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
   * the signal aborts; any unconsumed packets are released. If any demuxer fails
   * while reading and the signal has not aborted, the remaining inputs are
   * aborted and the failure is thrown immediately — a combined source missing
   * one of its inputs is treated as broken as a whole.
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

    // Fresh synthesized clock for this pull (a source may be re-pulled after open).
    this.nextPts = new Map<number, bigint>();

    const notify = (): void => {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    };

    // Tie the relay's pull signal to our internal abort so aborting either one
    // stops the demuxer reads (and lets close() unblock a stalled read).
    const onAbort = (): void => this.abort?.abort();
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    // Pump every demuxer concurrently into a shared queue. The promises are kept
    // so close() can wait for every loop to exit its read before freeing demuxers.
    this.pumps = this.opened.map(({ demuxer, offset }) =>
      (async () => {
        try {
          for await (const packet of demuxer.packets()) {
            if (signal.aborted) {
              packet?.free();
              break;
            }
            if (!packet) continue;
            const index = offset + packet.streamIndex;
            this.synthesizeTimestamp(packet, index);
            queue.push(wrapAvPacket(packet, index));
            notify();
          }
        } catch (error) {
          // An AbortError from the teardown signal is expected; only real read
          // failures should surface to the consumer.
          if (!signal.aborted && !this.abort?.signal.aborted) {
            failure = error instanceof Error ? error : new Error('MultiSource read failed');
            // Fail fast: a combined source that silently lost one of its inputs
            // (e.g. the audio leg of a split A/V camera) is broken as a whole.
            // Abort the sibling pumps so the consumer sees the failure now
            // instead of after the surviving inputs happen to end.
            this.abort?.abort();
          }
        } finally {
          live--;
          notify();
        }
      })(),
    );

    try {
      while (!signal.aborted && !failure) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (live === 0) break;
        // Wake on the next queued packet or on abort — and drop the abort
        // listener either way, otherwise every wait leaks one listener onto the
        // long-lived relay signal.
        await new Promise<void>((resolve) => {
          const onAbort = (): void => resolve();
          waiters.push(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          });
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
    } finally {
      for (const packet of queue) packet.free();
      queue.length = 0;
    }

    if (failure && !signal.aborted) throw failure;
  }

  /**
   * Stamp a monotonic PTS/DTS onto a packet that carries no timestamp.
   *
   * Raw elementary video streams (e.g. Annex-B H.264 with no container) arrive
   * without timing — every packet has `AV_NOPTS_VALUE`, which
   * makes the RTP muxer "make some up" and leaves downstream players with a
   * frozen clock. This reconstructs a constant-frame-rate timeline from the
   * per-frame duration the demuxer already provides (falling back to the stream's
   * frame rate), advancing a per-stream accumulator. Packets that already carry a
   * PTS (such as parser-timed AAC) are left untouched.
   *
   * @param packet - The native packet to stamp in place.
   *
   * @param index - The packet's global stream index.
   *
   * @internal
   */
  private synthesizeTimestamp(packet: Packet, index: number): void {
    if (packet.pts !== AV_NOPTS_VALUE) return;
    const duration = packet.duration > 0n ? packet.duration : (this.frameDuration.get(index) ?? 0n);
    if (duration <= 0n) return; // no basis for a clock — leave it untimed rather than collapse to 0
    const pts = this.nextPts.get(index) ?? 0n;
    packet.pts = pts;
    packet.dts = pts;
    this.nextPts.set(index, pts + duration);
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
    // Stop the demuxer reads and wait for every pump loop to finish before
    // freeing the demuxers — closing a demuxer while a read is in flight is a
    // use-after-free that crashes the process.
    this.abort?.abort();
    await Promise.allSettled(this.pumps);
    this.pumps = [];

    this.frameDuration.clear();
    this.nextPts.clear();

    const opened = this.opened;
    this.opened = [];
    await Promise.all(opened.map((o) => o.demuxer.close().catch((error) => this.opts.logger?.error?.('[rtsp] MultiSource close failed:', error))));
  }
}
