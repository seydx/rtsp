import { avGetCodecName } from 'node-av/lib';
import { Readable } from 'node:stream';

import { wrapAvPacket } from '../av-packet.js';
import { delay, linkAbort } from '../util/abort.js';
import { captureLayout, DemuxInput } from './input.js';
import { backoff, reopen, resolveReconnect } from './reconnect.js';
import { toTrackInfo } from './stream-info.js';

import type { Packet } from 'node-av/lib';
import type { BackchannelInfo, BackchannelSource, Logger, MediaPacket, Source, StreamInfo } from '../types.js';
import type { AvInput, LayoutEntry } from './input.js';
import type { ReconnectPolicy } from './reconnect.js';

/**
 * Options for an {@link AvSource}.
 *
 * Every field is optional. The defaults suit live inputs such as RTSP cameras;
 * pacing and looping turn a finite input into a continuous live stream.
 */
export interface AvSourceOptions {
  /**
   * Input format to use instead of probing, for example `h264`, `mjpeg` or `mpegts`.
   *
   * Needed for raw inputs without a container that libav cannot detect.
   */
  format?: string;

  /**
   * RTSP lower transport.
   *
   * `tcp` interleaves media on the RTSP connection and passes firewalls, `udp`
   * has lower latency but may lose packets. Ignored for other inputs.
   */
  transport?: 'tcp' | 'udp';

  /**
   * Socket timeout in milliseconds for opening and reading network inputs.
   *
   * libav gives up when no data arrives within this window, which ends or
   * reconnects the source instead of hanging. Without it libav waits forever.
   */
  timeout?: number;

  /**
   * Deliver packets at a multiple of real time, like ffmpeg's `-re`.
   *
   * `1` paces packets by their own timestamps, which is needed to serve a file
   * as a live stream. Leave it unset for live inputs, they already arrive at
   * their natural rate.
   */
  readrate?: number;

  /**
   * Reopen the input when it ends and keep streaming.
   *
   * Timestamps continue across the restart, so consumers never see time jump
   * back. A pass that produced packets and then failed to read is restarted
   * too. Not available for `Readable` inputs.
   *
   * @default false
   */
  loop?: boolean;

  /**
   * Reopen the input after a read failure, with exponential backoff.
   *
   * Without it, a failure (camera reboot, network drop) ends the packet stream
   * with an error. With it, the source reopens the input and resumes; without
   * {@link AvSourceOptions.loop} an unexpected end counts as a failure too.
   * The reopened input must have the same stream layout, otherwise the stream
   * fails so the relay can restart cleanly. Not available for `Readable`
   * inputs.
   *
   * @default false
   */
  reconnect?: boolean | AvReconnectOptions;

  /**
   * Stamp packets with their arrival time instead of the input timestamps.
   *
   * For live inputs without usable timestamps, such as MJPEG over HTTP or raw
   * elementary streams. Audio keeps a gapless sample timeline while it stays
   * close to the arrival time, so bursty delivery does not cause jitter. Audio
   * that a burst of buffered data keeps more than 200 ms ahead for a whole
   * second, as after an open that read ahead or after a stall, is cut back
   * once by dropping that much, so it lines up with the video again.
   *
   * @default false
   */
  wallclock?: boolean;

  /**
   * Request the ONVIF backchannel (talkback) of an RTSP camera.
   *
   * Appends `backchannel=1` to the URL and exposes the camera's send-only
   * stream through {@link AvSource.backchannel}. A camera without a
   * backchannel logs a warning and streams normally.
   *
   * @default false
   */
  backchannel?: boolean;

  /**
   * Extra libav demuxer options, for example `{ probesize: 32768 }`.
   *
   * {@link AvSourceOptions.transport} and {@link AvSourceOptions.timeout} win
   * over keys of the same name.
   */
  options?: Record<string, string | number>;

  /**
   * Logger for open, reconnect and backchannel diagnostics.
   */
  logger?: Logger;
}

/**
 * Backoff for {@link AvSourceOptions.reconnect}.
 */
