import { Decoder, Encoder, Muxer } from 'node-av/api';
import { AVMEDIA_TYPE_AUDIO } from 'node-av/constants';
import { avChannelLayoutDefault, Codec, FormatContext, Packet, Rational } from 'node-av/lib';

import type { AVCodecID, FFDecoderCodec, FFEncoderCodec } from 'node-av/constants';
import type { Frame, Stream } from 'node-av/lib';

/**
 * Compressed audio fed into an {@link AudioPipeline} that has no demuxer stream.
 *
 * @internal
 */
export interface AudioPipelineSource {
  /** Decoder name, for example `pcm_alaw`, `opus` or `libfdk_aac`. */
  decoder: string;
  sampleRate: number;
  channels: number;
  /** Units of the packet timestamps per second, defaults to `sampleRate`. */
  clockRate?: number;
  /** Codec configuration, for example the AAC AudioSpecificConfig. */
  extradata?: Buffer;
}

/**
 * Output of an {@link AudioPipeline}.
 *
 * @internal
 */
export interface AudioPipelineTarget {
  /** Encoder name or codec id. */
  codec: string | AVCodecID;
  sampleRate?: number;
  channels?: number;
  bitRate?: number;
}

/**
 * Synchronous decode and re-encode chain for one audio stream.
 *
 * The decoder resamples to the target rate and layout, the encoder converts the
 * sample format and frames the samples for its codec. Everything runs on the
 * calling thread, which costs well under a millisecond per audio frame and
 * avoids a thread pool hop per packet.
 *
 * @internal
 */
export class AudioPipeline {
  private readonly input = new Packet();

  /**
   * @param timeBase - Time base of the packets fed in
   *
   * @param decoder - The configured decoder
   *
   * @param encoder - The configured encoder
   *
   * @param context - Format context that owns a synthetic input stream
   *
   * @internal
   */
  private constructor(
    readonly timeBase: Rational,
    private readonly decoder: Decoder,
    readonly encoder: Encoder,
    private readonly context?: FormatContext,
  ) {
    this.input.alloc();
  }

  /**
   * Build a pipeline that decodes packets of a demuxed stream.
   *
   * @param stream - The demuxer stream the packets come from
   *
   * @param target - Encoder settings; rate and channels default to the source
   *
   * @param realtime - Turn input gaps into timestamp jumps instead of filling them with silence
   *
   * @returns The pipeline
   *
   * @throws {Error} If the encoder is not available or the decoder cannot be opened
   *
   * @internal
   */
  static fromStream(stream: Stream, target: AudioPipelineTarget, realtime: boolean): AudioPipeline {
    const encoderCodec = findEncoder(target.codec);
    const sampleRate = target.sampleRate ?? stream.codecpar.sampleRate;
    const channels = target.channels ?? (stream.codecpar.channelLayout.nbChannels || 1);
    const decoder = Decoder.createSync(stream, { exitOnError: false, resample: { sampleRate, channelLayout: avChannelLayoutDefault(channels) } });
    return new AudioPipeline(stream.timeBase, decoder, createEncoder(encoderCodec, decoder, target, realtime));
  }

  /**
   * Build a pipeline for compressed frames that do not come from a demuxer.
   *
   * @param source - Codec and format of the incoming frames
   *
   * @param target - Encoder settings; rate and channels default to the source
   *
   * @param realtime - Turn input gaps into timestamp jumps instead of filling them with silence
   *
   * @returns The pipeline
   *
   * @throws {Error} If a codec is not available or the decoder cannot be opened
   *
   * @internal
   */
  static fromDescription(source: AudioPipelineSource, target: AudioPipelineTarget, realtime: boolean): AudioPipeline {
    const decoderCodec = Codec.findDecoderByName(source.decoder as FFDecoderCodec);
    if (!decoderCodec) throw new Error(`Unsupported audio decoder: ${source.decoder}`);
    const encoderCodec = findEncoder(target.codec);

    // a decoder needs a stream to copy its parameters from, so build one without a demuxer
    const context = new FormatContext();
    context.allocContext();
    try {
      const stream = context.newStream(null);
      const timeBase = new Rational(1, source.clockRate ?? source.sampleRate);
      stream.timeBase = timeBase;
      stream.codecpar.codecType = AVMEDIA_TYPE_AUDIO;
      stream.codecpar.codecId = decoderCodec.id;
      stream.codecpar.sampleRate = source.sampleRate;
      stream.codecpar.channelLayout = avChannelLayoutDefault(source.channels);
      if (source.extradata) stream.codecpar.extradata = source.extradata;

      const sampleRate = target.sampleRate ?? source.sampleRate;
      const channels = target.channels ?? source.channels;
      const decoder = Decoder.createSync(stream, decoderCodec, {
        exitOnError: false,
        resample: { sampleRate, channelLayout: avChannelLayoutDefault(channels) },
      });
      return new AudioPipeline(timeBase, decoder, createEncoder(encoderCodec, decoder, target, realtime), context);
    } catch (error) {
      context.freeContext();
      throw error;
    }
  }

