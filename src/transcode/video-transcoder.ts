import { Decoder, Encoder, FilterAPI, FilterPreset } from 'node-av/api';
import { AV_CODEC_FLAG_GLOBAL_HEADER, AV_CODEC_ID_H264, AV_CODEC_ID_HEVC, AV_NOPTS_VALUE, AV_PIX_FMT_NV12, FF_THREAD_SLICE } from 'node-av/constants';
import { avGetPixFmtName, Codec, Rational } from 'node-av/lib';
import { availableParallelism } from 'node:os';

import type { HardwareContext } from 'node-av/api';
import type { AVPixelFormat, FFEncoderCodec } from 'node-av/constants';
import type { CodecContext, Frame, IRational, Packet, Stream } from 'node-av/lib';
import type { Logger } from '../types.js';
import type { TrackTranscoder, VideoTranscodeOptions } from './track-transcoder.js';

/**
 * What a filter graph receives.
 *
 * @internal
 */
export interface GraphInput {
  /** The frames live on the device. */
  hw: boolean;
  /** Pixel format, the software format of the device frames for `hw`. */
  format: AVPixelFormat;
  width: number;
  height: number;
}

/**
 * What a filter graph has to deliver to the encoder.
 *
 * @internal
 */
export interface GraphTarget {
  width: number;
  height: number;
  /** The encoder runs on the device. */
  hwEncoder: boolean;
  /** Scale and convert on the device instead of in software. */
  hwFilter: boolean;
}

const DEFAULT_BITRATE = 2_000_000;
const FALLBACK_FPS = 25;
// packets held at most while their timestamps tell no steady rate
const MAX_RATE_SAMPLES = 60;
// closer frames were buffered on the way, the cameras this is meant for send no faster
const MIN_FRAME_INTERVAL = 1 / 60;
// seconds of arrival after which the frames that piled up at the start have passed
const START_SETTLE = 0.5;
// packets a hardware decoder may take for its first frame; some fail silently on input they cannot handle
const HW_DECODE_PROBE = 16;
// packets a running decoder may hold back after an intact keyframe before it counts as stuck
const HW_DECODE_DELAY = 8;
// frame threads of a software decoder, each one holds back a frame before the first comes out
const MAX_FRAME_THREADS = 4;

/**
 * Video track transcoding with one hardware device for every stage.
 *
 * Decoding, scaling and encoding each run on the device when it can handle
 * them. Each stage falls back to software on its own: the decoder when it
 * produces nothing, the filters and the encoder when they fail before the
 * first packet. The encoder keeps the source timestamps, so variable frame
 * rate sources such as MJPEG cameras stay in sync with their audio, and gets
 * the frame rate separately, measured from the first frames when the source
 * reports none.
 *
 * @internal
 */
export class VideoTranscoder implements TrackTranscoder {
  private decoder: Decoder;
  private held: Packet[] = [];
  private proven = false;
  private silent = 0;
  private silentKeyframes = 0;
  private sinceSecondKeyframe = 0;
  private rate?: IRational;
  private warmup: Packet[] = [];
  private current!: Encoder;
  private hwEncoder = false;
  private hwFilter: boolean;
  private settled = false;
  private filter?: FilterAPI;
  private graph?: string;
  private size?: { width: number; height: number };

  /**
   * @param stream - The demuxer stream of the track
   *
   * @param options - Output format
   *
   * @param hardware - Device to use, owned by the caller
   *
   * @param logger - Logger for the chosen codecs and every fallback
   *
   * @throws {Error} If no encoder exists for the codec or the decoder cannot be opened
   *
   * @internal
   */
  constructor(
    private readonly stream: Stream,
    private readonly options: VideoTranscodeOptions,
    private readonly hardware: HardwareContext | undefined,
    private readonly logger?: Logger,
  ) {
    // r_frame_rate is only a guess for untimed input (25 for mjpeg over http), the average is measured
    const { num, den } = stream.avgFrameRate;
    if (num > 0 && den > 0) this.rate = { num, den };
    this.hwFilter = hardware !== undefined;
    this.decoder = this.openDecoder(hardware);
    this.openEncoder(hardware !== undefined);
  }

