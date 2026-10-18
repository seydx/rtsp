import { PassThrough } from 'node:stream';

import { AudioPipeline, ByteOutput } from './audio-pipeline.js';

import type { Readable } from 'node:stream';
import type { Logger } from '../types.js';

/**
 * Raw compressed frames fed into a {@link RawAudioTranscoder}.
 */
export interface RawAudioInput {
  /**
   * Lower-case FFmpeg codec name of the frames, for example `aac` or `opus`.
   */
  codec: string;

  /**
   * Decoder implementation to use instead of the default for `codec`, for example `libfdk_aac` for AAC-ELD.
   */
  decoder?: string;

  /**
   * Sample rate of the frames in Hz.
   */
  sampleRate: number;

  /**
   * Channel count of the frames.
   */
  channels: number;

  /**
   * Samples per frame, used to timestamp consecutive frames.
   */
  samplesPerFrame: number;

  /**
   * Decoder configuration as a hex string, for example an AAC AudioSpecificConfig.
   *
   * @see {@link buildAacEldConfig} For AAC-ELD
   */
  config?: string;
}

/**
 * Output of a {@link RawAudioTranscoder}.
 */
export interface RawAudioTarget {
  /**
   * Encoder name.
   *
   * @default 'aac'
   */
  codec?: string;

  /**
   * Output sample rate in Hz, defaults to the input rate.
   */
  sampleRate?: number;

  /**
   * Output channel count, defaults to the input layout.
   */
  channels?: number;

  /**
   * Target bit rate in bits per second, defaults to the encoder's choice.
   */
  bitRate?: number;

  /**
   * Output container written to {@link RawAudioTranscoder.stream}.
   *
   * @default 'adts'
   */
  format?: string;
}

/**
 * Options for a {@link RawAudioTranscoder}.
 */
export interface RawAudioTranscoderOptions {
  /**
   * Format of the frames passed to {@link RawAudioTranscoder.push}.
   */
  from: RawAudioInput;

  /**
   * Format to produce.
   */
  to?: RawAudioTarget;

  /**
   * Called once when transcoding fails. The transcoder is closed afterwards.
   *
   * @param error - The failure
   */
  onError?: (error: unknown) => void;

  /**
   * Logger for transcoding failures.
   */
  logger?: Logger;
}

const SAMPLING_FREQUENCIES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Build the AudioSpecificConfig of an AAC-ELD stream as a hex string.
 *
 * Devices that send bare AAC-ELD frames do not transmit the configuration the
 * decoder needs, so it has to be built from the known stream parameters.
 *
 * @param sampleRate - Sample rate in Hz
 *
 * @param channels - Channel configuration, usually `1`
 *
 * @param frameLength - Samples per frame, `480` or `512`
 *
 * @returns The configuration for {@link RawAudioInput.config}
 *
 * @throws {Error} If the sample rate is not an AAC rate or the frame length is invalid
 *
 * @example
 * ```typescript
 * import { buildAacEldConfig } from '@seydx/rtsp';
 *
 * buildAacEldConfig(16000, 1, 480); // 'f8f03000'
 * ```
 */
export function buildAacEldConfig(sampleRate: number, channels: number, frameLength: 480 | 512): string {
  const frequencyIndex = SAMPLING_FREQUENCIES.indexOf(sampleRate);
  if (frequencyIndex < 0) throw new Error(`Unsupported AAC sample rate: ${sampleRate}`);
  if (frameLength !== 480 && frameLength !== 512) throw new Error(`Invalid ELD frame length: ${String(frameLength)}`);

  // ISO/IEC 14496-3: escaped object type 39, frequency index, channels, then the
  // ELDSpecificConfig with frameLengthFlag, three resilience flags, ldSbrPresentFlag and the terminator
  let bits = 0n;
  let count = 0;
  write(31, 5);
  write(39 - 32, 6);
  write(frequencyIndex, 4);
  write(channels, 4);
  write(frameLength === 480 ? 1 : 0, 1);
  write(0, 3);
  write(0, 1);
  write(0, 4);
  write(0, (8 - (count % 8)) % 8);
  return bits.toString(16).padStart(count / 4, '0');

  // eslint-disable-next-line jsdoc/require-jsdoc
  function write(value: number, width: number): void {
    bits = (bits << BigInt(width)) | BigInt(value & ((1 << width) - 1));
    count += width;
  }
}