  /**
   * Transcode one compressed packet.
   *
   * The packet stays owned by the caller. Undecodable input yields nothing.
   *
   * @param packet - Packet in {@link AudioPipeline.timeBase}
   *
   * @returns Encoded packets, owned by the caller; empty while the encoder buffers
   *
   * @throws {Error} If encoding fails
   *
   * @internal
   */
  transcode(packet: Packet): Packet[] {
    return this.encode(this.decoder.decodeAllSync(packet), false);
  }

  /**
   * Drain the decoder and encoder at the end of the stream.
   *
   * @returns The remaining encoded packets, owned by the caller
   *
   * @throws {Error} If encoding fails
   *
   * @internal
   */
  flush(): Packet[] {
    return this.encode(this.decoder.decodeAllSync(null), true);
  }

  /**
   * Transcode one compressed frame given as raw bytes.
   *
   * @param data - The compressed frame
   *
   * @param pts - Timestamp in {@link AudioPipeline.timeBase}
   *
   * @returns Encoded packets, owned by the caller
   *
   * @throws {Error} If encoding fails
   *
   * @internal
   */
  transcodeData(data: Buffer, pts: bigint): Packet[] {
    const input = this.input;
    input.data = data;
    input.pts = pts;
    input.dts = pts;
    input.timeBase = this.timeBase;
    try {
      return this.transcode(input);
    } finally {
      input.unref();
    }
  }

  /**
   * Release the codecs and the synthetic stream.
   *
   * @internal
   */
  close(): void {
    this.decoder.close();
    this.encoder.close();
    this.input.free();
    this.context?.freeContext();
  }

  /**
   * Encode decoded frames and free them.
   *
   * @param frames - Frames owned by this call
   *
   * @param final - Also drain the encoder
   *
   * @returns Encoded packets, owned by the caller
   *
   * @throws {Error} If encoding fails; frames and packets are freed anyway
   *
   * @internal
   */
  private encode(frames: Frame[], final: boolean): Packet[] {
    const encoded: Packet[] = [];
    try {
      for (const frame of frames) encoded.push(...this.encoder.encodeAllSync(frame));
      if (final) encoded.push(...this.encoder.encodeAllSync(null));
    } catch (error) {
      for (const out of encoded) out.free();
      throw error;
    } finally {
      for (const frame of frames) frame.free();
    }
    return encoded;
  }
}

/**
 * Muxer that turns encoded packets into bytes on the calling thread.
 *
 * @internal
 */
export class ByteOutput {
  private readonly muxer: Muxer;
  private readonly index: number;

  /**
   * @param encoder - Encoder whose packets are muxed
   *
   * @param format - Output format, for example `rtp` or `adts`
   *
   * @param write - Receives every chunk the muxer produces
   *
   * @param options - RTP payload type and maximum packet size
   *
   * @param options.payloadType - RTP payload type to stamp, for `rtp` only
   *
   * @param options.maxPacketSize - Upper bound of one output packet in bytes
   *
   * @throws {Error} If the muxer cannot be opened
   *
   * @internal
   */
  constructor(encoder: Encoder, format: string, write: (chunk: Buffer) => void, options: { payloadType?: number; maxPacketSize?: number } = {}) {
    // sync mode calls write on this thread with a fresh buffer per chunk
    this.muxer = Muxer.openSync(
      { write },
      {
        format,
        maxPacketSize: options.maxPacketSize ?? 1200,
        useSyncQueue: false,
        options: format === 'rtp' && options.payloadType !== undefined ? { payload_type: options.payloadType } : undefined,
      },
    );
    this.index = this.muxer.addStream(encoder);
  }

  /**
   * Mux and free encoded packets.
   *
   * @param packets - Packets from the encoder; ownership is consumed
   *
   * @throws {Error} If muxing fails; the remaining packets are freed anyway
   *
   * @internal
   */
  write(packets: Packet[]): void {
    try {
      for (const packet of packets) this.muxer.writePacketSync(packet, this.index);
    } finally {
      for (const packet of packets) packet.free();
    }
  }

  /**
   * Close the muxer.
   *
   * @internal
   */
  close(): void {
    this.muxer.closeSync();
  }
}

/**
 * Look up an encoder by name or codec id.
 *
 * @param codec - Encoder name or codec id
 *
 * @returns The encoder
 *
 * @throws {Error} If no such encoder exists
 *
 * @internal
 */
function findEncoder(codec: string | AVCodecID): Codec {
  const found = typeof codec === 'string' ? Codec.findEncoderByName(codec as FFEncoderCodec) : Codec.findEncoder(codec);
  if (!found) throw new Error(`Unsupported audio encoder: ${String(codec)}`);
  return found;
}

/**
 * Create the encoder of a pipeline.
 *
 * @param codec - The encoder codec
 *
 * @param decoder - Decoder that feeds it
 *
 * @param target - Bit rate setting
 *
 * @param realtime - Turn input gaps into timestamp jumps
 *
 * @returns The encoder, initialized lazily from the first frame
 *
 * @internal
 */
function createEncoder(codec: Codec, decoder: Decoder, target: AudioPipelineTarget, realtime: boolean): Encoder {
  return Encoder.createSync(codec, {
    decoder,
    autoResample: true,
    audioFrameBuffer: realtime ? { maxGapFill: 0 } : {},
    ...(target.bitRate ? { bitrate: target.bitRate } : {}),
  });
}