export interface AvReconnectOptions {
  /**
   * Delay before the first reopen attempt in milliseconds.
   *
   * Doubles with every consecutive failed attempt up to
   * {@link AvReconnectOptions.maxDelay}.
   *
   * @default 1000
   */
  delay?: number;

  /**
   * Upper bound of the backoff delay in milliseconds.
   *
   * @default 30000
   */
  maxDelay?: number;

  /**
   * Consecutive failed attempts before the source gives up and fails.
   *
   * The count resets once a reopened input delivers packets again.
   *
   * @default Infinity
   */
  maxRetries?: number;
}

const MS_TO_US = 1000;

/**
 * Source backed by the node-av demuxer.
 *
 * One class covers RTSP, HTTP(S), TCP, local files, in-memory buffers and
 * readable byte streams, because libav does the input handling. For RTSP
 * cameras it can expose the ONVIF backchannel so viewer audio reaches the
 * camera, and it can pace and loop finite inputs so they behave like a live
 * stream.
 *
 * @example
 * ```typescript
 * import { AvSource, Relay } from '@seydx/rtsp';
 *
 * const source = new AvSource('rtsp://user:pass@camera.local/stream', {
 *   transport: 'tcp',
 *   timeout: 5000,
 *   reconnect: true,
 *   backchannel: true,
 * });
 * const relay = new Relay({ source });
 * ```
 *
 * @example
 * ```typescript
 * import { AvSource } from '@seydx/rtsp';
 *
 * // serve a file as an endless live stream
 * const source = new AvSource('/media/clip.mp4', { readrate: 1, loop: true });
 * ```
 *
 * @example
 * ```typescript
 * import { AvSource } from '@seydx/rtsp';
 *
 * // MJPEG camera, stamped with the arrival time of each frame
 * const source = new AvSource('http://camera.local/video.mjpg', { wallclock: true });
 * ```
 *
 * @see {@link Source} For the source contract
 *
 * @see {@link BackchannelSource} For the talkback contract
 *
 * @see {@link MultiSource} For merging several inputs
 *
 * @see {@link Relay} For fanning the source out
 */
export class AvSource implements Source, BackchannelSource {
  private readonly input: DemuxInput;
  private readonly logger?: Logger;
  private readonly reconnect?: ReconnectPolicy;
  private lifecycle?: AbortController;
  private reading?: Promise<void>;
  private layout: LayoutEntry[] = [];
  private talkback?: BackchannelInfo;

  /**
   * Create a source for one input. Nothing is opened until {@link AvSource.open}.
   *
   * @param input - URL, path, buffer or readable stream to demux
   *
   * @param options - Transport, timeout, pacing, looping, reconnect and backchannel options
   *
   * @throws {Error} If a `Readable` input is combined with `loop` or `reconnect`
   *
   * @example
   * ```typescript
   * const source = new AvSource('rtsp://camera.local/stream', { transport: 'tcp' });
   * ```
   */
  constructor(
    input: AvInput,
    private readonly options: AvSourceOptions = {},
  ) {
    if (input instanceof Readable && (options.loop || options.reconnect)) {
      throw new Error('AvSource cannot loop or reconnect a Readable input, it can only be read once');
    }
    this.input = new DemuxInput(options.backchannel && typeof input === 'string' ? withBackchannel(input) : input, {
      format: options.format,
      options: demuxOptions(options),
      wallclock: options.wallclock,
      logger: options.logger,
    });
    this.logger = options.logger;
    this.reconnect = resolveReconnect(options.reconnect);
  }

  /**
   * Talkback format of the camera, once the input is open.
   *
   * `undefined` while closed, when {@link AvSourceOptions.backchannel} is off
   * or when the camera advertises no backchannel.
   *
   * @example
   * ```typescript
   * await source.open();
   * console.log(source.backchannel?.codec);
   * ```
   */
  get backchannel(): BackchannelInfo | undefined {
    return this.talkback;
  }

