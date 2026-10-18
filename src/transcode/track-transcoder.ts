import {
  AV_CODEC_ID_AAC,
  AV_CODEC_ID_H264,
  AV_CODEC_ID_HEVC,
  AV_PIX_FMT_NONE,
  AV_PIX_FMT_NV12,
  AV_PIX_FMT_P010LE,
  AV_PIX_FMT_YUV420P,
  AV_PIX_FMT_YUV420P10LE,
  AV_PIX_FMT_YUVJ420P,
  AV_PROFILE_AAC_ELD,
  AV_PROFILE_AAC_LD,
} from 'node-av/constants';
import { Codec } from 'node-av/lib';

import { AudioPipeline } from './audio-pipeline.js';
import { outputSize, VideoTranscoder } from './video-transcoder.js';

import type { Encoder, HardwareContext } from 'node-av/api';
import type { AVPixelFormat, FFEncoderCodec } from 'node-av/constants';
import type { Packet, Stream } from 'node-av/lib';
import type { Logger, TrackInfo } from '../types.js';
import type { HardwareSetting } from './hardware.js';

/**
 * Audio re-encoding of a track.
 */
export interface AudioTranscodeOptions {
  /**
   * Encoder name, for example `aac`, `libopus` or `pcm_mulaw`.
   *
   * @default 'aac'
   */
  codec?: string;

  /**
   * Output sample rate in Hz, defaults to the source rate.
   */
  sampleRate?: number;

  /**
   * Output channel count, defaults to the source layout.
   */
  channels?: number;

  /**
   * Target bit rate in bits per second, defaults to the encoder's choice.
   *
   * Only applies when the track is re-encoded, a copied track keeps its bit rate.
   */
  bitRate?: number;

  /**
   * Re-encode even when the track already matches.
   *
   * By default a track that already has the requested codec, sample rate and
   * channel count is copied unchanged, which costs nothing and keeps its
   * quality. Low delay AAC (LD and ELD) never counts as a match, because hardly
   * any player decodes it.
   *
   * @default false
   */
  force?: boolean;
}

/**
 * Video re-encoding of a track, for example MJPEG to H.264.
 */
export interface VideoTranscodeOptions {
  /**
   * Output codec.
   *
   * @default 'h264'
   */
  codec?: 'h264' | 'hevc';

  /**
   * Output width in pixels.
   *
   * Without {@link VideoTranscodeOptions.height} the height follows the
   * source aspect ratio. Sizes are rounded to even numbers, which 4:2:0 video
   * requires. Defaults to the source size.
   */
  width?: number;

  /**
   * Output height in pixels.
   *
   * Without {@link VideoTranscodeOptions.width} the width follows the source
   * aspect ratio. Sizes are rounded to even numbers, which 4:2:0 video
   * requires. Defaults to the source size.
   */
  height?: number;

  /**
   * Target bit rate in bits per second.
   *
   * Only applies when the track is re-encoded, a copied track keeps its bit rate.
   *
   * @default 2000000
   */
  bitRate?: number;

  /**
   * Distance between keyframes in frames.
   *
   * New viewers start at a keyframe, so a short interval makes them start
   * faster. Defaults to one second at the source frame rate. Sources that
   * report none, such as MJPEG over HTTP, are measured over their first half
   * second to two seconds, which delays the first encoded packet by that much.
   */
  gopSize?: number;

  /**
   * Re-encode even when the track already matches.
   *
   * By default a track that already has the requested codec and size in a
   * widely playable 4:2:0 pixel format is copied unchanged, which costs nothing
   * and keeps its quality.
   *
   * @default false
   */
  force?: boolean;
}

/**
 * Which tracks are re-encoded, and on which hardware.
 *
 * Every track of a configured kind is decoded and encoded again, unless it
 * already matches the requested format and is copied instead. A function
 * decides per track, for example to re-encode only the first video track.
 *
 * @example
 * ```typescript
 * import type { TranscodeOptions } from '@seydx/rtsp';
 *
 * const options: TranscodeOptions = {
 *   video: { codec: 'h264', height: 720 },
 *   audio: (track) => (track.codec === 'pcm_mulaw' ? { codec: 'aac' } : undefined),
 * };
 * ```
 */
export interface TranscodeOptions {
  /**
   * Hardware used to decode, scale and encode video.
   *
   * `true` detects the best device and shares it with every other transcoder
   * of the process, `false` stays in software. `HardwareOptions` open a
   * dedicated device, and a `HardwareContext` from node-av is used as given and
   * stays owned by the caller. Every stage falls back to software on its own
   * when the device cannot handle it, for example a camera codec the GPU
   * cannot decode.
   *
   * @default true
   */
  hardware?: HardwareSetting;

  /**
   * Re-encode video tracks, or decide per track.
   *
   * A function receives each video track and returns its options, or
   * `undefined` to pass the track through.
   */
  video?: VideoTranscodeOptions | ((track: TrackInfo) => VideoTranscodeOptions | undefined);

  /**
   * Re-encode audio tracks, or decide per track.
   *
   * A function receives each audio track and returns its options, or
   * `undefined` to pass the track through.
   */
  audio?: AudioTranscodeOptions | ((track: TrackInfo) => AudioTranscodeOptions | undefined);
}

/**
 * A track that has to be re-encoded, with its resolved options.
 *
 * @internal
 */
