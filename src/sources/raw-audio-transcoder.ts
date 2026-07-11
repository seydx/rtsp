import getPort from 'get-port';
import { PassThrough } from 'node:stream';
import { AV_SAMPLE_FMT_S16, avGetSampleFmtFromName, Codec, Decoder, Demuxer, Encoder, FilterAPI, FilterPreset, Muxer } from 'node-av';

import type { FFDecoderCodec, FFEncoderCodec, RTPDemuxer } from 'node-av';
import type { Readable } from 'node:stream';
import type { Logger } from '../types.js';

/**
 * Standard MPEG-4 sampling frequency index table (ISO/IEC 14496-3).
 *
 * @internal
 */
const SAMPLING_FREQUENCIES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Description of the raw framed audio pushed into a {@link RawAudioTranscoder}.
 *
 * Each frame handed to `push()` must be exactly one coded audio frame in this
 * format — raw elementary frames carry no sync or length information of their
 * own, so the framing (one buffer per frame) is what makes them decodable.
 */
export interface RawAudioInput {
  /**
   * Lower-case FFmpeg codec name of the incoming frames (for example `aac`,
   * `pcm_mulaw`).
   *
   * Determines the RTP payload mapping used internally and, unless
   * {@link RawAudioInput.decoder} overrides it, the decoder that consumes the
   * frames.
   */
  codec: string;

  /**
   * Explicit decoder implementation to use instead of the codec's default.
   *
   * FFmpeg's built-in decoder is not always able to handle every profile of a
   * codec: raw AAC-ELD, for example, decodes only with `libfdk_aac`. When
   * omitted, the default decoder for {@link RawAudioInput.codec} is used.
   */
  decoder?: string;

  /**
   * Sample rate of the incoming audio in hertz (for example `16000`).
   */
  sampleRate: number;

  /**
   * Number of audio channels in the incoming frames (1 for mono, 2 for stereo).
   */
  channels: number;

  /**
   * Number of PCM samples each pushed frame decodes to (for example `480` for
   * AAC-ELD with the 480-sample frame length, `1024` for AAC-LC).
   *
   * Drives the synthesized timestamps, so a wrong value plays the audio too
   * fast or too slow rather than failing outright.
   */
  samplesPerFrame: number;

  /**
   * Hex-encoded codec configuration announced to the decoder (for AAC this is
   * the AudioSpecificConfig, for example from {@link buildAacEldConfig}).
   *
   * Raw elementary frames carry no codec parameters in-band, so most formats —
   * and every AAC object type — need this for the decoder to interpret the
   * frames at all. May be omitted for self-describing codecs such as G.711.
   */
  config?: string;
}

/**
 * Target format a {@link RawAudioTranscoder} produces.
 *
 * Defaults are chosen so the output can be handed straight to an
 * {@link AvSource}/`MultiSource` input with `format: 'aac'`: AAC-LC in an ADTS
 * elementary stream.
 */
export interface RawAudioTarget {
  /**
   * Encoder codec name as understood by FFmpeg.
   *
   * @default 'aac'
   */
  codec?: string;

  /**
   * Output sample rate in hertz. Defaults to the input sample rate.
   */
  sampleRate?: number;

  /**
   * Number of output channels. Defaults to the input channel count.
   */
  channels?: number;

  /**
   * Target encoder bitrate in bits per second.
   *
   * When omitted the encoder picks its own default.
   */
  bitRate?: number;

  /**
   * Output muxer format name.
   *
   * The default `adts` yields a self-describing AAC elementary stream that
   * downstream demuxers probe without any side information.
   *
   * @default 'adts'
   */
  format?: string;
}

/**
 * Configuration for a {@link RawAudioTranscoder}.
 */
export interface RawAudioTranscoderOptions {
  /**
   * Format of the raw frames pushed into the transcoder.
   */
  from: RawAudioInput;

  /**
   * Format the frames are transcoded into. When omitted entirely, the input is
   * normalized to AAC-LC/ADTS at its own sample rate and channel count.
   */
  to?: RawAudioTarget;

  /**
   * Callback invoked when the running pipeline fails.
   *
   * Fired for runtime failures while the transcoder is active (never for
   * teardown-induced errors). The pipeline is dead at that point — the owner
   * should close this instance and create a fresh one if needed.
   */
  onError?: (error: unknown) => void;

  /**
   * Intermediate sample format name for the resample stage (for example `s16`,
   * `fltp`). Defaults to signed 16-bit.
   */
  sampleFormat?: string;

  /**
   * Optional logger used to report pipeline failures.
   */
  logger?: Logger;
}

