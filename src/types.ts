import type { AVCodecID } from 'node-av/constants';
import type { IRational, Packet, Stream } from 'node-av/lib';

/**
 * Console-like logger accepted throughout the library.
 *
 * Every method is optional, so `console`, a subset of it or an adapter for an
 * existing logging framework all work. Omit it to stay silent.
 *
 * @example
 * ```typescript
 * import { Relay } from '@seydx/rtsp';
 *
 * const relay = new Relay({ source, logger: { warn: console.warn, error: console.error } });
 * ```
 */
export interface Logger {
  /**
   * Informational messages, such as the URL a server listens on.
   */
  log?: (...args: unknown[]) => void;

  /**
   * Recoverable problems, such as a sink falling behind or a reconnect.
   */
  warn?: (...args: unknown[]) => void;

  /**
   * Failures the library could not recover from on its own.
   */
  error?: (...args: unknown[]) => void;

  /**
   * Detailed diagnostics for troubleshooting.
   */
  debug?: (...args: unknown[]) => void;
}

/**
 * Category of a track.
 */
export type TrackKind = 'video' | 'audio' | 'data';

/**
 * One elementary stream of a source.
 *
 * Carries what the relay needs to route packets and what sinks need to
 * reproduce the stream. AV-backed sinks attach the native stream handle to
 * their muxers.
 *
 * @example
 * ```typescript
 * const info = await source.open();
 * for (const track of info.tracks) console.log(track.index, track.kind, track.codec);
 * ```
 *
 * @see {@link StreamInfo} For all tracks of a source
 */
export interface TrackInfo {
  /**
   * Track index, equal to {@link MediaPacket.streamIndex} of its packets.
   */
  index: number;

  /**
   * Whether the track carries video, audio or other data.
   */
  kind: TrackKind;

  /**
   * Lower-case FFmpeg codec name, for example `h264`, `hevc`, `aac` or `pcm_alaw`.
   */
  codec: string;

  /**
   * The node-av stream behind the track.
   *
   * Present for AV-backed sources. Sinks pass it to node-av muxers, decoders
   * and bitstream filters. It stays valid until the source closes, also across
   * reconnects and loops. The relay itself never touches it.
   */
  native?: Stream;

  /**
   * Unit of the packet timestamps in seconds (`num / den`).
   *
   * Present for AV-backed sources.
   */
  timeBase?: IRational;
}

/**
 * Codec and RTP parameters of a talkback audio stream.
 *
 * Describes what one end of a backchannel sends or expects, for example the
 * format an RTSP server advertises to its viewers.
 *
 * @example
 * ```typescript
 * import type { BackchannelFormat } from '@seydx/rtsp';
 *
 * const pcma: BackchannelFormat = { codec: 'pcm_alaw', payloadType: 8, clockRate: 8000, channels: 1 };
 * ```
 */
export interface BackchannelFormat {
  /**
   * Lower-case FFmpeg codec name, for example `pcm_mulaw`, `pcm_alaw`, `opus` or `aac`.
   */
  codec: string;

  /**
   * RTP payload type carried by the packets.
   */
  payloadType: number;

  /**
   * RTP clock rate in Hz, for example `8000` for G.711 or `48000` for Opus.
   */
  clockRate: number;

  /**
   * Channel count, usually `1` for talkback.
   */
  channels: number;

  /**
   * SDP `a=fmtp` parameters without the payload type.
   *
   * Required for AAC (`mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=...`),
   * whose `config` carries the decoder configuration.
   */
  fmtp?: string;
}

/**
 * Talkback format of an upstream camera (ONVIF backchannel).
 *
 * Present when the upstream accepts audio, for example an RTSP camera with a
 * send-only stream. Audio sent upstream must match this format.
 *
 * @example
 * ```typescript
 * if (supportsBackchannel(source) && source.backchannel) {
 *   const { codec, clockRate } = source.backchannel;
 *   console.log(`camera expects ${codec} at ${clockRate} Hz`);
 * }
 * ```
 *
 * @see {@link BackchannelSource} For the source capability
 */