  /**
   * The encoder that produced the last packets.
   *
   * @internal
   */
  get encoder(): Encoder {
    return this.current;
  }

  /**
   * Transcode one packet.
   *
   * @param packet - The packet, still owned by the caller
   *
   * @returns Encoded packets, owned by the caller
   *
   * @throws {Error} If filtering or encoding fails without a fallback left
   *
   * @internal
   */
  async transcode(packet: Packet): Promise<Packet[]> {
    if (this.rate) return this.encodeFrames(await this.decode(packet));
    // held undecoded: a device decoder has only a few surfaces to keep frames in
    const held = packet.clone();
    if (held) this.warmup.push(held);
    return this.measure(false) ? this.drainWarmup() : [];
  }

  /**
   * Drain the decoder and the encoder at the end of the stream.
   *
   * @returns The remaining encoded packets, owned by the caller
   *
   * @throws {Error} If encoding fails
   *
   * @internal
   */
  async flush(): Promise<Packet[]> {
    const encoded: Packet[] = [];
    try {
      if (!this.rate) {
        this.measure(true);
        encoded.push(...(await this.drainWarmup()));
      }
      // scale, format and transfer filters hold no frames, only the codecs need draining
      encoded.push(...(await this.encodeFrames(await this.decoder.decodeAll(null))));
      if (this.current.isEncoderInitialized) encoded.push(...(await this.current.encodeAll(null)));
    } catch (error) {
      for (const out of encoded) out.free();
      throw error;
    }
    return encoded;
  }

  /**
   * Release the codecs and the filter. The hardware device stays with its owner.
   *
   * @internal
   */
  close(): void {
    this.resetWatch();
    for (const held of this.warmup) held.free();
    this.warmup = [];
    this.decoder.close();
    this.current.close();
    this.resetFilter();
  }

  /**
   * Decode one packet, moving to software when the hardware decoder gets stuck.
   *
   * A new hardware decoder has to produce a frame within `HW_DECODE_PROBE`
   * packets. A running one counts as stuck once two keyframes in a row stayed
   * silent, because a single corrupt keyframe leaves even a healthy decoder
   * silent until the next one. Packets since the last silent keyframe are
   * held, so the software decoder starts over from it.
   *
   * @param packet - The packet, still owned by the caller
   *
   * @returns Decoded frames, owned by the caller
   *
   * @throws {Error} If software decoding fails
   *
   * @internal
   */
  private async decode(packet: Packet): Promise<Frame[]> {
    if (!this.decoder.isHardware()) return this.decoder.decodeAll(packet);
    let frames: Frame[];
    try {
      frames = await this.decoder.decodeAll(packet);
    } catch (error) {
      return this.decodeInSoftware(packet, error);
    }
    if (frames.length > 0) {
      this.proven = true;
      this.resetWatch();
      return frames;
    }

    this.silent++;
    if (packet.isKeyframe && ++this.silentKeyframes === 2) this.sinceSecondKeyframe = 0;
    else if (this.silentKeyframes >= 2) this.sinceSecondKeyframe++;
    // only a run that starts at a keyframe can be replayed
    if (packet.isKeyframe) this.dropHeld();
    if (packet.isKeyframe || this.held.length > 0) {
      const held = packet.clone();
      if (held) this.held.push(held);
    }
    const stuck = this.proven ? this.silentKeyframes >= 2 && this.sinceSecondKeyframe >= HW_DECODE_DELAY : this.silent >= HW_DECODE_PROBE;
    return stuck ? this.decodeInSoftware(undefined, new Error(`no frame from the last ${this.silent} packets`)) : frames;
  }