  /**
   * Open the input and resolve its stream layout.
   *
   * @returns The tracks and, if requested and available, the backchannel format
   *
   * @throws {Error} If the input cannot be opened or {@link AvSource.close} aborted the open
   *
   * @example
   * ```typescript
   * const info = await source.open();
   * console.log(info.tracks.map((track) => track.codec));
   * ```
   */
  async open(): Promise<StreamInfo> {
    const lifecycle = new AbortController();
    this.lifecycle = lifecycle;
    this.input.resetTimeline();
    this.logger?.debug?.('[rtsp] AvSource opening', redact(this.input.input));

    const streams = await this.input.open(lifecycle.signal);
    this.layout = captureLayout(streams);
    this.talkback = this.options.backchannel ? this.readBackchannel() : undefined;
    return { tracks: this.input.tracks.map((stream) => toTrackInfo(stream)), backchannel: this.talkback };
  }

  /**
   * Send one RTP packet of talkback audio to the camera.
   *
   * The packet must already use the codec and payload type of
   * {@link AvSource.backchannel}. Does nothing while closed or without a
   * backchannel; send failures are logged, not thrown.
   *
   * @param rtp - One RTP packet in the backchannel codec
   *
   * @example
   * ```typescript
   * if (source.backchannel) source.sendBackchannel(rtpPacket);
   * ```
   */
  sendBackchannel(rtp: Buffer): void {
    const demuxer = this.input.current;
    const talkback = this.talkback;
    if (!demuxer || !talkback) return;
    // node-av writes it on the reader thread between two reads, which keeps the order
    demuxer
      .getFormatContext()
      .sendRTSPPacket(talkback.streamIndex, rtp)
      .catch((error: unknown) => this.logger?.debug?.('[rtsp] backchannel send failed:', error));
  }

  /**
   * Yield packets until the signal aborts, the input ends or it fails for good.
   *
   * With {@link AvSourceOptions.loop} the input restarts when it ends; with
   * {@link AvSourceOptions.reconnect} failures reopen it under backoff.
   *
   * @param signal - Stops the iteration and interrupts a blocked read
   *
   * @yields {MediaPacket} Demuxed packets, owned by the caller
   *
   * @throws {Error} If called before {@link AvSource.open}, if a read fails
   * without reconnect, if the retries are exhausted or if a reconnected input
   * changed its stream layout
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
    const lifecycle = this.lifecycle;
    if (!lifecycle || !this.input.current) throw new Error('AvSource.open() must be called before packets()');

    const unlink = linkAbort(signal, lifecycle);
    let finish!: () => void;
    // close() waits for this, freeing the demuxer under a running read crashes the process
    this.reading = new Promise<void>((resolve) => (finish = resolve));
    let attempts = 0;

    try {
      for (;;) {
        let failure: unknown;
        let failed = false;
        let produced = false;
        try {
          for await (const packet of this.readPass(lifecycle.signal)) {
            produced = true;
            yield wrapAvPacket(packet);
          }
        } catch (error) {
          failure = error;
          failed = true;
        }
        if (lifecycle.signal.aborted) return;
        if (produced) attempts = 0;
        // some demuxers (mpjpeg) report the end of a file as invalid data, a loop restarts after it like after a clean end
        if (failed && produced && this.options.loop) {
          this.logger?.debug?.('[rtsp] AvSource pass ended with a read error, looping:', failure);
          failed = false;
        }

        // a pass without packets does not loop, it would spin on an empty input
        if (failed || !this.options.loop || !produced) {
          if (!this.reconnect || ++attempts > this.reconnect.maxRetries) {
            if (failed) throw failure;
            return;
          }
          const wait = backoff(this.reconnect, attempts);
          if (failed) this.logger?.warn?.(`[rtsp] AvSource read failed, reconnecting in ${wait}ms:`, failure);
          else this.logger?.warn?.(`[rtsp] AvSource input ended, reconnecting in ${wait}ms`);
          await delay(wait, lifecycle.signal);
          if (lifecycle.signal.aborted) return;
        }

        attempts = await reopen(
          { input: this.input, layout: this.layout, policy: this.reconnect, name: 'AvSource input', logger: this.logger },
          attempts,
          lifecycle.signal,
        );
        if (lifecycle.signal.aborted) return;
        if (this.options.backchannel) this.talkback = this.readBackchannel();
      }
    } finally {
      unlink();
      this.reading = undefined;
      finish();
    }
  }

  /**
   * Close the input and release its native resources.
   *
   * Aborts a pending open or read first and waits for the read loop to unwind.
   * Safe to call at any time and more than once; the source can be opened
   * again afterwards.
   *
   * @returns A promise that resolves once the input is closed
   *
   * @example
   * ```typescript
   * await source.close();
   * ```
   */
  async close(): Promise<void> {
    this.lifecycle?.abort();
    await this.reading;
    await this.input.dispose();
    this.talkback = undefined;
  }

