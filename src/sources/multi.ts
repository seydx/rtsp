import { wrapAvPacket } from '../av-packet.js';
import { linkAbort } from '../util/abort.js';
import { DemuxInput } from './input.js';
import { toTrackInfo } from './stream-info.js';

import type { Logger, MediaPacket, Source, StreamInfo, TrackInfo } from '../types.js';
import type { AvInput } from './input.js';

/**
 * One input of a {@link MultiSource}.
 */
export interface MultiSourceInput {
  /**
   * The input to demux: URL, file path, buffer or readable byte stream.
   */
  input: AvInput;

  /**
   * Input format to use instead of probing.
   *
   * Required for raw elementary streams without a container, such as `h264`,
   * `hevc` or `aac`. Inputs with an explicit format also get a short probe
   * (`analyzeduration` 0.5 s, `probesize` 64 KiB) so they open quickly; set
   * those keys in {@link MultiSourceInput.options} to override it.
   */
  format?: string;

  /**
   * Extra libav demuxer options for this input, for example `{ framerate: 15 }`.
   */
  options?: Record<string, string | number>;

  /**
   * Stamp the packets of this input with their arrival time.
   *
   * All inputs share one clock origin, so wallclock inputs stay in sync with
   * each other. See {@link AvSourceOptions.wallclock}.
   *
   * @default false
   */
  wallclock?: boolean;
}

/**
 * Options for a {@link MultiSource}.
 */
export interface MultiSourceOptions {
  /**
   * Logger for demuxer close failures.
   */
  logger?: Logger;
}

const RAW_PROBE = { analyzeduration: 500_000, probesize: 65_536 };
// a file input reads far ahead of real time, this keeps it from buffering the whole file
const MAX_QUEUE = 256;

/**
 * Merges several inputs into one multi-track source.
 *
 * Each input is opened as its own demuxer and their streams are numbered one
 * after another, so sinks see a single source with all tracks. This fits
 * cameras that deliver audio and video as separate streams, for example raw
 * H.264 plus raw AAC. All inputs are read concurrently. If one of them fails,
 * the whole source fails, because a stream that silently lost its audio or
 * video is broken.
 *
 * @example
 * ```typescript
 * import { MultiSource, Relay } from '@seydx/rtsp';
 *
 * const source = new MultiSource([
 *   { input: videoStream, format: 'h264', options: { framerate: 15 } },
 *   { input: audioStream, format: 'aac' },
 * ]);
 * const relay = new Relay({ source });
 * ```
 *
 * @see {@link Source} For the source contract
 *
 * @see {@link AvSource} For a single input
 */
export class MultiSource implements Source {
  private readonly inputs: DemuxInput[];
  private offsets: number[] = [];
  private lifecycle?: AbortController;
  private pumps: Promise<void>[] = [];

  /**
   * Create a source that merges the given inputs. Nothing is opened until {@link MultiSource.open}.
   *
   * @param inputs - The inputs in track order
   *
   * @param options - Source options
   *
   * @throws {Error} If no input is given
   *
   * @example
   * ```typescript
   * const source = new MultiSource([{ input: 'rtsp://camera/video' }, { input: 'rtsp://camera/audio' }]);
   * ```
   */
  constructor(inputs: MultiSourceInput[], options: MultiSourceOptions = {}) {
    if (inputs.length === 0) throw new Error('MultiSource needs at least one input');
    this.inputs = inputs.map(
      (entry) =>
        new DemuxInput(entry.input, {
          format: entry.format,
          options: { ...(entry.format ? RAW_PROBE : undefined), ...entry.options },
          wallclock: entry.wallclock,
          logger: options.logger,
        }),
    );
  }