  /**
   * Replace the hardware decoder with a software one and replay the held packets.
   *
   * @param pending - The packet that failed, still owned by the caller
   *
   * @param reason - Why the hardware decoder was given up
   *
   * @returns Frames decoded from the replayed packets, owned by the caller
   *
   * @throws {Error} If the software decoder cannot be opened or fails
   *
   * @internal
   */
  private async decodeInSoftware(pending: Packet | undefined, reason: unknown): Promise<Frame[]> {
    this.logger?.warn?.(`[rtsp] hardware decoder ${this.decoder.getCodec().name} failed (${this.decoder.decodeErrors} decode errors), decoding in software:`, reason);
    this.decoder.close();
    this.decoder = this.openDecoder(undefined);
    const replay = this.held;
    this.held = [];
    this.resetWatch();
    const frames: Frame[] = [];
    try {
      for (const held of replay) frames.push(...(await this.decoder.decodeAll(held)));
      if (pending) frames.push(...(await this.decoder.decodeAll(pending)));
    } catch (error) {
      for (const frame of frames) frame.free();
      throw error;
    } finally {
      for (const held of replay) held.free();
    }
    return frames;
  }

  /**
   * Measure the frame rate from the held packets.
   *
   * @param final - The stream ended, use what was measured so far
   *
   * @returns `true` once the rate is known
   *
   * @internal
   */
  private measure(final: boolean): boolean {
    const fps = measureFps(
      this.warmup.map((held) => held.pts),
      this.stream.timeBase,
    );
    if (fps === undefined && !final) return false;
    this.rate = { num: fps ?? FALLBACK_FPS, den: 1 };
    this.logger?.debug?.(`[rtsp] video frame rate measured as ${this.rate.num} fps`);
    return true;
  }

  /**
   * Decode and encode the packets held while the frame rate was measured.
   *
   * One packet at a time, so no more decoded frames are alive than in the
   * running stream.
   *
   * @returns Encoded packets, owned by the caller
   *
   * @throws {Error} If decoding or encoding fails; the held packets are freed anyway
   *
   * @internal
   */
  private async drainWarmup(): Promise<Packet[]> {
    const warmup = this.warmup;
    this.warmup = [];
    const encoded: Packet[] = [];
    try {
      for (const held of warmup) encoded.push(...(await this.encodeFrames(await this.decode(held))));
    } catch (error) {
      for (const out of encoded) out.free();
      throw error;
    } finally {
      for (const held of warmup) held.free();
    }
    return encoded;
  }

  /**
   * Encode decoded frames and free them.
   *
   * @param frames - Frames owned by this call
   *
   * @returns Encoded packets, owned by the caller
   *
   * @throws {Error} If encoding fails; frames and packets are freed anyway
   *
   * @internal
   */
  private async encodeFrames(frames: Frame[]): Promise<Packet[]> {
    const encoded: Packet[] = [];
    try {
      for (const frame of frames) encoded.push(...(await this.encodeFrame(frame)));
    } catch (error) {
      for (const out of encoded) out.free();
      throw error;
    } finally {
      for (const frame of frames) frame.free();
    }
    return encoded;
  }

  /**
   * Encode one frame, stepping down to software until something works before the first packet.
   *
   * @param frame - The decoded frame, still owned by the caller
   *
   * @returns Encoded packets, owned by the caller
   *
   * @throws {Error} If encoding fails after the first packet, or in software
   *
   * @internal
   */
  private async encodeFrame(frame: Frame): Promise<Packet[]> {
    for (;;) {
      try {
        const packets = await this.filterAndEncode(frame);
        if (packets.length > 0) this.settled = true;
        return packets;
      } catch (error) {
        if (this.settled || !this.stepDown(error)) throw error;
      }
    }
  }