export type TranscodePlan = { kind: 'video'; stream: Stream; options: VideoTranscodeOptions } | { kind: 'audio'; stream: Stream; options: AudioTranscodeOptions };

/**
 * Re-encodes the packets of one track.
 *
 * @internal
 */
export interface TrackTranscoder {
  /** The encoder that produced the last packets; stable once packets came out. */
  readonly encoder: Encoder;

  /**
   * Transcode one packet. The packet stays owned by the caller.
   *
   * @returns Encoded packets, owned by the caller
   */
  transcode(packet: Packet): Promise<Packet[]>;

  /**
   * Drain the codecs at the end of the stream.
   *
   * @returns The remaining encoded packets, owned by the caller
   */
  flush(): Promise<Packet[]>;

  /** Release all codec state. */
  close(): void;
}

// pixel formats browsers and hardware decoders reliably play
const H264_FORMATS = new Set<AVPixelFormat>([AV_PIX_FMT_YUV420P, AV_PIX_FMT_YUVJ420P, AV_PIX_FMT_NV12]);
const HEVC_FORMATS = new Set<AVPixelFormat>([...H264_FORMATS, AV_PIX_FMT_YUV420P10LE, AV_PIX_FMT_P010LE]);

/**
 * Decide whether a track is re-encoded.
 *
 * @param track - The track
 *
 * @param options - Transcode configuration
 *
 * @returns The plan, or `undefined` when the track is passed through
 *
 * @internal
 */
export function planTranscode(track: TrackInfo, options: TranscodeOptions): TranscodePlan | undefined {
  const stream = track.native;
  if (!stream) return undefined;
  if (track.kind === 'video') {
    const video = typeof options.video === 'function' ? options.video(track) : options.video;
    return video && (video.force || !videoMatches(stream, video)) ? { kind: 'video', stream, options: video } : undefined;
  }
  if (track.kind === 'audio') {
    const audio = typeof options.audio === 'function' ? options.audio(track) : options.audio;
    return audio && (audio.force || !audioMatches(stream, audio)) ? { kind: 'audio', stream, options: audio } : undefined;
  }
  return undefined;
}

/**
 * Whether a video stream already has the requested format.
 *
 * @param stream - The source stream
 *
 * @param options - The requested format
 *
 * @returns `true` if the stream can be copied
 *
 * @internal
 */
export function videoMatches(stream: Stream, options: VideoTranscodeOptions): boolean {
  const { codecId, width, height, format } = stream.codecpar;
  const hevc = options.codec === 'hevc';
  if (codecId !== (hevc ? AV_CODEC_ID_HEVC : AV_CODEC_ID_H264)) return false;
  if (options.width || options.height) {
    if (width <= 0 || height <= 0) return false;
    const size = outputSize(width, height, options);
    if (size.width !== width || size.height !== height) return false;
  }
  // an unprobed stream has no format yet, its codec has to do
  return format === AV_PIX_FMT_NONE || (hevc ? HEVC_FORMATS : H264_FORMATS).has(format as AVPixelFormat);
}

/**
 * Whether an audio stream already has the requested format.
 *
 * @param stream - The source stream
 *
 * @param options - The requested format
 *
 * @returns `true` if the stream can be copied
 *
 * @internal
 */
export function audioMatches(stream: Stream, options: AudioTranscodeOptions): boolean {
  const { codecId, sampleRate, channelLayout, profile } = stream.codecpar;
  const encoder = Codec.findEncoderByName((options.codec ?? 'aac') as FFEncoderCodec);
  if (encoder?.id !== codecId) return false;
  if (options.sampleRate !== undefined && options.sampleRate !== sampleRate) return false;
  if (options.channels !== undefined && options.channels !== channelLayout.nbChannels) return false;
  // low delay aac shares the codec id, yet hardly any player decodes it
  return codecId !== AV_CODEC_ID_AAC || (profile !== AV_PROFILE_AAC_LD && profile !== AV_PROFILE_AAC_ELD);
}

/**
 * Create the transcoder for a planned track.
 *
 * @param plan - The track and its options
 *
 * @param hardware - Device for video, if any
 *
 * @param logger - Logger for encoder selection and fallback
 *
 * @returns The transcoder
 *
 * @throws {Error} If the requested encoder is not available or the decoder cannot be opened
 *
 * @internal
 */
export function createTrackTranscoder(plan: TranscodePlan, hardware: HardwareContext | undefined, logger?: Logger): TrackTranscoder {
  return plan.kind === 'video' ? new VideoTranscoder(plan.stream, plan.options, hardware, logger) : new AudioTranscoder(plan.stream, plan.options);
}

/**
 * Audio track transcoding on the calling thread.
 *
 * @internal
 */
class AudioTranscoder implements TrackTranscoder {
  private readonly pipeline: AudioPipeline;

  constructor(stream: Stream, options: AudioTranscodeOptions) {
    this.pipeline = AudioPipeline.fromStream(
      stream,
      { codec: options.codec ?? 'aac', sampleRate: options.sampleRate, channels: options.channels, bitRate: options.bitRate },
      true,
    );
  }

  get encoder(): Encoder {
    return this.pipeline.encoder;
  }

  transcode(packet: Packet): Promise<Packet[]> {
    return Promise.resolve(this.pipeline.transcode(packet));
  }

  flush(): Promise<Packet[]> {
    return Promise.resolve(this.pipeline.flush());
  }

  close(): void {
    this.pipeline.close();
  }
}