/**
 * Build the AudioSpecificConfig for raw AAC-ELD, hex-encoded.
 *
 * AAC-ELD (Enhanced Low Delay, audio object type 39) cannot be carried in ADTS
 * — the ADTS header has only a 2-bit profile field — so cameras that speak it
 * (for example Eufy's P2P livestream audio) deliver bare frames that are
 * undecodable without this out-of-band configuration. The returned hex string
 * plugs directly into {@link RawAudioInput.config}.
 *
 * @param sampleRate - Sample rate in hertz; must be a standard MPEG-4 rate (e.g. 16000).
 *
 * @param channels - Channel count (1–7) written as the channel configuration.
 *
 * @param frameLength - Samples per ELD frame; `480` or `512`.
 *
 * @returns The hex-encoded AudioSpecificConfig (for example `f8f03000` for 16 kHz mono, 480-sample frames).
 *
 * @throws {Error} If the sample rate is not a standard MPEG-4 rate or the frame length is invalid.
 *
 * @example
 * ```typescript
 * import { buildAacEldConfig } from '@seydx/rtsp';
 *
 * const config = buildAacEldConfig(16000, 1, 480); // 'f8f03000'
 * ```
 */
export function buildAacEldConfig(sampleRate: number, channels: number, frameLength: 480 | 512): string {
  const freqIndex = SAMPLING_FREQUENCIES.indexOf(sampleRate);
  if (freqIndex < 0) throw new Error(`Unsupported AAC sample rate: ${sampleRate}`);
  if (frameLength !== 480 && frameLength !== 512) throw new Error(`Invalid ELD frame length: ${frameLength}`);

  // Bit layout (ISO/IEC 14496-3): AOT escape (5+6 bits, object type 39),
  // samplingFrequencyIndex (4), channelConfiguration (4), then the
  // ELDSpecificConfig: frameLengthFlag (1, set => 480 samples), three
  // resilience flags (3), ldSbrPresentFlag (1), eldExtType terminator (4).
  let bits = 0n;
  let count = 0;
  const write = (value: number, width: number): void => {
    bits = (bits << BigInt(width)) | BigInt(value & ((1 << width) - 1));
    count += width;
  };
  write(31, 5);
  write(39 - 32, 6);
  write(freqIndex, 4);
  write(channels, 4);
  write(frameLength === 480 ? 1 : 0, 1);
  write(0, 3);
  write(0, 1);
  write(0, 4);
  const pad = (8 - (count % 8)) % 8;
  if (pad > 0) write(0, pad);

  return bits.toString(16).padStart((count + pad) / 8 || 1, '0');
}

/**
 * Map a lower-case codec name to its SDP rtpmap encoding name.
 *
 * @param codec - Lower-case FFmpeg codec name.
 *
 * @returns The encoding name expected in an SDP rtpmap line.
 *
 * @internal
 */
function rtpmapName(codec: string): string {
  switch (codec) {
    case 'pcm_mulaw':
      return 'PCMU';
    case 'pcm_alaw':
      return 'PCMA';
    case 'opus':
      return 'opus';
    case 'aac':
      return 'MPEG4-GENERIC';
    default:
      return codec.toUpperCase();
  }
}

/**
 * Normalizes raw framed elementary audio into a demuxable stream.
 *
 * Some devices deliver audio as bare coded frames with no container at all —
 * the canonical case is Eufy's P2P livestream, whose AAC-ELD frames cannot be
 * expressed in ADTS and therefore break every ADTS-based consumer. This class
 * accepts those frames one `push()` at a time, decodes them (optionally with an
 * explicit decoder such as `libfdk_aac`), re-encodes to a standards-compliant
 * target (AAC-LC in ADTS by default), and exposes the result as a Readable that
 * plugs directly into an `AvSource` or `MultiSource` input.
 *
 * @example
 * ```typescript
 * import { buildAacEldConfig, MultiSource, RawAudioTranscoder } from '@seydx/rtsp';
 *
 * // Eufy AAC-ELD: 16 kHz mono, 480-sample frames, decodable only via libfdk.
 * const audio = new RawAudioTranscoder({
 *   from: { codec: 'aac', decoder: 'libfdk_aac', sampleRate: 16000, channels: 1, samplesPerFrame: 480, config: buildAacEldConfig(16000, 1, 480) },
 *   to: { bitRate: 32000 },
 * });
 * await audio.start();
 * eufyAudioStream.on('data', (frame) => audio.push(frame));
 *
 * const source = new MultiSource([
 *   { input: eufyVideoStream, format: 'h264' },
 *   { input: audio.stream, format: 'aac' },
 * ]);
 * ```
 *
 * @see {@link MultiSource} For combining the normalized audio with other inputs
 *
 * @see {@link buildAacEldConfig} For the AAC-ELD codec configuration
 */