  /**
   * Read one pass over the open input, paced by {@link AvSourceOptions.readrate}.
   *
   * @param signal - Ends the pass and shortens a pacing wait
   *
   * @yields {Packet} Native packets, owned by the caller
   *
   * @throws {Error} If a read fails
   *
   * @internal
   */
  private async *readPass(signal: AbortSignal): AsyncGenerator<Packet> {
    const readrate = this.options.readrate ?? 0;
    let anchor: { wall: number; media: number } | undefined;

    for await (const packet of this.input.packets()) {
      if (signal.aborted) {
        packet.free();
        return;
      }
      if (readrate > 0) {
        const timeBase = packet.timeBase;
        const dts = packet.dts;
        if (timeBase.den > 0 && dts >= 0n) {
          const media = (Number(dts) * timeBase.num) / timeBase.den / readrate;
          anchor ??= { wall: performance.now(), media };
          const wait = (media - anchor.media) * 1000 - (performance.now() - anchor.wall);
          if (wait > 1) await delay(wait, signal);
        }
      }
      yield packet;
    }
  }

  /**
   * Read the send-only stream a camera advertises for talkback.
   *
   * @returns The backchannel format, or `undefined` if the camera has none
   *
   * @internal
   */
  private readBackchannel(): BackchannelInfo | undefined {
    const streams = this.input.current?.getFormatContext().getRTSPStreamInfo();
    const send = streams?.find((stream) => stream.direction === 'sendonly');
    if (!send) {
      this.logger?.warn?.('[rtsp] backchannel requested but the camera advertises none');
      return undefined;
    }
    return {
      streamIndex: send.streamIndex,
      codec: avGetCodecName(send.codecId) ?? 'unknown',
      codecId: send.codecId,
      payloadType: send.payloadType,
      clockRate: send.sampleRate ?? 8000,
      channels: send.channels ?? 1,
    };
  }
}

/**
 * Build the libav demuxer options from the dedicated fields and the raw option bag.
 *
 * @param options - The source options
 *
 * @returns The merged option bag
 *
 * @internal
 */
function demuxOptions(options: AvSourceOptions): Record<string, string | number> {
  const merged: Record<string, string | number> = { ...options.options };
  if (options.transport) merged.rtsp_transport = options.transport;
  if (options.timeout !== undefined) merged.timeout = Math.round(options.timeout * MS_TO_US);
  return merged;
}

/**
 * Append `backchannel=1` to an RTSP URL unless it already carries the parameter.
 *
 * @param url - The RTSP URL
 *
 * @returns The URL with the backchannel parameter
 *
 * @internal
 */
function withBackchannel(url: string): string {
  if (/[?&]backchannel=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}backchannel=1`;
}

/**
 * Describe an input for logging without leaking URL credentials.
 *
 * @param input - The input to describe
 *
 * @returns A printable description
 *
 * @internal
 */
function redact(input: AvInput): string {
  if (typeof input !== 'string') return Buffer.isBuffer(input) ? `<buffer ${input.length} bytes>` : '<stream>';
  return input.replace(/\/\/[^/@]*@/, '//***@');
}
