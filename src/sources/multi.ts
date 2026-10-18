import { Readable } from 'node:stream';

import { wrapAvPacket } from '../av-packet.js';
import { delay, linkAbort } from '../util/abort.js';
import { captureLayout, DemuxInput } from './input.js';
import { backoff, reopen, resolveReconnect } from './reconnect.js';
import { toTrackInfo } from './stream-info.js';

import type { Logger, MediaPacket, Source, StreamInfo, TrackInfo } from '../types.js';
import type { AvReconnectOptions } from './av.js';
import type { AvInput } from './input.js';
import type { ReconnectPolicy, ReopenTarget } from './reconnect.js';

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
   * Socket timeout in milliseconds for opening and reading this input.
   *
   * libav gives up when no data arrives within this window, which fails the
   * input or reconnects it with {@link MultiSourceInput.reconnect}. Without it
   * libav waits forever, and a stalled input that keeps its connection open
   * goes unnoticed while the other inputs keep delivering.
   */
  timeout?: number;

  /**
   * Reopen this input when it fails or ends, with exponential backoff.
   *
   * Only this input reconnects, the others keep delivering meanwhile, so a
   * separate audio stream that drops leaves the video running. Its timeline
   * skips the time it was gone and stays aligned with the other inputs. The
   * reopened input must have the same stream layout, and every input still has
   * to open with the source. When the retries are exhausted, the whole source
   * fails. Not available for `Readable` inputs.
   *
   * @default false
   */
  reconnect?: boolean | AvReconnectOptions;

  /**
   * Leave this input out when it cannot be opened, instead of failing the source.
   *
   * The source then starts with the tracks of the other inputs and logs a
   * warning, and its next open tries this input again. The tracks cannot join
   * a stream that already started, because sinks and viewers set up their
   * tracks once. Fits a separate audio stream that should not keep the video
   * from starting. Once open, the input fails or reconnects like any other.
   * At least one input has to open.
   *
   * @default false
   */
  optional?: boolean;

  /**
   * Extra libav demuxer options for this input, for example `{ framerate: 15 }`.
   *
   * {@link MultiSourceInput.timeout} wins over a key of the same name.
   */
  options?: Record<string, string | number>;

  /**
   * Stamp the packets of this input with their arrival time.
   *
   * All inputs share one clock origin, so wallclock inputs stay in sync with
   * each other, and audio that a burst keeps ahead is cut back. See
   * {@link AvSourceOptions.wallclock}.
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
   * Logger for reconnects and demuxer close failures.
   */
  logger?: Logger;
}

const RAW_PROBE = { analyzeduration: 500_000, probesize: 65_536 };
const MS_TO_US = 1000;
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
 * video is broken, unless that input reconnects on its own.
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
 * @example
 * ```typescript
 * import { MultiSource } from '@seydx/rtsp';
 *
 * // MJPEG video with the audio of a separate URL, which may be missing at the start and reconnects on its own when it drops
 * const source = new MultiSource([
 *   { input: 'http://camera.local/video.mjpg', format: 'mpjpeg', wallclock: true },
 *   { input: 'http://camera.local/audio.wav', wallclock: true, timeout: 5000, reconnect: true, optional: true },
 * ]);
 * ```
 *
 * @see {@link Source} For the source contract
 *
 * @see {@link AvSource} For a single input
 */
export class MultiSource implements Source {
  private readonly inputs: DemuxInput[];
  private readonly policies: (ReconnectPolicy | undefined)[];
  private readonly optional: boolean[];
  private readonly logger?: Logger;
  private opened: number[] = [];
  private targets: ReopenTarget[] = [];
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
   * @throws {Error} If no input is given or a `Readable` input should reconnect
   *
   * @example
   * ```typescript
   * const source = new MultiSource([{ input: 'rtsp://camera/video' }, { input: 'rtsp://camera/audio' }]);
   * ```
   */
  constructor(inputs: MultiSourceInput[], options: MultiSourceOptions = {}) {
    if (inputs.length === 0) throw new Error('MultiSource needs at least one input');
    if (inputs.some((entry) => entry.input instanceof Readable && entry.reconnect)) {
      throw new Error('MultiSource cannot reconnect a Readable input, it can only be read once');
    }
    this.inputs = inputs.map(
      (entry) =>
        new DemuxInput(entry.input, {
          format: entry.format,
          options: {
            ...(entry.format ? RAW_PROBE : undefined),
            ...entry.options,
            ...(entry.timeout !== undefined ? { timeout: Math.round(entry.timeout * MS_TO_US) } : undefined),
          },
          wallclock: entry.wallclock,
          catchUp: Boolean(entry.reconnect),
          logger: options.logger,
        }),
    );
    this.policies = inputs.map((entry) => resolveReconnect(entry.reconnect));
    this.optional = inputs.map((entry) => entry.optional === true);
    this.logger = options.logger;
  }

