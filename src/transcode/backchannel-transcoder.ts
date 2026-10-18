import { fmtpParam, isRtcp, parseRtp, RtpClock, splitAacAccessUnits } from '../util/rtp.js';
import { AudioPipeline, ByteOutput } from './audio-pipeline.js';

import type { AVCodecID } from 'node-av/constants';
import type { BackchannelFormat, Logger } from '../types.js';

/**
 * Incoming talkback RTP of a {@link BackchannelTranscoder}.
 */
export interface BackchannelInput extends BackchannelFormat {
  /**
   * Decoder implementation to use instead of the default for `codec`, for example `libfdk_aac`.
   */
  decoder?: string;
}

/**
 * Output of a {@link BackchannelTranscoder}.
 */
export interface BackchannelTarget {
  /**
   * Encoder name, for example `pcm_mulaw`, `aac` or `libopus`.
   *
   * Either this or {@link BackchannelTarget.codecId} is required.
   */
  codec?: string;

  /**
   * node-av codec id of the encoder, used when {@link BackchannelTarget.codec} is not set.
   */
  codecId?: AVCodecID;

  /**
   * Output sample rate in Hz.
   */
  sampleRate: number;

  /**
   * Output channel count.
   */
  channels: number;

  /**
   * Target bit rate in bits per second, defaults to the encoder's choice.
   */
  bitRate?: number;

  /**
   * Output container, for example `rtp` or `adts`.
   *
   * @default 'rtp'
   */
  format?: string;

  /**
   * RTP payload type to stamp, for `rtp` output.
   *
   * Defaults to the static type of the codec or `96`. Set it to the payload
   * type the receiver negotiated.
   */
  payloadType?: number;

  /**
   * Upper bound of one output packet in bytes.
   *
   * @default 1200
   */
  maxPacketSize?: number;
}

/**
 * Options for a {@link BackchannelTranscoder}.
 */
export interface BackchannelTranscoderOptions {
  /**
   * Format of the RTP packets passed to {@link BackchannelTranscoder.push}.
   */
  from: BackchannelInput;

  /**
   * Format to produce.
   */
  to: BackchannelTarget;

  /**
   * Receives every output chunk: one RTP packet for `rtp` output (RTCP is
   * dropped), otherwise the bytes the muxer wrote, for example one ADTS frame.
   *
   * @param chunk - The output bytes, owned by the callee
   */
  output: (chunk: Buffer) => void;

  /**
   * Called once when transcoding fails. The transcoder is closed afterwards and
   * can be started again.
   *
   * @param error - The failure
   */
  onError?: (error: unknown) => void;

  /**
   * Logger for transcoding failures.
   */
  logger?: Logger;
}

const AAC_FRAME_SAMPLES = 1024;

/**
 * Converts talkback RTP from one audio codec to another.
 *
 * A viewer may send audio in a different codec than the camera accepts, for
 * example PCMA from a browser while the camera expects AAC. The transcoder
 * depacketizes the RTP in process, decodes, resamples and encodes the audio,
 * and hands out RTP packets or another container such as ADTS. It runs on the
 * calling thread, which costs a fraction of a millisecond per packet.
 *
 * @example
 * ```typescript
 * import { BackchannelTranscoder } from '@seydx/rtsp';
 *
 * const transcoder = new BackchannelTranscoder({
 *   from: { codec: 'pcm_alaw', payloadType: 8, clockRate: 8000, channels: 1 },
 *   to: { codec: 'aac', sampleRate: 16000, channels: 1, format: 'adts' },
 *   output: (chunk) => speaker.write(chunk),
 * });
 * transcoder.start();
 * server.on('backchannel', (rtp) => transcoder.push(rtp));
 * ```
 *
 * @see {@link RtspServerSink} For receiving talkback from viewers
 *
 * @see {@link BackchannelSource} For sending it to a camera
 */
export class BackchannelTranscoder {
  private pipeline?: AudioPipeline;
  private output?: ByteOutput;
  private clock = new RtpClock();
  private readonly aac: boolean;
  private readonly rtpOutput: boolean;