  /**
   * Open every input and resolve the merged stream layout.
   *
   * The inputs open concurrently, so their probe times overlap. If one fails,
   * the others are closed again.
   *
   * @returns The tracks of all inputs, numbered one after another
   *
   * @throws {Error} If an input cannot be opened or {@link MultiSource.close} aborted the open
   *
   * @example
   * ```typescript
   * const info = await source.open();
   * console.log(`${info.tracks.length} tracks`);
   * ```
   */
  async open(): Promise<StreamInfo> {
    const lifecycle = new AbortController();
    this.lifecycle = lifecycle;
    const epoch = performance.now();
    for (const input of this.inputs) input.resetTimeline(epoch);

    const results = await Promise.allSettled(this.inputs.map((input) => input.open(lifecycle.signal)));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed || lifecycle.signal.aborted) {
      await Promise.all(this.inputs.map((input) => input.dispose()));
      throw failed ? failed.reason : new Error('MultiSource closed while opening');
    }

    const tracks: TrackInfo[] = [];
    this.offsets = [];
    for (const input of this.inputs) {
      const offset = tracks.length;
      this.offsets.push(offset);
      for (const stream of input.tracks) tracks.push(toTrackInfo(stream, offset + stream.index));
    }
    return { tracks };
  }

  /**
   * Yield the packets of all inputs as they arrive, until every input ended or the signal aborts.
   *
   * @param signal - Stops the iteration and interrupts blocked reads
   *
   * @yields {MediaPacket} Packets with merged stream indexes, owned by the caller
   *
   * @throws {Error} If called before {@link MultiSource.open} or an input fails
   *
   * @example
   * ```typescript
   * for await (const packet of source.packets(controller.signal)) {
   *   handle(packet);
   *   packet.free();
   * }
   * ```
   */
  async *packets(signal: AbortSignal): AsyncIterable<MediaPacket> {
    const lifecycle = this.lifecycle;
    if (!lifecycle || this.inputs.some((input) => !input.current)) throw new Error('MultiSource.open() must be called before packets()');

    const unlink = linkAbort(signal, lifecycle);
    const queue: MediaPacket[] = [];
    let wake: (() => void) | undefined;
    let space: (() => void)[] = [];
    let live = this.inputs.length;
    let failure: unknown;
    let failed = false;

    const notify = (): void => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    const release = (): void => {
      const waiting = space;
      space = [];
      for (const resolve of waiting) resolve();
    };
    const onAbort = (): void => {
      notify();
      release();
    };
    lifecycle.signal.addEventListener('abort', onAbort);

    // close() waits for these, freeing a demuxer under a running read crashes the process
    this.pumps = this.inputs.map(async (input, i) => {
      const offset = this.offsets[i];
      try {
        for await (const packet of input.packets()) {
          while (queue.length >= MAX_QUEUE && !lifecycle.signal.aborted) await new Promise<void>((resolve) => space.push(resolve));
          if (lifecycle.signal.aborted) {
            packet.free();
            break;
          }
          queue.push(wrapAvPacket(packet, offset + packet.streamIndex));
          notify();
        }
      } catch (error) {
        if (!lifecycle.signal.aborted) {
          failure = error;
          failed = true;
          lifecycle.abort();
        }
      } finally {
        live--;
        notify();
      }
    });

    try {
      while (!lifecycle.signal.aborted) {
        const packet = queue.shift();
        if (packet) {
          if (space.length > 0) release();
          yield packet;
          continue;
        }
        if (live === 0) break;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      // a consumer that stopped early leaves the readers nobody to read for
      if (live > 0) lifecycle.abort();
      lifecycle.signal.removeEventListener('abort', onAbort);
      unlink();
      for (const packet of queue) packet.free();
      queue.length = 0;
    }
    if (failed) throw failure;
  }

  /**
   * Close every input and release its native resources.
   *
   * Aborts pending opens and reads first and waits for the read loops to unwind.
   * Safe to call at any time and more than once.
   *
   * @returns A promise that resolves once all inputs are closed
   *
   * @example
   * ```typescript
   * await source.close();
   * ```
   */
  async close(): Promise<void> {
    this.lifecycle?.abort();
    await Promise.allSettled(this.pumps);
    this.pumps = [];
    await Promise.all(this.inputs.map((input) => input.dispose()));
  }
}