  /**
   * Open every input and resolve the merged stream layout.
   *
   * The inputs open concurrently, so their probe times overlap. If one fails,
   * the others are closed again, unless it is
   * {@link MultiSourceInput.optional | optional} and left out.
   *
   * @returns The tracks of all opened inputs, numbered one after another
   *
   * @throws {Error} If a required input or every input cannot be opened, or
   * {@link MultiSource.close} aborted the open
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
    const opened = this.inputs.flatMap((_input, i) => (results[i].status === 'fulfilled' ? [i] : []));
    const failed = results.find((result, i) => result.status === 'rejected' && (!this.optional[i] || opened.length === 0));
    if (failed || lifecycle.signal.aborted) {
      await Promise.all(this.inputs.map((input) => input.dispose()));
      throw failed?.status === 'rejected' ? failed.reason : new Error('MultiSource closed while opening');
    }
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') this.logger?.warn?.(`[rtsp] MultiSource input ${i} left out, it failed to open:`, result.reason);
    }
    this.opened = opened;

    const tracks: TrackInfo[] = [];
    this.offsets = [];
    this.targets = [];
    for (const [i, input] of this.inputs.entries()) {
      const offset = tracks.length;
      this.offsets.push(offset);
      for (const stream of input.tracks) tracks.push(toTrackInfo(stream, offset + stream.index));
      this.targets.push({ input, layout: captureLayout(input.tracks), policy: this.policies[i], name: `MultiSource input ${i}`, logger: this.logger });
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
   * @throws {Error} If called before {@link MultiSource.open}, an input fails
   * without reconnect, its retries are exhausted or a reconnected input changed
   * its stream layout
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
    if (!lifecycle || this.opened.length === 0 || this.opened.some((i) => !this.inputs[i].current)) throw new Error('MultiSource.open() must be called before packets()');

    const unlink = linkAbort(signal, lifecycle);
    const queue: MediaPacket[] = [];
    let wake: (() => void) | undefined;
    let space: (() => void)[] = [];
    let live = this.opened.length;
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

    const deliver = async (packet: MediaPacket): Promise<void> => {
      while (queue.length >= MAX_QUEUE && !lifecycle.signal.aborted) await new Promise<void>((resolve) => space.push(resolve));
      if (lifecycle.signal.aborted) {
        packet.free();
        return;
      }
      queue.push(packet);
      notify();
    };

    // close() waits for these, freeing a demuxer under a running read crashes the process
    this.pumps = this.opened.map(async (i) => {
      try {
        await this.readInput(i, lifecycle.signal, deliver);
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

  /**
   * Read one input until it ends, reopening it under its reconnect policy.
   *
   * @param index - Position of the input
   *
   * @param signal - Stops reading and cuts a backoff wait short
   *
   * @param deliver - Takes ownership of each packet, waits while the queue is full
   *
   * @returns A promise that resolves when the input ended for good or the signal aborted
   *
   * @throws {Error} If a read fails without reconnect, the retries are
   * exhausted or the reopened input has a different stream layout
   *
   * @internal
   */
  private async readInput(index: number, signal: AbortSignal, deliver: (packet: MediaPacket) => Promise<void>): Promise<void> {
    const input = this.inputs[index];
    const target = this.targets[index];
    const offset = this.offsets[index];
    let attempts = 0;

    for (;;) {
      let failure: unknown;
      let failed = false;
      let produced = false;
      try {
        for await (const packet of input.packets()) {
          produced = true;
          await deliver(wrapAvPacket(packet, offset + packet.streamIndex));
          if (signal.aborted) return;
        }
      } catch (error) {
        failure = error;
        failed = true;
      }
      if (signal.aborted) return;
      if (produced) attempts = 0;

      const policy = target.policy;
      if (!policy || ++attempts > policy.maxRetries) {
        if (failed) throw failure;
        return;
      }
      const wait = backoff(policy, attempts);
      if (failed) this.logger?.warn?.(`[rtsp] ${target.name} failed, reconnecting in ${wait}ms:`, failure);
      else this.logger?.warn?.(`[rtsp] ${target.name} ended, reconnecting in ${wait}ms`);
      await delay(wait, signal);
      if (signal.aborted) return;
      attempts = await reopen(target, attempts, signal);
      if (signal.aborted) return;
    }
  }
}