export class RawAudioTranscoder {
  private readonly out = new PassThrough();

  private input?: RTPDemuxer;
  private decoder?: Decoder;
  private filter?: FilterAPI;
  private encoder?: Encoder;
  private output?: Muxer;
  private streamIndex?: number;
  private active = false;
  private sequence = 0;
  private timestamp = 0;

  /** Resolves when the background process() loop has fully unwound; awaited by close(). */
  private processing?: Promise<void>;

  /**
   * Create a raw audio transcoder.
   *
   * The transcoder is inert until {@link RawAudioTranscoder.start} is called;
   * the constructor only captures configuration.
   *
   * @param options - Input format, target format, and tuning.
   */
  constructor(private readonly options: RawAudioTranscoderOptions) {}

  /**
   * The transcoded output as a readable byte stream.
   *
   * Emits the target container bytes (ADTS by default) as they are produced.
   * Hand this to an `AvSource`/`MultiSource` input; it ends when the transcoder
   * is closed.
   *
   * @example
   * ```typescript
   * const inputs = [{ input: transcoder.stream, format: 'aac' }];
   * ```
   */
  get stream(): Readable {
    return this.out;
  }

  /**
   * Start the transcode pipeline.
   *
   * Resolves the decoder and encoder, announces the input format to the
   * demuxer via a synthetic SDP (including the codec `config` when given), and
   * wires up the decode, resample, encode, and mux stages. Calling start when
   * already active is a no-op.
   *
   * @returns Resolves once the pipeline is running.
   *
   * @throws {Error} If the input decoder or target encoder cannot be resolved,
   * or the synthetic SDP contains no audio stream.
   *
   * @example
   * ```typescript
   * await transcoder.start();
   * ```
   */
  async start(): Promise<void> {
    if (this.active) return;
    const { from } = this.options;
    const to = this.options.to ?? {};

    // `codec` fields are plain runtime strings, cast to node-av's branded
    // codec-name types at the lookup boundary.
    const decoderCodec = Codec.findDecoderByName((from.decoder ?? from.codec) as FFDecoderCodec);
    if (!decoderCodec) throw new Error(`Unsupported raw audio decoder: ${from.decoder ?? from.codec}`);
    const encoderCodec = Codec.findEncoderByName((to.codec ?? 'aac') as FFEncoderCodec);
    if (!encoderCodec) throw new Error(`Unsupported raw audio target codec: ${to.codec ?? 'aac'}`);

    try {
      // A free local port makes the SDP well-formed, though no socket is ever
      // bound — frames are fed in directly via push(). The SDP is hand-rolled
      // because libav's own SDP writer refuses AAC without global headers,
      // while the whole point here is carrying that config in the fmtp line.
      const port = await getPort({ host: '127.0.0.1' });
      const payloadType = 96;
      const fmtpParams =
        from.codec === 'aac'
          ? `profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3${from.config ? `;config=${from.config}` : ''}`
          : from.config
            ? `config=${from.config}`
            : undefined;
      const sdp = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=RawAudio',
        'c=IN IP4 127.0.0.1',
        't=0 0',
        `m=audio ${port} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} ${rtpmapName(from.codec)}/${from.sampleRate}/${from.channels}`,
        ...(fmtpParams ? [`a=fmtp:${payloadType} ${fmtpParams}`] : []),
        '',
      ].join('\n');

      this.input = await Demuxer.openSDP(sdp);
      const audio = this.input.input.audio();
      if (!audio) throw new Error('No audio stream in raw audio SDP');

      this.decoder = await Decoder.create(audio, decoderCodec, { exitOnError: false });

      const sampleRate = to.sampleRate ?? from.sampleRate;
      const channels = to.channels ?? from.channels;
      const layout = channels === 1 ? 'mono' : 'stereo';
      const sampleFormat = this.options.sampleFormat ? avGetSampleFmtFromName(this.options.sampleFormat) : AV_SAMPLE_FMT_S16;
      const chain = FilterPreset.chain();
      chain.aformat(sampleFormat, sampleRate, layout);
      this.filter = FilterAPI.create(chain.build());

      this.encoder = await Encoder.create(encoderCodec, {
        decoder: this.decoder,
        filter: this.filter,
        autoResample: true,
        ...(to.bitRate ? { bitrate: to.bitRate } : {}),
        options: { sample_rate: sampleRate, channels },
      });

      this.output = await Muxer.open(
        {
          write: (buffer: Buffer) => {
            this.out.write(Buffer.from(buffer));
            return buffer.length;
          },
        },
        { input: this.input, format: to.format ?? 'adts' } as never,
      );
      this.streamIndex = this.output.addStream(this.encoder);
    } catch (error) {
      // A partially built pipeline must not leak its native stages when a later
      // stage fails to come up.
      await this.release();
      throw error;
    }
    this.active = true;

