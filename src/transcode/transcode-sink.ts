import { avGetCodecName, FFmpegError, FormatContext } from 'node-av/lib';

import { wrapAvPacket } from '../av-packet.js';
import { acquireHardware } from './hardware.js';
import { createTrackTranscoder, planTranscode } from './track-transcoder.js';

import type { Encoder } from 'node-av/api';
import type { Packet, Stream } from 'node-av/lib';
import type { Logger, MediaPacket, Sink, StreamInfo, TrackInfo } from '../types.js';
import type { HardwareLease } from './hardware.js';
import type { TrackTranscoder, TranscodeOptions } from './track-transcoder.js';

/**
 * Options for a {@link TranscodeSink}.
 */
export interface TranscodeSinkOptions extends TranscodeOptions {
  /**
   * Time in milliseconds every re-encoded track has to produce its first packet.
   *
   * The wrapped sink is initialized once every track has output, so it learns
   * the final codec parameters. Tracks still silent after this time are left
   * out, and if none produced anything the stream fails. `0` waits forever.
   *
   * @default 10000
   */
  timeout?: number;

  /**
   * Logger for the chosen codecs, hardware and every fallback.
   */
  logger?: Logger;
}

/**
 * One track on its way through the sink.
 *
 * @internal
 */
interface Lane {
  track: TrackInfo;
  /** The track as the wrapped sink sees it, set once known. */
  output?: TrackInfo;
  transcoder?: TrackTranscoder;
  excluded: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
// packets held for the wrapped sink while an encoder warms up, far beyond any sane startup
const MAX_PENDING = 2048;

/**
 * Re-encodes tracks on their way into another sink.
 *
 * Wraps any sink, for example an {@link FfmpegSink} that records an MJPEG
 * camera as H.264 or a {@link CallbackSink} that wants AAC. Tracks that
 * already have the requested format are copied, everything else is decoded and
 * encoded again. Video uses one hardware device for decoding, scaling and
 * encoding, with a software fallback per stage. The wrapped sink sees the
 * re-encoded tracks as ordinary native streams, as if the source delivered
 * them.
 *
 * @example
 * ```typescript
 * import { AvSource, FfmpegSink, Relay, TranscodeSink } from '@seydx/rtsp';
 *
 * // record an MJPEG camera as 720p H.264
 * const relay = new Relay({ source: new AvSource('http://camera.local/video.mjpg', { format: 'mpjpeg', wallclock: true }) });
 * relay.pipe(new TranscodeSink(new FfmpegSink({ output: 'camera.mp4', format: 'mp4' }), { video: { codec: 'h264', height: 720 } }));
 * ```
 *
 * @example
 * ```typescript
 * import { CallbackSink, TranscodeSink } from '@seydx/rtsp';
 *
 * // software only, audio as 16 kHz mono AAC, video untouched
 * const sink = new TranscodeSink(new CallbackSink({ onPacket: handle }), {
 *   hardware: false,
 *   audio: { codec: 'aac', sampleRate: 16000, channels: 1 },
 * });
 * ```
 *
 * @see {@link Relay} For attaching it
 *
 * @see {@link RtspServerSink} For serving re-encoded tracks over RTSP
 */
export class TranscodeSink<S extends Sink = Sink> implements Sink {
  private readonly timeout: number;
  private readonly logger?: Logger;
  private lanes = new Map<number, Lane>();
  private pending: MediaPacket[] = [];
  private info?: StreamInfo;
  private context?: FormatContext;
  private lease?: HardwareLease;
  private timer?: NodeJS.Timeout;
  private passthrough = false;
  private started = false;
  private expired = false;

  /**
   * Wrap a sink.
   *
   * @param sink - The sink that receives the re-encoded stream; it is initialized and closed by this one
   *
   * @param options - Which tracks to re-encode, the hardware and the startup timeout
   *
   * @example
   * ```typescript
   * const sink = new TranscodeSink(new FfmpegSink({ output: 'out.ts', format: 'mpegts' }), { video: { codec: 'h264' } });
   * ```
   */
  constructor(
    readonly sink: S,
    private readonly options: TranscodeSinkOptions = {},
  ) {
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger;
  }

