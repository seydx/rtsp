import { Muxer } from 'node-av';

import type { Logger, MediaPacket, Sink, StreamInfo } from '../types.js';
import type { IOOutputCallbacks } from 'node-av';
import type { Writable } from 'node:stream';

/**
 * Output destination for an {@link FfmpegSink}.
 *
 * Resolves to whatever the underlying node-av muxer can write to: a filesystem
 * path or URL (string), a Node.js writable stream, or a set of low-level IO
 * callbacks for fully custom sinks.
 */
export type FfmpegOutput = string | Writable | IOOutputCallbacks;

/**
 * Options for creating an {@link FfmpegSink}.
 *
 * Configures where the remuxed stream is written and how the container is
 * formatted. Only `output` is required; the container format is inferred from a
 * path or URL when not given explicitly.
 */
export interface FfmpegSinkOptions {
  /**
   * The destination the remuxed stream is written to.
   *
   * Accepts a file path or URL (e.g. `out.mp4`, `rtmp://...`), a Node.js
   * writable stream, or a set of node-av IO callbacks for custom transports.
   */
  output: FfmpegOutput;

  /**
   * The container/muxer format to produce.
   *
   * Forwarded to node-av to select the output muxer (e.g. `mp4`, `flv`,
   * `mpegts`). When omitted, the format is inferred from the file extension or
   * URL scheme of `output`.
   */
  format?: string;

  /**
   * Extra format-specific muxer options.
   *
   * Key-value pairs passed straight through to the underlying libav muxer
   * (e.g. `{ movflags: 'frag_keyframe+empty_moov' }`). Values may be strings or
   * numbers; their meaning depends on the selected `format`.
   */
  options?: Record<string, string | number>;

  /**
   * Optional logger for diagnostics.
   *
   * Receives errors raised while tearing down the muxer. When omitted, such
   * errors are swallowed silently during {@link FfmpegSink.close}.
   */
  logger?: Logger;
}

/**
 * Mapping between a source track index and its muxer stream index.
 *
 * @internal
 */
interface MappedStream {
  muxIndex: number;
  sourceIndex: number;
}

/**
 * Sink that remuxes the relayed stream into another container.
 *
 * Pipes the relay's packets into a node-av muxer entirely in-process, with no
 * child process involved. Streams are copied rather than re-encoded, so the
 * operation stays cheap and lossless. Point it at a file, a streaming URL, or a
 * writable stream to record or republish the upstream media.
 *
 * @example
 * ```typescript
 * import { Relay, FfmpegSink } from '@seydx/rtsp';
 *
 * const sink = new FfmpegSink({ output: 'out.mp4' });
 * relay.pipe(sink);
 * ```
 *
 * @example
 * ```typescript
 * import { FfmpegSink } from '@seydx/rtsp';
 *
 * const sink = new FfmpegSink({
 *   output: 'rtmp://localhost/live/stream',
 *   format: 'flv',
 *   options: { flvflags: 'no_duration_filesize' },
 * });
 * ```
 *
 * @see {@link Relay} For wiring sinks to a source
 *
 * @see {@link Sink} For the sink contract this implements
 */
export class FfmpegSink implements Sink {
  private muxer?: Muxer;
  private readonly map = new Map<number, MappedStream>();

  /**
   * Create a new ffmpeg sink.
   *
   * @param options - Output destination and muxer configuration
   *
   * @example
   * ```typescript
   * const sink = new FfmpegSink({ output: 'out.mp4', format: 'mp4' });
   * ```
   */
  constructor(private readonly options: FfmpegSinkOptions) {}

  /**
   * Initialize the muxer and map the source tracks onto it.
   *
   * Opens the output destination, then registers each AV-backed track as a
   * muxer stream so packets can later be routed to the correct output index.
   * Tracks without a native handle are skipped, since they cannot be copied.
   *
   * @param info - Resolved description of the upstream tracks
   *
   * @returns Resolves once the muxer is open and all streams are mapped
   *
   * @throws {Error} If the output cannot be opened by node-av
   *
   * @example
   * ```typescript
   * await sink.init(streamInfo);
   * ```
   */
  async init(info: StreamInfo): Promise<void> {
    this.muxer = await Muxer.open(this.options.output as never, {
      format: this.options.format as never,
      options: this.options.options as never,
    });

    for (const track of info.tracks) {
      // Only AV-backed tracks carry a native stream that can be copied through.
      if (!track.native) continue;
      const muxIndex = this.muxer.addStream(track.native);
      this.map.set(track.index, { muxIndex, sourceIndex: track.index });
    }
  }

  /**
   * Write a single packet to the muxer.
   *
   * Routes the packet to its mapped output stream by index. Packets for unmapped
   * tracks, or packets without an underlying AV payload, are dropped silently.
   *
   * @param packet - The media packet to remux
   *
   * @returns Resolves once the packet has been handed to the muxer
   *
   * @example
   * ```typescript
   * await sink.write(packet);
   * ```
   */
  async write(packet: MediaPacket): Promise<void> {
    const mapped = this.map.get(packet.streamIndex);
    if (!mapped || !this.muxer || !packet.av) return;
    await this.muxer.writePacket(packet.av, mapped.muxIndex);
  }

  /**
   * Finalize and release the muxer.
   *
   * Flushes any buffered output, writes the container trailer, and frees the
   * stream mapping. Safe to call when the sink was never initialized. Errors
   * raised while closing are reported through the configured logger rather than
   * thrown, so teardown of other sinks is not interrupted.
   *
   * @returns Resolves once the muxer has been closed
   *
   * @example
   * ```typescript
   * await sink.close();
   * ```
   */
  async close(): Promise<void> {
    // Detach state before awaiting so a concurrent write cannot reuse a closing muxer.
    const muxer = this.muxer;
    this.muxer = undefined;
    this.map.clear();
    if (!muxer) return;
    try {
      await muxer.close();
    } catch (error) {
      this.options.logger?.error?.('[rtsp] FfmpegSink close failed:', error);
    }
  }
}