  /**
   * Run a frame through the filter graph it needs and the encoder.
   *
   * @param frame - The decoded frame, still owned by the caller; filters keep their own reference
   *
   * @returns Encoded packets, owned by the caller
   *
   * @throws {Error} If the graph cannot be built, or filtering or encoding fails
   *
   * @internal
   */
  private async filterAndEncode(frame: Frame): Promise<Packet[]> {
    // pinned on the first frame, a camera that changes resolution is scaled back to it
    this.size ??= outputSize(frame.width, frame.height, this.options);
    const graph = videoGraph(describeFrame(frame), { ...this.size, hwEncoder: this.hwEncoder, hwFilter: this.hwFilter }, this.hardware);
    if (graph !== this.graph) {
      this.resetFilter();
      if (graph) {
        this.filter = FilterAPI.create(graph, { hardware: this.hardware });
        this.logger?.debug?.(`[rtsp] video filter ${graph}`);
      }
      this.graph = graph;
    }
    if (!this.filter) return this.current.encodeAll(frame);

    const filtered = await this.filter.processAll(frame);
    const encoded: Packet[] = [];
    try {
      for (const out of filtered) encoded.push(...(await this.current.encodeAll(out)));
    } catch (error) {
      for (const out of encoded) out.free();
      throw error;
    } finally {
      for (const out of filtered) out.free();
    }
    return encoded;
  }

  /**
   * Move the next stage to software after a failure.
   *
   * Device filters go first, then the hardware encoder.
   *
   * @param error - The failure
   *
   * @returns `false` if everything already runs in software
   *
   * @internal
   */
  private stepDown(error: unknown): boolean {
    let hwEncoder = this.hwEncoder;
    if (this.hwFilter) {
      this.logger?.warn?.('[rtsp] video filtering on the device failed, filtering in software:', error);
      this.hwFilter = false;
    } else if (hwEncoder) {
      this.logger?.warn?.(`[rtsp] hardware encoder ${this.current.getCodec().name} failed, encoding in software:`, error);
      hwEncoder = false;
    } else {
      return false;
    }
    // a failed encoder may be half open, the next attempt starts clean
    this.resetFilter();
    this.current.close();
    this.openEncoder(hwEncoder);
    return true;
  }

  /**
   * Open a decoder, on the device when possible, threaded for low latency.
   *
   * @param hardware - Device to decode on, if any
   *
   * @returns The decoder
   *
   * @throws {Error} If no software decoder can be opened either
   *
   * @internal
   */
  private openDecoder(hardware: HardwareContext | undefined): Decoder {
    if (hardware) {
      try {
        const decoder = Decoder.createSync(this.stream, { exitOnError: false, hardware, configure: liveThreading });
        this.logger?.debug?.(`[rtsp] decoding video with ${decoder.getCodec().name}${decoder.isHardware() ? ` on ${hardware.deviceTypeName}` : ''}`);
        return decoder;
      } catch (error) {
        this.logger?.warn?.('[rtsp] hardware decoder unavailable, decoding in software:', error);
      }
    }
    return Decoder.createSync(this.stream, { exitOnError: false, configure: liveThreading });
  }

  /**
   * Create the encoder, on the device when possible.
   *
   * @param hardware - Try the device's encoder first
   *
   * @throws {Error} If no encoder exists for the codec
   *
   * @internal
   */
  private openEncoder(hardware: boolean): void {
    const hevc = this.options.codec === 'hevc';
    const device = hardware ? this.hardware?.getEncoderCodec(hevc ? 'hevc' : 'h264') : undefined;
    const codec = device ?? softwareEncoder(hevc);
    this.hwEncoder = device !== undefined && device !== null;
    this.current = createEncoder(codec, this.options, () => this.rate ?? { num: FALLBACK_FPS, den: 1 });
    this.logger?.debug?.(`[rtsp] encoding video with ${codec.name}${this.hwEncoder ? ` on ${this.hardware!.deviceTypeName}` : ''}`);
  }

  /**
   * Close the filter graph so the next frame builds a new one.
   *
   * @internal
   */
  private resetFilter(): void {
    this.filter?.close();
    this.filter = undefined;
    this.graph = undefined;
  }

  /**
   * Reset the stuck detection after a frame came out.
   *
   * @internal
   */
  private resetWatch(): void {
    this.dropHeld();
    this.silent = 0;
    this.silentKeyframes = 0;
    this.sinceSecondKeyframe = 0;
  }

  /**
   * Free the held packets.
   *
   * @internal
   */
  private dropHeld(): void {
    for (const held of this.held) held.free();
    this.held = [];
  }
}