  /**
   * Plan every track and create the transcoders.
   *
   * Called by the relay. When no track needs re-encoding, the wrapped sink is
   * initialized right away and every packet passes through.
   *
   * @param info - The stream layout
   *
   * @returns A promise that resolves once the tracks are planned
   *
   * @throws {Error} If an encoder is not available or a decoder cannot be opened
   *
   * @internal
   */
  async init(info: StreamInfo): Promise<void> {
    const plans = info.tracks.map((track) => ({ track, plan: planTranscode(track, this.options) }));
    if (!plans.some(({ plan }) => plan)) {
      this.passthrough = true;
      await this.sink.init(info);
      return;
    }

    this.info = info;
    if (plans.some(({ plan }) => plan?.kind === 'video')) {
      this.lease = acquireHardware(this.options.hardware);
      if (!this.lease) this.logger?.debug?.('[rtsp] no hardware device in use, transcoding video in software');
    }
    try {
      for (const { track, plan } of plans) {
        const transcoder = plan && createTrackTranscoder(plan, this.lease?.context, this.logger);
        this.lanes.set(track.index, { track, output: plan ? undefined : track, transcoder, excluded: false });
      }
    } catch (error) {
      // nothing must reach the wrapped sink after a failed init, not even from close()
      this.release();
      throw error;
    }
    if (this.timeout > 0) {
      // only flags the deadline, the next write starts the wrapped sink so writes never overlap
      this.timer = setTimeout(() => (this.expired = true), this.timeout);
      this.timer.unref();
    }
  }

  /**
   * Copy or re-encode one packet into the wrapped sink.
   *
   * @param packet - The packet, owned by the relay
   *
   * @returns A promise that resolves once the packet is handled
   *
   * @throws {Error} If transcoding or the wrapped sink fails, or no track produced output in time
   *
   * @internal
   */
  async write(packet: MediaPacket): Promise<void> {
    if (this.passthrough) return this.sink.write(packet);
    const lane = this.lanes.get(packet.streamIndex);
    if (!lane || lane.excluded) return;

    if (lane.transcoder) {
      if (packet.av) await this.forward(lane, await lane.transcoder.transcode(packet.av));
    } else if (this.started) {
      return this.sink.write(packet);
    } else {
      this.pending.push(packet.clone());
    }
    if (!this.started && (this.expired || this.pending.length >= MAX_PENDING || this.allReady())) await this.start();
  }

  /**
   * Drain the encoders into the wrapped sink, then close it and release everything.
   *
   * The wrapped sink is closed even if the stream ended before it was
   * initialized, so it can release whatever waits for the stream.
   *
   * @returns A promise that resolves once the wrapped sink is closed
   *
   * @internal
   */
  async close(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      if (!this.passthrough) await this.drain();
    } catch (error) {
      this.logger?.debug?.('[rtsp] draining the transcoders failed:', error);
    }
    this.release();
    try {
      await this.sink.close();
    } finally {
      // freed last, the wrapped sink may hold the synthetic streams until it closed
      this.context?.freeContext();
      this.context = undefined;
      this.info = undefined;
      this.passthrough = false;
      this.started = false;
      this.expired = false;
    }
  }

  /**
   * Hand encoded packets to the wrapped sink, or hold them until it starts.
   *
   * @param lane - The lane the packets belong to
   *
   * @param encoded - Encoded packets; ownership is consumed
   *
   * @returns A promise that resolves once the packets are written or held
   *
   * @throws {Error} If the output stream cannot be described or the wrapped sink fails
   *
   * @internal
   */
  private async forward(lane: Lane, encoded: Packet[]): Promise<void> {
    if (encoded.length === 0) return;
    try {
      lane.output ??= this.describeOutput(lane.track, lane.transcoder!.encoder);
    } catch (error) {
      for (const out of encoded) out.free();
      throw error;
    }
    const packets = encoded.map((out) => wrapAvPacket(out, lane.track.index));
    if (!this.started) {
      this.pending.push(...packets);
      return;
    }
    try {
      for (const packet of packets) await this.sink.write(packet);
    } finally {
      for (const packet of packets) packet.free();
    }
  }