export interface BackchannelInfo extends BackchannelFormat {
  /**
   * Upstream stream index the talkback packets are sent on.
   */
  streamIndex: number;

  /**
   * node-av codec id of the talkback codec, if known.
   */
  codecId?: AVCodecID;
}

/**
 * A source that can send talkback audio upstream.
 *
 * Implemented by sources whose upstream has a backchannel, such as an RTSP
 * camera with an ONVIF backchannel. {@link RtspServerSink} forwards viewer
 * audio through it. Use {@link supportsBackchannel} to detect it.
 *
 * @example
 * ```typescript
 * import { supportsBackchannel } from '@seydx/rtsp';
 *
 * if (supportsBackchannel(source)) source.sendBackchannel(rtpPacket);
 * ```
 *
 * @see {@link supportsBackchannel} For the type guard
 *
 * @see {@link BackchannelInfo} For the talkback format
 */
export interface BackchannelSource {
  /**
   * Talkback format of the upstream, once it is open and advertises one.
   */
  readonly backchannel?: BackchannelInfo;

  /**
   * Send one RTP packet upstream.
   *
   * The packet must already match {@link BackchannelSource.backchannel}; it is
   * forwarded unchanged.
   *
   * @param rtp - One RTP packet in the talkback codec
   *
   * @example
   * ```typescript
   * source.sendBackchannel(rtpPacket);
   * ```
   */
  sendBackchannel(rtp: Buffer): void;
}

/**
 * Whether a source can send talkback audio upstream.
 *
 * @param source - The source to test
 *
 * @returns `true` if the source implements {@link BackchannelSource}
 *
 * @example
 * ```typescript
 * import { supportsBackchannel } from '@seydx/rtsp';
 *
 * if (supportsBackchannel(source)) source.sendBackchannel(rtpPacket);
 * ```
 *
 * @see {@link BackchannelSource} For the capability
 */
export function supportsBackchannel(source: Source): source is Source & BackchannelSource {
  return typeof (source as Partial<BackchannelSource>).sendBackchannel === 'function';
}

/**
 * Everything a source carries, resolved by {@link Source.open}.
 *
 * Every sink receives it in `init()` before its first packet.
 *
 * @example
 * ```typescript
 * const info = await source.open();
 * console.log(`${info.tracks.length} tracks, talkback: ${info.backchannel !== undefined}`);
 * ```
 *
 * @see {@link TrackInfo} For one track
 */
export interface StreamInfo {
  /**
   * The tracks of the source in index order.
   */
  tracks: TrackInfo[];

  /**
   * Talkback format of the upstream, if it accepts audio.
   */
  backchannel?: BackchannelInfo;
}

/**
 * One packet flowing through the relay.
 *
 * The relay reads {@link MediaPacket.streamIndex} and
 * {@link MediaPacket.isKeyframe} to route and gate packets; sinks that need
 * the payload use the node-av packet in {@link MediaPacket.av}. A packet has
 * exactly one owner. `clone()` creates another owned reference to the same
 * payload, `free()` releases the owner's reference.
 *
 * @example
 * ```typescript
 * const copy = packet.clone();
 * consume(copy);
 * copy.free();
 * ```
 *
 * @see {@link Sink} For the consumer contract
 */
export interface MediaPacket {
  /**
   * Index of the track the packet belongs to.
   */
  readonly streamIndex: number;

  /**
   * Whether the packet starts a decodable picture.
   *
   * New sinks start at a video keyframe, so they never begin mid-GOP.
   */
  readonly isKeyframe: boolean;

  /**
   * Presentation timestamp in the track time base, if known.
   */
  readonly pts?: number;

  /**
   * Decode timestamp in the track time base, if known.
   */
  readonly dts?: number;

  /**
   * The node-av packet with the payload, present for AV-backed sources.
   */
  readonly av?: Packet;