/**
 * Choose low latency threading for a decoder before it opens.
 *
 * A device decoder gets slice threading, which costs it nothing. A software
 * decoder keeps frame threading with at most `MAX_FRAME_THREADS` threads, like
 * node-av's live streams: frame threading holds back one frame per thread, up
 * to 16 with the automatic count, and slice threading only splits a frame into
 * its slices, while most cameras send one slice per frame.
 *
 * @param context - The decoder context, with its device set only when it decodes on it
 *
 * @internal
 */
export function liveThreading(context: CodecContext): void {
  if (context.hwDeviceCtx) {
    context.threadType = FF_THREAD_SLICE;
    return;
  }
  // ffmpeg's automatic count is one more than the cpus, a single thread on one cpu
  const cpus = availableParallelism();
  context.threadCount = cpus > 1 ? Math.min(cpus + 1, MAX_FRAME_THREADS) : 1;
}

/**
 * Output size for a source size, keeping the aspect ratio when only one side is given.
 *
 * @param width - Source width
 *
 * @param height - Source height
 *
 * @param options - Requested width and height
 *
 * @param options.width - Requested width, if any
 *
 * @param options.height - Requested height, if any
 *
 * @returns The output size, rounded to even numbers when scaled
 *
 * @internal
 */
export function outputSize(width: number, height: number, options: { width?: number; height?: number }): { width: number; height: number } {
  const { width: w, height: h } = options;
  if (w && h) return { width: even(w), height: even(h) };
  if (w && width > 0 && height > 0) return { width: even(w), height: even((w * height) / width) };
  if (h && width > 0 && height > 0) return { width: even((h * width) / height), height: even(h) };
  return { width, height };
}

/**
 * Build the filter graph that brings a frame into the encoder's size and format.
 *
 * Device frames stay on the device when the encoder runs there, software
 * frames are uploaded for a hardware encoder and device frames are downloaded
 * for a software one. Scaling and format conversion happen on the device when
 * `hwFilter` is set, otherwise in software.
 *
 * @param input - The frame
 *
 * @param target - The encoder's needs
 *
 * @param hardware - The device, required for anything on the device
 *
 * @returns The filter description, or `undefined` when the frame can go to the encoder as is
 *
 * @throws {Error} If the device cannot scale and `hwFilter` asks for it
 *
 * @internal
 */
export function videoGraph(input: GraphInput, target: GraphTarget, hardware: HardwareContext | undefined): string | undefined {
  const resize = input.width !== target.width || input.height !== target.height;
  const scale = `scale=${target.width}:${target.height}`;
  const device = hardware && target.hwEncoder;
  const parts: string[] = [];

  if (input.hw && device && target.hwFilter) {
    if (resize) parts.push(gpuScale(hardware, target.width, target.height));
    if (input.format !== AV_PIX_FMT_NV12) parts.push(FilterPreset.chain(hardware).scaleFormat(AV_PIX_FMT_NV12).build());
  } else if (input.hw && device) {
    if (resize || input.format !== AV_PIX_FMT_NV12)
      parts.push('hwdownload', `format=${pixFmtName(input.format)}`, ...(resize ? [scale] : []), 'format=nv12', upload(hardware));
  } else if (input.hw) {
    parts.push('hwdownload', `format=${pixFmtName(input.format)}`, ...(resize ? [scale] : []), 'format=yuv420p');
  } else if (device && target.hwFilter && resize) {
    parts.push('format=nv12', upload(hardware), gpuScale(hardware, target.width, target.height));
  } else if (device) {
    parts.push(...(resize ? [scale] : []), 'format=nv12', upload(hardware));
  } else {
    // 4:2:0 is the only chroma layout browsers and hardware decoders reliably play
    parts.push(...(resize ? [scale] : []), 'format=yuv420p');
  }
  return parts.length > 0 ? parts.join(',') : undefined;
}

/**
 * Describe a decoded frame for {@link videoGraph}.
 *
 * @param frame - The frame
 *
 * @returns Its location, format and size
 *
 * @internal
 */