  /**
   * Initialize the wrapped sink with the tracks that have output and write the held packets.
   *
   * @returns A promise that resolves once the held packets are written
   *
   * @throws {Error} If no track produced output, or the wrapped sink fails
   *
   * @internal
   */
  private async start(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const lanes = [...this.lanes.values()];
    if (!lanes.some((lane) => lane.output)) throw new Error(`TranscodeSink: no track produced output within ${this.timeout}ms`);
    for (const lane of lanes) {
      if (lane.output) continue;
      this.logger?.warn?.(`[rtsp] leaving ${lane.track.kind} track #${lane.track.index} out, its transcoder produced nothing in time`);
      lane.excluded = true;
      lane.transcoder?.close();
      lane.transcoder = undefined;
    }

    this.started = true;
    await this.sink.init({ ...this.info!, tracks: lanes.filter((lane) => lane.output).map((lane) => lane.output!) });
    const pending = this.pending;
    this.pending = [];
    try {
      for (const packet of pending) await this.sink.write(packet);
    } finally {
      for (const packet of pending) packet.free();
    }
  }

  /**
   * Flush every transcoder at the end of the stream.
   *
   * Starts the wrapped sink if the last packets made the remaining tracks ready.
   *
   * @returns A promise that resolves once everything is written
   *
   * @throws {Error} If a transcoder or the wrapped sink fails
   *
   * @internal
   */
  private async drain(): Promise<void> {
    for (const lane of this.lanes.values()) {
      if (lane.transcoder && !lane.excluded) await this.forward(lane, await lane.transcoder.flush());
    }
    if (!this.started && [...this.lanes.values()].some((lane) => lane.output)) await this.start();
  }

  /**
   * Close the transcoders, free the held packets and return the hardware.
   *
   * @internal
   */
  private release(): void {
    for (const lane of this.lanes.values()) lane.transcoder?.close();
    this.lanes = new Map();
    for (const packet of this.pending) packet.free();
    this.pending = [];
    this.lease?.release();
    this.lease = undefined;
  }

  /**
   * Whether every track has output or was left out.
   *
   * @returns `true` once the wrapped sink can start
   *
   * @internal
   */
  private allReady(): boolean {
    for (const lane of this.lanes.values()) if (!lane.output && !lane.excluded) return false;
    return true;
  }

  /**
   * Describe a re-encoded track as a native stream for the wrapped sink.
   *
   * @param track - The source track
   *
   * @param encoder - The encoder whose packets the track carries
   *
   * @returns The track description
   *
   * @throws {Error} If the encoder parameters cannot be copied
   *
   * @internal
   */
  private describeOutput(track: TrackInfo, encoder: Encoder): TrackInfo {
    const codecContext = encoder.getCodecContext();
    if (!codecContext) throw new Error(`TranscodeSink: the encoder of track #${track.index} is not open`);
    if (!this.context) {
      this.context = new FormatContext();
      this.context.allocContext();
    }
    const stream: Stream = this.context.newStream(null);
    FFmpegError.throwIfError(stream.codecpar.fromContext(codecContext), 'Failed to copy the encoder parameters');
    // packets leave the encoder in its codec time base and muxers rescale from the stream's
    const { num, den } = codecContext.timeBase;
    stream.timeBase = codecContext.timeBase;
    // nominal for variable rate sources, containers and the sdp announce it
    if (codecContext.framerate.num > 0) stream.avgFrameRate = codecContext.framerate;
    return { index: track.index, kind: track.kind, codec: avGetCodecName(stream.codecpar.codecId) ?? 'unknown', native: stream, timeBase: { num, den } };
  }
}
