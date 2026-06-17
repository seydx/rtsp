import getPort from 'get-port';
import { AV_SAMPLE_FMT_S16, avGetSampleFmtFromName, Codec, Decoder, Demuxer, Encoder, FilterAPI, FilterPreset, Muxer, StreamingUtils } from 'node-av';

import type { RTPDemuxer } from 'node-av';
import type { Logger } from '../../types.js';

/**
 * Inbound talkback RTP format produced by connected viewers.
 *
 * Describes the codec and RTP parameters that the RTSP server advertises to
 * talkback-capable clients and therefore expects to receive on the way back in.
 * These values seed the synthetic input SDP that drives the decode side of the
 * transcoder pipeline.
 */
export interface BackchannelInput {
  /**
   * Lower-case decoder codec name as understood by FFmpeg.
   *
   * Examples include `opus`, `pcm_mulaw`, or `pcm_alaw`. The name is resolved to
   * a concrete decoder when the transcoder starts; an unknown name aborts startup.
   */
  codec: string;

  /**
   * RTP payload type number advertised for the inbound stream.
   *
   * Must match the payload type the viewer uses when sending talkback packets so
   * the demuxer can associate them with the configured decoder.
   */
  payloadType: number;

  /**
   * RTP clock rate (timestamp ticks per second) of the inbound audio.
   *
   * Typically 8000 for narrowband G.711 or 48000 for Opus. Used to interpret RTP
   * timestamps on the received packets.
   */
  clockRate: number;

  /**
   * Number of audio channels in the inbound stream (1 for mono, 2 for stereo).
   */
  channels: number;

  /**
   * Optional SDP `fmtp` line for the inbound codec.
   *
   * Carries codec-specific format parameters (for example Opus or AAC config) and
   * is appended verbatim to the generated input SDP when present.
   */
  fmtp?: string;
}

/**
 * Target audio format the talkback stream is transcoded into.
 *
 * Describes the encoder and output container the inbound viewer audio is
 * converted to before being handed to the upstream camera. Choosing `rtp` for
 * the format yields ready-to-send RTP packets, while a container format yields
 * raw bytes suitable for other transports.
 */
export interface BackchannelTarget {
  /**
   * node-av `AVCodecID` of the encoder to produce.
   *
   * Identifies the codec the upstream camera expects on its backchannel; resolved
   * to a concrete encoder at startup, with an unknown id aborting startup.
   */
  codecId: number;

  /**
   * Output sample rate in hertz the audio is resampled and encoded at.
   *
   * Should match what the target codec and upstream camera expect (for example
   * 8000 for G.711).
   */
  sampleRate: number;

  /**
   * Number of output audio channels (1 for mono, 2 for stereo).
   *
   * Drives both the resample channel layout and the encoder configuration.
   */
  channels: number;

  /**
   * Output muxer format name.
   *
   * Defaults to `rtp`, which emits RTP packets ready to forward to the upstream
   * camera's `sendRTSPPacket`. A container format such as `adts` instead emits
   * raw bytes (for example for a Node writable or proprietary talkback stream).
   */
  format?: string;

  /**
   * RTP maximum packet size (MTU) in bytes.
   *
   * Only consulted when `format` is `rtp`; bounds the size of emitted RTP
   * packets. Defaults to 1200 bytes when omitted.
   */
  maxPacketSize?: number;
}

/**
 * Configuration for a {@link BackchannelTranscoder}.
 *
 * Pairs the inbound viewer format with the desired upstream target format and
 * supplies the callback that receives the produced output. The optional sample
 * format and logger tune the resample stage and surface pipeline errors.
 */
export interface BackchannelTranscoderOptions {
  /**
   * Format received from viewers on the talkback channel.
   *
   * Determines the decoder and input SDP used at the start of the pipeline.
   */
  from: BackchannelInput;

  /**
   * Target format the talkback audio is converted into.
   *
   * Determines the encoder, resample target, and output muxer format.
   */
  to: BackchannelTarget;

  /**
   * Callback invoked with each chunk of produced output.
   *
   * Receives RTP packets when the target format is `rtp`, or container bytes for
   * non-rtp formats. The buffer is owned by the callee and may be retained.
   */
  output: (data: Buffer) => void;

  /**
   * Intermediate sample format name for the resample stage.
   *
   * Resolved via FFmpeg's sample-format names (for example `s16`, `fltp`).
   * Defaults to signed 16-bit (`AV_SAMPLE_FMT_S16`) when omitted.
   */
  sampleFormat?: string;

  /**
   * Optional logger used to report transcode pipeline failures.
   *
   * Only the `error` method is used, and only for failures that occur while the
   * transcoder is active.
   */
  logger?: Logger;
}

/**
 * Transcodes inbound viewer talkback audio into the upstream camera's codec.
 *
 * Bridges the format advertised to RTSP clients and the format an upstream camera
 * expects on its ONVIF backchannel by running an in-process audio pipeline that
 * decodes, resamples, re-encodes, and muxes the received audio. The result is
 * delivered through a caller-supplied callback as either RTP packets or raw
 * container bytes, depending on the chosen target format.
 *
 * @example
 * ```typescript
 * import { BackchannelTranscoder } from '@seydx/rtsp';
 *
 * const transcoder = new BackchannelTranscoder({
 *   from: { codec: 'opus', payloadType: 97, clockRate: 48000, channels: 1 },
 *   to: { codecId: cameraCodecId, sampleRate: 8000, channels: 1 },
 *   output: (rtp) => camera.sendBackchannel(rtp),
 * });
 *
 * await transcoder.start();
 * transcoder.push(viewerRtpPacket);
 * await transcoder.close();
 * ```
 *
 * @see {@link RtspServerSink} For the sink that drives talkback delivery
 */
