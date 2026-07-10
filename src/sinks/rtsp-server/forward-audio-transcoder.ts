import { AV_SAMPLE_FMT_S16, Codec, Decoder, Encoder, FilterAPI, FilterPreset } from 'node-av';

import type { FFEncoderCodec, Muxer, Packet, Stream } from 'node-av';
import type { Logger } from '../../types.js';

/**
 * Target format an incoming audio track is normalized into.
 *
 * Describes the encoder the audio is re-encoded to when a consumer opts into
 * forward audio transcoding. Only {@link codec} is required; the remaining
 * fields default to the decoded source's own values so a plain "clean up this
 * codec" request preserves the original sample rate and channel count.
 *
 * @see {@link ForwardAudioTranscoder} For the pipeline that consumes this
 */
export interface AudioTranscodeTarget {
  /**
   * Encoder codec name as understood by FFmpeg (for example `aac`).
   *
   * Resolved to a concrete encoder when the transcoder starts; an unknown name
   * aborts startup.
   */
  codec: string;

  /**
   * Output sample rate in hertz.
   *
   * When omitted the decoded source's sample rate is preserved.
   */
  sampleRate?: number;

  /**
   * Number of output audio channels (1 for mono, 2 for stereo).
   *
   * When omitted the decoded source's channel count is preserved.
   */
  channels?: number;

  /**
   * Target encoder bitrate in bits per second.
   *
   * When omitted the encoder picks its own default.
   */
  bitRate?: number;
}

/**
 * Decodes and re-encodes a single elementary audio track into a clean stream.
 *
 * Some upstreams deliver elementary audio (for example raw ADTS AAC) whose
 * header layout a passthrough bitstream filter cannot adapt — the filter aborts
 * and, with it, the whole delivery channel. This transcoder sidesteps that by
 * running an in-process decode → resample → re-encode pipeline: the re-encoded
 * packets carry standards-compliant parameters (extradata, ASC, ...) that the
 * RTP muxer accepts unconditionally.
 *
 * It is push-based to match a sink that receives one packet at a time: each fed
 * packet is decoded, filtered, and re-encoded, and the resulting packets are
 * written to the caller-owned muxer stream created by {@link start}. This
 * mirrors the send/receive discipline of a bitstream filter, so it slots into
 * the same per-packet write path.
 *
 * @see {@link BackchannelTranscoder} For the reverse (viewer → camera) pipeline
 */
export class ForwardAudioTranscoder {
  private decoder?: Decoder;
  private filter?: FilterAPI;
  private encoder?: Encoder;
  private streamIndex = -1;

  /**
   * Create a forward audio transcoder.
   *
   * The transcoder is inert until {@link ForwardAudioTranscoder.start} is called;
   * the constructor only captures configuration.
   *
   * @param target - Encoder target the audio is normalized into.
   *
   * @param logger - Optional logger used to report the resolved pipeline.
   */
  constructor(
    private readonly target: AudioTranscodeTarget,
    private readonly logger?: Logger,
  ) {}