    // Drive the pipeline in the background; it runs until close() tears it down.
    this.processing = this.process();
  }

  /**
   * Feed one complete coded audio frame into the pipeline.
   *
   * The buffer must contain exactly one frame in the configured input format;
   * partial or concatenated frames are undecodable for raw elementary codecs.
   * Calling push before {@link RawAudioTranscoder.start} (or after
   * {@link RawAudioTranscoder.close}) is a silent no-op.
   *
   * @param frame - One coded audio frame.
   *
   * @example
   * ```typescript
   * audioSource.on('data', (frame) => transcoder.push(frame));
   * ```
   */
  push(frame: Buffer): void {
    if (!this.active || !this.input) return;
    this.input.sendPacket(this.wrapRtp(frame));
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + this.options.from.samplesPerFrame) >>> 0;
  }

  /**
   * Stop the transcoder and release all pipeline resources.
   *
   * Interrupts the blocked demuxer read so the background loop can unwind,
   * waits for it, then closes every stage and ends the output stream. Safe to
   * call when the transcoder was never started or is already closed.
   *
   * @returns Resolves once all resources are released.
   *
   * @example
   * ```typescript
   * await transcoder.close();
   * ```
   */
  async close(): Promise<void> {
    this.active = false;
    // Unblock a read parked on the empty RTP queue and signal EOF so the
    // process() loop drains and exits before anything is freed underneath it.
    this.input?.input.interrupt();
    await this.processing;
    this.processing = undefined;
    await this.release();
    this.out.end();
  }

  /**
   * Wrap one raw frame as a minimal RTP packet for the SDP demuxer.
   *
   * AAC uses the RFC 3640 AAC-hbr payload (16-bit AU-headers-length plus one
   * 13-bit-size AU header); other codecs carry the frame as the bare payload.
   *
   * @param frame - The coded frame to wrap.
   *
   * @returns The RTP packet bytes.
   *
   * @internal
   */
  private wrapRtp(frame: Buffer): Buffer {
    const isAac = this.options.from.codec === 'aac';
    const header = Buffer.alloc(isAac ? 16 : 12);
    header[0] = 0x80; // V=2
    header[1] = 0x80 | 96; // marker + payload type
    header.writeUInt16BE(this.sequence, 2);
    header.writeUInt32BE(this.timestamp, 4);
    header.writeUInt32BE(0x52415741, 8); // arbitrary constant ssrc ('RAWA')
    if (isAac) {
      header.writeUInt16BE(16, 12); // AU-headers-length in bits
      header.writeUInt16BE((frame.length << 3) & 0xffff, 14); // 13-bit size + 3-bit index
    }
    return Buffer.concat([header, frame]);
  }

  /**
   * Close and drop every pipeline stage that has been created so far.
   *
   * Must only run when no read/process loop is using the stages — callers
   * either never started the loop (failed start) or awaited its completion.
   *
   * @returns Resolves once all stages are released.
   *
   * @internal
   */
  private async release(): Promise<void> {
    await this.input?.close();
    this.decoder?.close();
    this.filter?.close();
    this.encoder?.close();
    await this.output?.close();
    this.input = undefined;
    this.decoder = undefined;
    this.filter = undefined;
    this.encoder = undefined;
    this.output = undefined;
    this.streamIndex = undefined;
  }

  /**
   * Run the decode/resample/encode/mux loop until the transcoder is closed.
   *
   * Pulls pushed frames through the chained node-av stages and writes each
   * encoded packet to the output muxer. Pipeline errors are reported through
   * the configured logger and `onError` callback, but only while the transcoder
   * is still active so that teardown does not surface spurious failures.
   *
   * @returns Resolves when the loop ends (on close or after an error).
   *
   * @internal
   */
  private async process(): Promise<void> {
    if (!this.input || !this.decoder || !this.filter || !this.encoder || !this.output || this.streamIndex === undefined) return;
    const packets = this.encoder.packets(this.filter.frames(this.decoder.frames(this.input.input.packets())));
    try {
      for await (using encoded of packets) {
        if (!this.active) break;
        await this.output.writePacket(encoded, this.streamIndex);
      }
    } catch (error) {
      // Suppress errors raised by closing the pipeline mid-flight; only real
      // runtime failures (still active) are worth reporting. The pipeline is
      // dead after a failure — surface it so the owner can rebuild.
      if (this.active) {
        this.options.logger?.error?.('[rtsp] raw audio transcode failed:', error);
        this.options.onError?.(error);
      }
    }
  }
}