  /**
   * Create a transcoder. Nothing is allocated until {@link BackchannelTranscoder.start}.
   *
   * @param options - Input and output formats and the output callback
   *
   * @example
   * ```typescript
   * const transcoder = new BackchannelTranscoder({ from, to, output: (chunk) => source.sendBackchannel(chunk) });
   * ```
   */
  constructor(private readonly options: BackchannelTranscoderOptions) {
    this.aac = options.from.codec === 'aac';
    this.rtpOutput = (options.to.format ?? 'rtp') === 'rtp';
  }

  /**
   * Whether the transcoder is started and has not failed.
   *
   * @example
   * ```typescript
   * if (!transcoder.active) transcoder.start();
   * ```
   */
  get active(): boolean {
    return this.pipeline !== undefined;
  }

  /**
   * Build the codec pipeline. Calling it while active does nothing.
   *
   * @throws {Error} If a codec is not available, AAC input lacks its `config` or the muxer cannot be opened
   *
   * @example
   * ```typescript
   * transcoder.start();
   * ```
   */
  start(): void {
    if (this.pipeline) return;
    const { from, to } = this.options;
    const codec = to.codec ?? to.codecId;
    if (codec === undefined) throw new Error('BackchannelTranscoder needs a target codec or codecId');

    const config = fmtpParam(from.fmtp, 'config');
    if (this.aac && !config) throw new Error('AAC talkback needs the config parameter in fmtp');

    const pipeline = AudioPipeline.fromDescription(
      { decoder: from.decoder ?? from.codec, sampleRate: from.clockRate, channels: from.channels, extradata: config ? Buffer.from(config, 'hex') : undefined },
      { codec, sampleRate: to.sampleRate, channels: to.channels, bitRate: to.bitRate },
      true,
    );
    try {
      this.output = new ByteOutput(pipeline.encoder, to.format ?? 'rtp', (chunk) => this.forward(chunk), {
        payloadType: to.payloadType,
        maxPacketSize: to.maxPacketSize,
      });
    } catch (error) {
      pipeline.close();
      throw error;
    }
    this.pipeline = pipeline;
    this.clock = new RtpClock();
  }

  /**
   * Transcode one incoming RTP packet.
   *
   * Packets that are not RTP or carry another payload type are ignored, and so
   * is everything before {@link BackchannelTranscoder.start}. A failure calls
   * {@link BackchannelTranscoderOptions.onError} and closes the transcoder.
   *
   * @param rtp - One RTP packet in the input format
   *
   * @example
   * ```typescript
   * server.on('backchannel', (rtp) => transcoder.push(rtp));
   * ```
   */
  push(rtp: Buffer): void {
    const pipeline = this.pipeline;
    const output = this.output;
    if (!pipeline || !output) return;
    const packet = parseRtp(rtp);
    if (packet?.payloadType !== this.options.from.payloadType || packet.payload.length === 0) return;

    const pts = this.clock.extend(packet.timestamp);
    try {
      if (this.aac) {
        const units = splitAacAccessUnits(packet.payload);
        for (let i = 0; i < units.length; i++) output.write(pipeline.transcodeData(units[i], pts + BigInt(i * AAC_FRAME_SAMPLES)));
      } else {
        output.write(pipeline.transcodeData(packet.payload, pts));
      }
    } catch (error) {
      this.options.logger?.error?.('[rtsp] backchannel transcoding failed:', error);
      this.close();
      this.options.onError?.(error);
    }
  }

  /**
   * Release the codecs. Safe to call more than once; {@link BackchannelTranscoder.start} works again afterwards.
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
      output?.close();
    } catch (error) {
      this.options.logger?.debug?.('[rtsp] backchannel muxer close failed:', error);
    }
    pipeline?.close();
  }

  /**
   * Hand one muxer chunk to the output callback, dropping RTCP for RTP output.
   *
   * @param chunk - The muxer output
   *
   * @internal
   */
  private forward(chunk: Buffer): void {
    // the muxer interleaves sender reports, the receiver only wants media
    if (this.rtpOutput && isRtcp(chunk)) return;
    this.options.output(chunk);
  }
}