  /**
   * Create another owned reference to this packet.
   *
   * Native payloads are shared by reference count, so a clone is cheap. Every
   * clone must be freed on its own.
   *
   * @returns The new packet
   *
   * @example
   * ```typescript
   * const copy = packet.clone();
   * ```
   */
  clone(): MediaPacket;

  /**
   * Release this reference.
   *
   * @example
   * ```typescript
   * packet.free();
   * ```
   */
  free(): void;
}

/**
 * An upstream that produces media over one connection.
 *
 * `open()` connects and resolves the stream layout, `packets()` yields packets
 * until the signal aborts or the stream ends, and `close()` disconnects. A
 * {@link Relay} drives exactly one source and calls `close()` after every
 * running cycle, including after an aborted or failed `open()`.
 *
 * @example
 * ```typescript
 * const info = await source.open();
 * const controller = new AbortController();
 * for await (const packet of source.packets(controller.signal)) {
 *   handle(packet);
 *   packet.free();
 * }
 * await source.close();
 * ```
 *
 * @see {@link Sink} For the consuming side
 *
 * @see {@link Relay} For fanning a source out
 */
export interface Source {
  /**
   * Connect and resolve the stream layout.
   *
   * @returns The tracks and the optional talkback format
   *
   * @example
   * ```typescript
   * const info = await source.open();
   * ```
   */
  open(): Promise<StreamInfo>;

  /**
   * Yield packets until the signal aborts or the stream ends.
   *
   * The caller owns every yielded packet. Throwing ends the stream with an
   * error.
   *
   * @param signal - Stops the iteration when it aborts
   *
   * @returns The packets of the open connection
   *
   * @example
   * ```typescript
   * for await (const packet of source.packets(controller.signal)) handle(packet);
   * ```
   */
  packets(signal: AbortSignal): AsyncIterable<MediaPacket>;

  /**
   * Disconnect and release all resources.
   *
   * Must also abort a pending `open()` and be safe to call more than once.
   *
   * @returns A promise that resolves once the connection is closed
   *
   * @example
   * ```typescript
   * await source.close();
   * ```
   */
  close(): Promise<void>;
}

/**
 * A consumer of the relayed stream.
 *
 * The relay calls `init()` once with the stream layout, then `write()` for
 * every packet from the first video keyframe on, one at a time, and finally
 * `close()`. The relay frees each packet once `write()` resolved, so a sink
 * that keeps a packet longer must clone it.
 *
 * @example
 * ```typescript
 * import type { MediaPacket, Sink, StreamInfo } from '@seydx/rtsp';
 *
 * const sink: Sink = {
 *   init(info: StreamInfo) { setup(info); },
 *   write(packet: MediaPacket) { forward(packet); },
 *   close() { teardown(); },
 * };
 * ```
 *
 * @see {@link Source} For the producing side
 *
 * @see {@link Relay.pipe} For attaching a sink
 */
export interface Sink {
  /**
   * Prepare for the given stream layout.
   *
   * Throwing detaches the sink; the relay and the other sinks keep running.
   *
   * @param info - The stream layout
   *
   * @returns Nothing, or a promise that resolves once the sink is ready
   *
   * @example
   * ```typescript
   * await sink.init(info);
   * ```
   */
  init(info: StreamInfo): Promise<void> | void;

  /**
   * Consume one packet.
   *
   * Throwing detaches the sink.
   *
   * @param packet - The packet, owned by the relay until the call resolves
   *
   * @returns Nothing, or a promise that resolves once the packet is consumed
   *
   * @example
   * ```typescript
   * await sink.write(packet);
   * ```
   */
  write(packet: MediaPacket): Promise<void> | void;

  /**
   * Release everything acquired in `init()`.
   *
   * @returns Nothing, or a promise that resolves once the sink is closed
   *
   * @example
   * ```typescript
   * await sink.close();
   * ```
   */
  close(): Promise<void> | void;
}