function describeFrame(frame: Frame): GraphInput {
  const hw = frame.isHwFrame();
  const format = hw ? (frame.hwFramesCtx?.swFormat ?? AV_PIX_FMT_NV12) : (frame.format as AVPixelFormat);
  return { hw, format, width: frame.width, height: frame.height };
}

/**
 * The device scaler for a size.
 *
 * @param hardware - The device
 *
 * @param width - Output width
 *
 * @param height - Output height
 *
 * @returns The filter
 *
 * @throws {Error} If the device has no scaler
 *
 * @internal
 */
function gpuScale(hardware: HardwareContext, width: number, height: number): string {
  const chain = FilterPreset.chain(hardware);
  // the builder would leave the scaler out without a word
  if (!chain.supports('scale')) throw new Error(`${hardware.deviceTypeName} cannot scale video`);
  return chain.scale(width, height).build();
}

/**
 * The upload filter of a device.
 *
 * @param hardware - The device
 *
 * @returns The filter
 *
 * @internal
 */
function upload(hardware: HardwareContext): string {
  return FilterPreset.chain(hardware).hwupload().build();
}

/**
 * Name of a pixel format for a filter description.
 *
 * @param format - The pixel format
 *
 * @returns Its FFmpeg name
 *
 * @internal
 */
function pixFmtName(format: AVPixelFormat): string {
  return avGetPixFmtName(format) ?? 'nv12';
}

/**
 * Measure the frame rate from the timestamps of the first frames.
 *
 * The rate is taken from the latest half second, at least four intervals, or
 * from two intervals once they span a second, as soon as those arrived
 * steadily. Frames that piled up while a live input was probed or its sinks
 * started arrive closer together, at whatever pace they were read, and
 * wallclock timestamps then say nothing about the rate. Taken as the rate they
 * made x264 announce up to 240 fps with a keyframe just as rarely. A source
 * that delivers its frames in groups, such as a camera flushing every other
 * frame, never arrives steadily and is measured over whole groups instead.
 *
 * @param pts - Timestamps of consecutive frames, in decode order
 *
 * @param timeBase - Their time base
 *
 * @returns Whole frames per second, or `undefined` while too little arrived
 *
 * @internal
 */
export function measureFps(pts: readonly bigint[], timeBase: IRational): number | undefined {
  if (pts.some((value) => value === AV_NOPTS_VALUE)) return FALLBACK_FPS;
  // b-frames arrive in decode order
  const sorted = [...pts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const times = sorted.map((value) => (Number(value - sorted[0]) * timeBase.num) / timeBase.den);
  const intervals = times.slice(1).map((time, i) => time - times[i]);
  // only sources faster than MIN_FRAME_INTERVAL get here, within a second
  if (sorted.length >= MAX_RATE_SAMPLES) return toFps(typicalInterval(intervals.slice(intervals.length >> 1)));
  return steadyFps(intervals) ?? groupedFps(times);
}

/**
 * The rate of the latest intervals, if they arrived steadily.
 *
 * @param intervals - Intervals between consecutive frames in seconds
 *
 * @returns Whole frames per second, or `undefined` while the window is short or unsteady
 *
 * @internal
 */
function steadyFps(intervals: readonly number[]): number | undefined {
  let count = 0;
  let span = 0;
  while (count < intervals.length && !windowComplete(count, span)) span += intervals[intervals.length - ++count];
  if (!windowComplete(count, span)) return undefined;
  const recent = intervals.slice(-count);
  const typical = typicalInterval(recent);
  const floor = Math.max(MIN_FRAME_INTERVAL, typical / 2);
  return recent.every((interval) => interval >= floor) ? toFps(typical) : undefined;
}

/**
 * The rate over whole groups of frames that arrive together.
 *
 * A group starts after an interval of at least half the mean. Counting the
 * frames between two group starts a second apart, after the start has settled,
 * gives the exact average however the frames are grouped.
 *
 * @param times - Arrival of each frame in seconds after the first
 *
 * @returns Whole frames per second, or `undefined` before a second of groups arrived
 *
 * @internal
 */
function groupedFps(times: readonly number[]): number | undefined {
  const threshold = Math.max(MIN_FRAME_INTERVAL, times[times.length - 1] / (times.length - 1) / 2);
  let first: number | undefined;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] < threshold || times[i] < START_SETTLE) continue;
    first ??= i;
    if (times[i] - times[first] >= 1) return toFps((times[i] - times[first]) / (i - first));
  }
  return undefined;
}

