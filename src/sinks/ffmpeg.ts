import { Muxer } from 'node-av/api';

import type { IOOutputCallbacks } from 'node-av/api';
import type { Writable } from 'node:stream';
import type { Logger, MediaPacket, Sink, StreamInfo } from '../types.js';

/**
 * Destination of an {@link FfmpegSink}: a file path or URL, a writable stream or custom write callbacks.
 */
export type FfmpegOutput = string | Writable | IOOutputCallbacks;

/**
 * Options for an {@link FfmpegSink}.
 */
export interface FfmpegSinkOptions {
  /**
   * Where the muxed output goes.
   */
  output: FfmpegOutput;

  /**
   * Output container, for example `mp4`, `matroska` or `mpegts`.
   *
   * Required for streams and callbacks; for paths libav can infer it from the extension.
   */
  format?: string;

  /**
   * Extra libav muxer options, for example `{ movflags: 'frag_keyframe+empty_moov' }`.
   */
  options?: Record<string, string | number>;

  /**
   * Logger for close failures.
   */
  logger?: Logger;
}

/**
 * Sink that remuxes the relayed stream into any container libav can write.
 *
 * Packets are copied without re-encoding, so recording or restreaming costs
 * almost no CPU. The output opens when the sink is attached and is finalized
 * when it is detached or the relay stops.
 *
 * @example
 * ```typescript
 * import { FfmpegSink } from '@seydx/rtsp';
 *
 * const recorder = relay.pipe(new FfmpegSink({ output: '/recordings/clip.mkv', format: 'matroska' }));
 * setTimeout(() => relay.unpipe(recorder), 30_000);
 * ```
 *
 * @example
 * ```typescript
 * import { FfmpegSink } from '@seydx/rtsp';
 *
 * // fragmented MP4 into an HTTP response
 * relay.pipe(new FfmpegSink({ output: response, format: 'mp4', options: { movflags: 'frag_keyframe+empty_moov+default_base_moof' } }));
 * ```
 *
 * @see {@link Sink} For the sink contract
 *
 * @see {@link Relay.pipe} For attaching it
 */
export class FfmpegSink implements Sink {
  private readonly indexes = new Map<number, number>();
  private muxer?: Muxer;

  /**
   * Create a remuxing sink. Nothing opens until it is attached.
   *
   * @param options - Output, format and muxer options
   *
   * @example
   * ```typescript
   * const sink = new FfmpegSink({ output: 'out.ts', format: 'mpegts' });
   * ```
   */
  constructor(private readonly options: FfmpegSinkOptions) {}

  /**
   * Open the output and add every track with a native stream.
   *
   * @param info - The stream layout
   *
   * @returns A promise that resolves once the output is open
   *
   * @throws {Error} If the output cannot be opened or a track cannot be added
   *
   * @example
   * ```typescript
   * await sink.init(info);
   * ```
   */
  async init(info: StreamInfo): Promise<void> {
    const muxer = await Muxer.open(this.options.output as string, {
      format: this.options.format,
      options: this.options.options as never,
    });
    this.muxer = muxer;
    for (const track of info.tracks) {
      if (track.native) this.indexes.set(track.index, muxer.addStream(track.native));
    }
  }

  /**
   * Write one packet to the output.
   *
   * @param packet - The packet, owned by the relay
   *
   * @returns A promise that resolves once the packet is written
   *
   * @throws {Error} If writing fails
   *
   * @example
   * ```typescript
   * await sink.write(packet);
   * ```
   */
  async write(packet: MediaPacket): Promise<void> {
    const index = this.indexes.get(packet.streamIndex);
    if (index === undefined || !this.muxer || !packet.av) return;
    await this.muxer.writePacket(packet.av, index);
  }

  /**
   * Finalize and close the output.
   *
   * @returns A promise that resolves once the output is closed
   *
   * @example
   * ```typescript
   * await sink.close();
   * ```
   */
  async close(): Promise<void> {
    const muxer = this.muxer;
    this.muxer = undefined;
    this.indexes.clear();
    try {
      await muxer?.close();
    } catch (error) {
      this.options.logger?.error?.('[rtsp] FfmpegSink close failed:', error);
    }
  }
}