  /**
   * Start the decode/re-encode pipeline and register the output stream.
   *
   * Resolves the target encoder, builds the decode → resample → encode chain from
   * the source stream, and adds the encoder as a stream on the caller-owned
   * muxer. The returned index must be used when writing packets back to that
   * muxer.
   *
   * @param source - Source-native stream handle whose packets will be fed in.
   *
   * @param muxer - The caller-owned muxer the re-encoded packets are written to.
   *
   * @returns The muxer stream index the encoded packets belong to.
   *
   * @throws {Error} If the target encoder cannot be resolved.
   *
   * @example
   * ```typescript
   * const index = await transcoder.start(track.native, muxer);
   * ```
   */
  async start(source: Stream, muxer: Muxer): Promise<number> {
    // `codec` is a plain runtime string (consumer config), cast to node-av's
    // branded codec-name type at the lookup boundary.
    const encoderCodec = Codec.findEncoderByName(this.target.codec as FFEncoderCodec);
    if (!encoderCodec) throw new Error(`Unsupported audio transcode target codec: ${this.target.codec}`);

    this.decoder = await Decoder.create(source, { exitOnError: false });

    const sampleRate = this.target.sampleRate ?? source.codecpar.sampleRate;
    const channels = this.target.channels ?? source.codecpar.channelLayout.nbChannels ?? 1;
    const layout = channels === 1 ? 'mono' : 'stereo';

    const chain = FilterPreset.chain();
    chain.aformat(AV_SAMPLE_FMT_S16, sampleRate, layout);
    this.filter = FilterAPI.create(chain.build());

    this.encoder = await Encoder.create(encoderCodec, {
      decoder: this.decoder,
      filter: this.filter,
      autoResample: true,
      ...(this.target.bitRate ? { bitrate: this.target.bitRate } : {}),
      options: { sample_rate: sampleRate, channels },
    });

    this.streamIndex = muxer.addStream(this.encoder);
    this.logger?.debug?.(`[rtsp] transcoding audio to ${this.target.codec} @ ${sampleRate}Hz x${channels}`);
    return this.streamIndex;
  }

  /**
   * Feed one source packet through the pipeline and mux the encoded result.
   *
   * Decodes the packet, runs the decoded frames through the resample filter, and
   * re-encodes them, writing every produced packet to the muxer stream created by
   * {@link start}. A single input packet may yield zero, one, or several output
   * packets. Every intermediate frame/packet is freed before returning.
   *
   * Decode, filter, and encode failures are contained: the offending packet or
   * frame is dropped with a warning and the pipeline keeps running — this
   * transcoder exists to survive unreliable upstream audio, so one corrupt
   * packet must not tear down the whole delivery channel. Muxer write failures
   * still propagate, since a broken output is not recoverable per packet.
   *
   * @param packet - The source-native packet to transcode.
   *
   * @param muxer - The muxer whose stream the encoded packets are written to.
   *
   * @returns The number of encoded packets written to the muxer this call. Zero
   * while the encoder is still buffering (no muxer header emitted yet), which the
   * caller uses to defer SDP generation until the stream's parameters are known.
   *
   * @throws {Error} If writing an encoded packet to the muxer fails.
   *
   * @example
   * ```typescript
   * const written = await transcoder.write(packet.av, muxer);
   * ```
   */
  async write(packet: Packet, muxer: Muxer): Promise<number> {
    if (!this.decoder || !this.filter || !this.encoder) return 0;

    let frames;
    try {
      frames = await this.decoder.decodeAll(packet);
    } catch (error) {
      this.logger?.warn?.('[rtsp] audio transcode: dropping undecodable packet:', error);
      return 0;
    }

    let written = 0;
    for (const frame of frames) {
      // Collected encoded packets are owned here until written; anything left
      // over after a failure is freed below so nothing native leaks.
      const encodedPackets: Packet[] = [];
      try {
        try {
          const filtered = await this.filter.processAll(frame);
          try {
            for (const f of filtered) encodedPackets.push(...(await this.encoder.encodeAll(f)));
          } finally {
            for (const f of filtered) f.free();
          }
        } catch (error) {
          this.logger?.warn?.('[rtsp] audio transcode: dropping frame after filter/encode failure:', error);
          continue;
        }

        while (encodedPackets.length > 0) {
          await muxer.writePacket(encodedPackets[0], this.streamIndex);
          encodedPackets.shift()!.free();
          written++;
        }
      } finally {
        frame.free();
        for (const encoded of encodedPackets) encoded.free();
      }
    }
    return written;
  }

  /**
   * Release the decoder, filter, and encoder.
   *
   * Does not close the muxer — that stream is owned by the caller. Safe to call
   * when the transcoder was never started or is already closed.
   *
   * @example
   * ```typescript
   * await transcoder.close();
   * ```
   */
  async close(): Promise<void> {
    this.decoder?.close();
    this.filter?.close();
    this.encoder?.close();
    this.decoder = undefined;
    this.filter = undefined;
    this.encoder = undefined;
  }
}