export class BackchannelTranscoder {
  private rtpInput?: RTPDemuxer;
  private decoder?: Decoder;
  private filter?: FilterAPI;
  private encoder?: Encoder;
  private output?: Muxer;
  private streamIndex?: number;
  private active = false;

  /**
   * Create a backchannel transcoder.
   *
   * The transcoder is inert until {@link BackchannelTranscoder.start} is called;
   * the constructor only captures configuration.
   *
   * @param options - Inbound/target formats, output callback, and tuning
   */
  constructor(private readonly options: BackchannelTranscoderOptions) {}

  /**
   * Start the transcode pipeline.
   *
   * Resolves the decoder and encoder, builds a synthetic input SDP for the
   * inbound viewer format, and wires up the decode, resample, encode, and mux
   * stages. Once started, inbound packets fed via {@link BackchannelTranscoder.push}
   * flow through the pipeline and produced output is delivered to the configured
   * callback. Calling start when already active is a no-op.
   *
   * @returns Resolves once the pipeline is running
   *
   * @throws {Error} If the inbound decoder or target encoder cannot be resolved,
   * or the generated SDP contains no audio stream
   *
   * @example
   * ```typescript
   * await transcoder.start();
   * ```
   */
  async start(): Promise<void> {
    if (this.active) return;
    const { from, to } = this.options;

    const decoderCodec = Codec.findDecoderByName(from.codec as never);
    if (!decoderCodec) throw new Error(`Unsupported talkback decoder: ${from.codec}`);

    const encoderCodec = Codec.findEncoder(to.codecId as never);
    if (!encoderCodec) throw new Error(`Unsupported talkback target codec id: ${to.codecId}`);

    // A free local port is required to form a valid input SDP, even though no
    // socket is actually bound — packets are fed in directly via push().
    const port = await getPort({ host: '127.0.0.1' });
    const sdp = StreamingUtils.createInputSDP([
      { port, codecId: decoderCodec.id, payloadType: from.payloadType, clockRate: from.clockRate, channels: from.channels, fmtp: from.fmtp },
    ]);

    this.rtpInput = await Demuxer.openSDP(sdp);
    const audio = this.rtpInput.input.audio();
    if (!audio) throw new Error('No audio stream in talkback SDP');

    this.decoder = await Decoder.create(audio, { exitOnError: false });

    const layout = to.channels === 1 ? 'mono' : 'stereo';
    const sampleFormat = this.options.sampleFormat ? avGetSampleFmtFromName(this.options.sampleFormat) : AV_SAMPLE_FMT_S16;
    const chain = FilterPreset.chain();
    chain.aformat(sampleFormat, to.sampleRate, layout);
    this.filter = FilterAPI.create(chain.build());

    this.encoder = await Encoder.create(encoderCodec, {
      decoder: this.decoder,
      filter: this.filter,
      options: { sample_rate: to.sampleRate, channels: to.channels },
    });

    this.output = await Muxer.open(
      {
        write: (buffer: Buffer) => {
          this.options.output(Buffer.from(buffer));
          return buffer.length;
        },
      },
      { input: this.rtpInput, format: to.format ?? 'rtp', maxPacketSize: to.maxPacketSize ?? 1200 } as never,
    );
    this.streamIndex = this.output.addStream(this.encoder);
    this.active = true;

    // Drive the pipeline in the background; it runs until close() flips active off.
    this.process();
  }

  /**
   * Feed one inbound RTP packet from a viewer into the pipeline.
   *
   * Packets are queued into the synthetic input demuxer and consumed by the
   * background transcode loop. Calling push before {@link BackchannelTranscoder.start}
   * (or after {@link BackchannelTranscoder.close}) is a silent no-op.
   *
   * @param rtp - A single inbound RTP packet in the advertised viewer codec
   *
   * @example
   * ```typescript
   * transcoder.push(viewerRtpPacket);
   * ```
   */
  push(rtp: Buffer): void {
    this.rtpInput?.sendPacket(rtp);
  }

  /**
   * Stop the transcoder and release all pipeline resources.
   *
   * Marks the transcoder inactive, ending the background loop, then closes the
   * input demuxer, decoder, filter, encoder, and output muxer. Safe to call when
   * the transcoder was never started or is already closed.
   *
   * @returns Resolves once all resources are released
   *
   * @example
   * ```typescript
   * await transcoder.close();
   * ```
   */
  async close(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await this.rtpInput?.close();
    this.decoder?.close();
    this.filter?.close();
    this.encoder?.close();
    await this.output?.close();
  }

  /**
   * Run the decode/resample/encode/mux loop until the transcoder is closed.
   *
   * Pulls inbound packets through the chained node-av stages and writes each
   * encoded packet to the output muxer. Pipeline errors are reported through the
   * configured logger, but only while the transcoder is still active so that
   * teardown does not surface spurious failures.
   *
   * @returns Resolves when the loop ends (on close or after an error)
   *
   * @internal
   */
  private async process(): Promise<void> {
    if (!this.rtpInput || !this.decoder || !this.filter || !this.encoder || !this.output || this.streamIndex === undefined) return;
    const packets = this.encoder.packets(this.filter.frames(this.decoder.frames(this.rtpInput.input.packets())));
    try {
      for await (using encoded of packets) {
        if (!this.active) break;
        await this.output.writePacket(encoded, this.streamIndex);
      }
    } catch (error) {
      // Suppress errors raised by closing the pipeline mid-flight; only real
      // runtime failures (still active) are worth reporting.
      if (this.active) this.options.logger?.error?.('[rtsp] backchannel transcode failed:', error);
    }
  }
}