/**
 * Whether the latest intervals are enough to tell a rate.
 *
 * @param count - Number of intervals
 *
 * @param span - Their sum in seconds
 *
 * @returns `true` for half a second of at least four intervals, or a second of at least two
 *
 * @internal
 */
function windowComplete(count: number, span: number): boolean {
  return (count >= 4 && span >= 0.5) || (count >= 2 && span >= 1);
}

/**
 * Mean of the middle half of some intervals, robust against a single drop or stall.
 *
 * @param intervals - Intervals in seconds
 *
 * @returns The typical interval in seconds
 *
 * @internal
 */
function typicalInterval(intervals: readonly number[]): number {
  const sorted = [...intervals].sort((a, b) => a - b);
  const cut = sorted.length >> 2;
  const middle = sorted.slice(cut, sorted.length - cut);
  return middle.length > 0 ? middle.reduce((sum, value) => sum + value, 0) / middle.length : 0;
}

/**
 * Whole frames per second for a frame interval.
 *
 * @param interval - Seconds per frame
 *
 * @returns The rate, `FALLBACK_FPS` for an interval of zero
 *
 * @internal
 */
function toFps(interval: number): number {
  return interval > 0 ? Math.min(240, Math.max(1, Math.round(1 / interval))) : FALLBACK_FPS;
}

/**
 * Round to the nearest even size of at least 2.
 *
 * @param value - The size
 *
 * @returns The even size
 *
 * @internal
 */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * The software encoder for a codec.
 *
 * @param hevc - HEVC instead of H.264
 *
 * @returns The encoder
 *
 * @throws {Error} If none exists
 *
 * @internal
 */
function softwareEncoder(hevc: boolean): Codec {
  const codec = Codec.findEncoderByName((hevc ? 'libx265' : 'libx264') as FFEncoderCodec) ?? Codec.findEncoder(hevc ? AV_CODEC_ID_HEVC : AV_CODEC_ID_H264);
  if (!codec) throw new Error(`No ${hevc ? 'HEVC' : 'H.264'} encoder available`);
  return codec;
}

/**
 * Create a live-tuned encoder.
 *
 * @param codec - The encoder codec
 *
 * @param options - Bit rate and keyframe interval
 *
 * @param rate - The frame rate, read when the encoder opens on its first frame
 *
 * @returns The encoder, initialized lazily from the first frame
 *
 * @internal
 */
function createEncoder(codec: Codec, options: VideoTranscodeOptions, rate: () => IRational): Encoder {
  const x26x = codec.name === 'libx264' || codec.name === 'libx265';
  const encoder = Encoder.createSync(codec, {
    bitrate: options.bitRate ?? DEFAULT_BITRATE,
    maxBFrames: 0,
    autoFormat: true,
    options: x26x ? { preset: 'veryfast', tune: 'zerolatency' } : {},
    // runs after node-av derived the time base from the frames, so the fine source clock stays.
    // without a frame rate encoders take 1/time base as one: x264 picks level 6.2 for a 90 kHz clock
    // and hardware rate control spreads the bit rate over 90000 frames per second
    configure: (context) => {
      const { num, den } = rate();
      context.framerate = new Rational(num, den);
      context.gopSize = options.gopSize ?? Math.max(1, Math.round(num / den));
    },
  });
  // rtsp clients read the parameter sets from the sdp and mp4 needs them in the header, both as extradata
  encoder.setCodecFlags(AV_CODEC_FLAG_GLOBAL_HEADER);
  return encoder;
}