/**
 * Converts raw compressed audio frames into a demuxable byte stream.
 *
 * Some devices deliver bare audio frames that no demuxer can probe, for example
 * AAC-ELD without any container. The transcoder decodes them, encodes them
 * again (AAC-LC in ADTS by default) and writes the result to a readable
 * stream, which can feed a {@link MultiSource} input. It runs on the calling
 * thread.
 *
 * @example
 * ```typescript
 * import { buildAacEldConfig, MultiSource, RawAudioTranscoder } from '@seydx/rtsp';
 *
 * const transcoder = new RawAudioTranscoder({
 *   from: { codec: 'aac', decoder: 'libfdk_aac', sampleRate: 16000, channels: 1, samplesPerFrame: 480, config: buildAacEldConfig(16000, 1, 480) },
 *   to: { bitRate: 32000 },
 * });
 * transcoder.start();
 * device.on('audio', (frame) => transcoder.push(frame));
 *
 * const source = new MultiSource([{ input: video, format: 'h264' }, { input: transcoder.stream, format: 'aac' }]);
 * ```
 *
 * @see {@link MultiSource} For merging the output with other inputs
 *
 * @see {@link buildAacEldConfig} For the AAC-ELD configuration
 */
export class RawAudioTranscoder {
  private readonly out = new PassThrough();
  private pipeline?: AudioPipeline;
  private output?: ByteOutput;
  private samples = 0n;
  private closed = false;

  /**
   * Create a transcoder. Nothing is allocated until {@link RawAudioTranscoder.start}.
   *
   * @param options - Input and output formats
   *
   * @example
   * ```typescript
   * const transcoder = new RawAudioTranscoder({ from: { codec: 'opus', sampleRate: 48000, channels: 1, samplesPerFrame: 960 } });
   * ```
   */
  constructor(private readonly options: RawAudioTranscoderOptions) {}

  /**
   * The transcoded byte stream. It ends when the transcoder closes.
   *
   * @example
   * ```typescript
   * transcoder.stream.pipe(file);
   * ```
   */
  get stream(): Readable {
    return this.out;
  }

  /**
   * Build the codec pipeline. Calling it while started does nothing.
   *
   * @throws {Error} If the transcoder was closed, a codec is not available or the muxer cannot be opened
   *
   * @example
   * ```typescript
   * transcoder.start();
   * ```
   */
  start(): void {
    if (this.pipeline) return;
    if (this.closed) throw new Error('RawAudioTranscoder is closed, its stream has ended');
    const { from } = this.options;
    const to = this.options.to ?? {};

    const pipeline = AudioPipeline.fromDescription(
      { decoder: from.decoder ?? from.codec, sampleRate: from.sampleRate, channels: from.channels, extradata: from.config ? Buffer.from(from.config, 'hex') : undefined },
      { codec: to.codec ?? 'aac', sampleRate: to.sampleRate, channels: to.channels, bitRate: to.bitRate },
      false,
    );
    try {
      this.output = new ByteOutput(pipeline.encoder, to.format ?? 'adts', (chunk) => this.out.write(chunk));
    } catch (error) {
      pipeline.close();
      throw error;
    }
    this.pipeline = pipeline;
  }

  /**
   * Transcode one raw frame.
   *
   * Ignored before {@link RawAudioTranscoder.start} and after closing. A
   * failure calls {@link RawAudioTranscoderOptions.onError} and closes the
   * transcoder.
   *
   * @param frame - One compressed frame without container
   *
   * @example
   * ```typescript
   * device.on('audio', (frame) => transcoder.push(frame));
   * ```
   */
  push(frame: Buffer): void {
    const pipeline = this.pipeline;
    const output = this.output;
    if (!pipeline || !output || frame.length === 0) return;
    const pts = this.samples;
    this.samples += BigInt(this.options.from.samplesPerFrame);
    try {
      output.write(pipeline.transcodeData(frame, pts));
    } catch (error) {
      this.options.logger?.error?.('[rtsp] raw audio transcoding failed:', error);
      this.close();
      this.options.onError?.(error);
    }
  }

  /**
   * Flush the remaining audio, release the codecs and end {@link RawAudioTranscoder.stream}. Safe to call more than once.
   *
   * @example
   * ```typescript
   * transcoder.close();
   * ```
   */
  close(): void {
    const pipeline = this.pipeline;
    const output = this.output;
    this.pipeline = undefined;
    this.output = undefined;
    try {
      // the encoder still holds the tail of the audio
      if (pipeline && output) output.write(pipeline.flush());
      output?.close();
    } catch (error) {
      this.options.logger?.debug?.('[rtsp] raw audio flush failed:', error);
    }
    pipeline?.close();
    if (!this.closed) {
      this.closed = true;
      this.out.end();
    }
  }
}
