/**
 * Minimal logger shape used throughout the relay.
 *
 * Every method is optional, so callers can pass a partial console-like object
 * (or omit it entirely) and the relay will only invoke the methods that are
 * present. This keeps integration with existing logging frameworks trivial:
 * pass `console` for everything, a subset for selective output, or nothing to
 * stay silent.
 *
 * @example
 * ```typescript
 * import { Relay } from '@seydx/rtsp';
 *
 * const logger = { warn: console.warn, error: console.error };
 * const relay = new Relay({ source, logger });
 * ```
 */
export interface Logger {
  /**
   * General-purpose informational logging.
   *
   * Receives an arbitrary list of arguments, mirroring `console.log`. Invoked
   * for routine, non-error events the relay wants to surface.
   */
  log?: (...args: unknown[]) => void;

  /**
   * Warning-level logging.
   *
   * Receives an arbitrary list of arguments, mirroring `console.warn`. Used for
   * recoverable conditions that may indicate a problem (e.g. a sink falling
   * behind or a retried connection).
   */
  warn?: (...args: unknown[]) => void;

  /**
   * Error-level logging.
   *
   * Receives an arbitrary list of arguments, mirroring `console.error`. Used for
   * failures the relay could not recover from on its own.
   */
  error?: (...args: unknown[]) => void;

  /**
   * Verbose diagnostic logging.
   *
   * Receives an arbitrary list of arguments, mirroring `console.debug`. Emits
   * fine-grained detail intended for troubleshooting; safe to leave unset in
   * production.
   */
  debug?: (...args: unknown[]) => void;
}

/**
 * The high-level category of an elementary stream.
 *
 * Distinguishes video, audio, and non-media data tracks so the relay and its
 * sinks can route or filter packets without inspecting codec specifics.
 */
export type TrackKind = 'video' | 'audio' | 'data';

/**
 * Metadata describing a single elementary stream of the upstream source.
 *
 * Each track corresponds to one demuxed stream (a video, audio, or data
 * channel) and carries just enough information for the relay to route packets
 * and for sinks to reproduce the stream. Codec specifics are kept opaque so the
 * relay core stays format-agnostic; AV-backed sinks read the native handle when
 * they need to attach the stream to a muxer.
 *
 * @example
 * ```typescript
 * import { Source, StreamInfo } from '@seydx/rtsp';
 *
 * const info: StreamInfo = await source.open();
 * for (const track of info.tracks) {
 *   console.log(track.index, track.kind, track.codec);
 * }
 * ```
 *
 * @see {@link StreamInfo} For the full set of tracks a source carries
 *
 * @see {@link MediaPacket} For the units of media that flow per track
 */
export interface TrackInfo {
  /**
   * Stream index as reported by the source.
   *
   * Matches {@link MediaPacket.streamIndex} for every packet belonging to this
   * track, allowing sinks to correlate packets with their describing track.
   */
  index: number;

  /**
   * High-level category of this track.
   *
   * One of `video`, `audio`, or `data`, letting consumers branch on stream type
   * without parsing the codec name.
   */
  kind: TrackKind;

  /**
   * Lower-case codec name of the track.
   *
   * Examples include `h264`, `hevc`, `aac`, `opus`, and `pcm_alaw`. Reported in
   * the canonical FFmpeg short-name form.
   */
  codec: string;

  /**
   * Source-native stream handle.
   *
   * For AV-backed sources this is the underlying node-av `Stream`, which
   * AV-backed sinks pass to `addStream()` when configuring a muxer. The value is
   * opaque to the relay core and absent for sources that are not AV-backed.
   */
  native?: unknown;

  /**
   * Stream time base as a `{ num, den }` rational.
   *
   * Present for AV-backed sources and describes the unit of the packet
   * timestamps in seconds (`num / den`). Used by sinks that need to rescale or
   * interpret PTS/DTS values.
   */
  timeBase?: { num: number; den: number };
}

/**
 * Describes the upstream's talkback (ONVIF backchannel) audio format.
 *
 * Present only when the upstream accepts audio sent back to it (for example an
 * RTSP camera that exposes an ONVIF backchannel). The codec and clock fields
 * describe exactly what the upstream expects to receive, so a sink can encode or
 * repackage viewer audio into a compatible stream before forwarding it.
 *
 * @example
 * ```typescript
 * import { Source, supportsBackchannel } from '@seydx/rtsp';
 *
 * if (supportsBackchannel(source) && source.backchannel) {
 *   const { codec, clockRate, channels } = source.backchannel;
 *   console.log(`talkback expects ${codec} @ ${clockRate}Hz x${channels}`);
 * }
 * ```
 *
 * @see {@link BackchannelSource} For the source capability that exposes this
 */
export interface BackchannelInfo {
  /**
   * Upstream stream index used to send packets back.
   *
   * Identifies the backchannel stream on the upstream connection (e.g. the RTSP
   * track to which outbound RTP packets are written).
   */
  streamIndex: number;

  /**
   * Lower-case codec name expected by the upstream.
   *
   * Examples include `pcm_mulaw`, `pcm_alaw`, and `aac`. Reported in the
   * canonical FFmpeg short-name form.
   */
  codec: string;

  /**
   * node-av `AVCodecID` for the backchannel codec.
   *
   * Provided so a transcoder can construct a matching encoder when the viewer
   * audio must be converted into the upstream's expected format. Absent when the
   * numeric id is not available.
   */
  codecId?: number;

  /**
   * RTP payload type advertised for the backchannel.
   *
   * The dynamic or static payload type number that must be stamped on outbound
   * RTP packets so the upstream associates them with the backchannel stream.
   */
  payloadType: number;

  /**
   * RTP clock rate of the backchannel, in Hz.
   *
   * Used to compute RTP timestamps for outbound packets at the rate the upstream
   * expects (e.g. `8000` for G.711, `48000` for Opus).
   */
  clockRate: number;

  /**
   * Number of audio channels in the backchannel.
   *
   * Typically `1` for the mono talkback streams cameras expect.
   */
  channels: number;
}

/**
 * A source that can accept talkback audio back upstream.
 *
 * Implemented by sources whose upstream supports a backchannel, such as an RTSP
 * camera with an ONVIF backchannel. When a viewer sends audio, the relay
 * forwards it through this capability so it reaches the upstream device. Use
 * {@link supportsBackchannel} to detect whether a given source implements it.
 *
 * @example
 * ```typescript
 * import { supportsBackchannel } from '@seydx/rtsp';
 *
 * if (supportsBackchannel(source)) {
 *   source.sendBackchannel(rtpPacket);
 * }
 * ```
 *
 * @see {@link supportsBackchannel} For the runtime type guard
 *
 * @see {@link BackchannelInfo} For the talkback format description
 */
export interface BackchannelSource {
  /**
   * The negotiated backchannel format, once known.
   *
   * Present only after the upstream is open and has advertised a backchannel;
   * remains `undefined` while closed or when the upstream offers no talkback.
   */
  readonly backchannel?: BackchannelInfo;

  /**
   * Send one RTP packet upstream over the backchannel.
   *
   * The packet must already be encoded in the backchannel codec and packetized
   * as RTP matching {@link BackchannelInfo}; the source forwards it verbatim to
   * the upstream.
   *
   * @param rtp - A single RTP packet, already in the backchannel codec
   *
   * @example
   * ```typescript
   * source.sendBackchannel(rtpPacket);
   * ```
   */
  sendBackchannel(rtp: Buffer): void;
}

/**
 * Determine whether a source accepts talkback audio.
 *
 * Narrows a {@link Source} to also be a {@link BackchannelSource} when it
 * implements `sendBackchannel`, enabling type-safe access to the backchannel
 * API without an unchecked cast.
 *
 * @param source - The source to test
 *
 * @returns `true` if the source implements the backchannel capability, narrowing
 * its type accordingly
 *
 * @example
 * ```typescript
 * import { supportsBackchannel } from '@seydx/rtsp';
 *
 * if (supportsBackchannel(source)) {
 *   // source is now typed as Source & BackchannelSource
 *   source.sendBackchannel(rtpPacket);
 * }
 * ```
 *
 * @see {@link BackchannelSource} For the capability being detected
 */
export function supportsBackchannel(source: Source): source is Source & BackchannelSource {
  return typeof (source as Partial<BackchannelSource>).sendBackchannel === 'function';
}

/**
 * A resolved description of everything a source carries.
 *
 * Returned by {@link Source.open} and handed to each sink's `init`, it
 * enumerates the source's tracks and, when available, the upstream's talkback
 * format. Sinks use this to configure themselves before any packet is written.
 *
 * @example
 * ```typescript
 * import { Source } from '@seydx/rtsp';
 *
 * const info = await source.open();
 * console.log(`${info.tracks.length} tracks, backchannel: ${!!info.backchannel}`);
 * ```
 *
 * @see {@link TrackInfo} For per-track metadata
 *
 * @see {@link BackchannelInfo} For the talkback format
 */
export interface StreamInfo {
  /**
   * The elementary streams carried by the source.
   *
   * One {@link TrackInfo} per demuxed stream, in source order. Sinks iterate
   * this list to set up muxers, encoders, or output channels.
   */
  tracks: TrackInfo[];

  /**
   * The upstream's talkback format, when supported.
   *
   * Present only if the source exposes a backchannel; describes the audio format
   * the upstream expects to receive. Absent for one-way sources.
   */
  backchannel?: BackchannelInfo;
}

/**
 * One unit of media flowing through the relay.
 *
 * Represents a single demuxed packet for one track. The relay core only ever
 * reads {@link MediaPacket.streamIndex} and {@link MediaPacket.isKeyframe} to
 * route and gate packets; sinks that need the encoded payload reach for the
 * underlying AV packet. Each packet is owned by exactly one holder: `clone`
 * produces an independently-owned copy so a single demuxed packet can be fanned
 * out to many sinks, and `free` releases any native resources it holds.
 *
 * @example
 * ```typescript
 * import { MediaPacket } from '@seydx/rtsp';
 *
 * function fanOut(packet: MediaPacket, sinks: { write(p: MediaPacket): void }[]) {
 *   for (const sink of sinks) {
 *     sink.write(packet.clone());
 *   }
 *   packet.free();
 * }
 * ```
 *
 * @see {@link TrackInfo} For the track a packet belongs to
 *
 * @see {@link Sink} For the consumer that receives packets
 */
export interface MediaPacket {
  /**
   * Index of the track this packet belongs to.
   *
   * Matches the {@link TrackInfo.index} of the describing track, letting the
   * relay and sinks route the packet to the correct stream.
   */
  readonly streamIndex: number;

  /**
   * Whether this packet is a keyframe.
   *
   * Used by the relay to gate sinks until a decodable starting point arrives, so
   * downstream consumers begin on a clean frame rather than mid-GOP.
   */
  readonly isKeyframe: boolean;

  /**
   * Presentation timestamp, in the track's time base.
   *
   * The time at which the decoded frame should be presented. May be absent when
   * the source does not provide it.
   */
  readonly pts?: number;

  /**
   * Decode timestamp, in the track's time base.
   *
   * The time at which the packet should be decoded, which can differ from
   * {@link MediaPacket.pts} for streams with B-frames. May be absent when the
   * source does not provide it.
   */
  readonly dts?: number;

  /**
   * Underlying node-av `Packet`.
   *
   * Present for AV-backed sources and carries the encoded payload AV-backed
   * sinks need to write to a muxer. Opaque to the relay core and absent for
   * plain (non-AV) packets.
   */
  readonly av?: unknown;

  /**
   * Return an independently-owned copy of this packet for fan-out.
   *
   * The copy can be handed to another holder without affecting this one; for
   * native packets the copy is cheap and reference-counted. Each clone must be
   * freed independently.
   *
   * @returns A new, independently-owned packet referring to the same media
   *
   * @example
   * ```typescript
   * const copy = packet.clone();
   * sink.write(copy);
   * ```
   */
  clone(): MediaPacket;

  /**
   * Release the packet's underlying native resources.
   *
   * Must be called once the holder is done with the packet. A no-op for plain
   * packets that hold no native resources.
   *
   * @example
   * ```typescript
   * packet.free();
   * ```
   */
  free(): void;
}

/**
 * A single-connection upstream that produces media.
 *
 * Models the lifecycle of one upstream connection: `open` establishes it and
 * resolves the stream layout, `packets` yields demuxed packets until the caller
 * aborts or the stream ends, and `close` tears the connection down. The relay
 * drives exactly one source at a time and fans its packets out to the
 * configured sinks.
 *
 * @example
 * ```typescript
 * import { Source } from '@seydx/rtsp';
 *
 * const info = await source.open();
 * const controller = new AbortController();
 * for await (const packet of source.packets(controller.signal)) {
 *   // route packet.streamIndex to the matching sink
 * }
 * await source.close();
 * ```
 *
 * @see {@link Sink} For the consuming side of the relay
 *
 * @see {@link StreamInfo} For what `open` resolves
 */
export interface Source {
  /**
   * Establish the connection and resolve the stream layout.
   *
   * Connects to the upstream and probes its tracks, returning the resolved
   * description once the layout is known. Must complete before `packets` is
   * consumed.
   *
   * @returns The resolved stream information describing the source's tracks and
   * optional backchannel
   *
   * @example
   * ```typescript
   * const info = await source.open();
   * ```
   */
  open(): Promise<StreamInfo>;

  /**
   * Yield demuxed packets until aborted or the stream ends.
   *
   * Produces an async iterable of {@link MediaPacket} values. Iteration stops
   * when the provided signal aborts or the upstream stream ends.
   *
   * @param signal - Abort signal that stops iteration when triggered
   *
   * @returns An async iterable of demuxed media packets
   *
   * @example
   * ```typescript
   * for await (const packet of source.packets(controller.signal)) {
   *   handle(packet);
   * }
   * ```
   */
  packets(signal: AbortSignal): AsyncIterable<MediaPacket>;

  /**
   * Release the upstream connection and associated resources.
   *
   * Closes the connection opened by `open`. Safe to call after iteration has
   * finished or been aborted.
   *
   * @returns A promise that resolves once the connection is fully closed
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
 * The relay calls `init` once with the resolved stream info, then `write` for
 * each packet destined for this sink (already keyframe-gated), and finally
 * `close` on teardown. The relay frees each packet after the `write` promise
 * resolves, so a sink must not retain a packet beyond that point; if it needs to
 * hold one, it must clone it first.
 *
 * @example
 * ```typescript
 * import { Sink, StreamInfo, MediaPacket } from '@seydx/rtsp';
 *
 * const sink: Sink = {
 *   init(info: StreamInfo) { setup(info); },
 *   write(packet: MediaPacket) { forward(packet); },
 *   close() { teardown(); },
 * };
 * ```
 *
 * @see {@link Source} For the producing side of the relay
 *
 * @see {@link MediaPacket} For the units a sink receives
 */
export interface Sink {
  /**
   * Initialize the sink with the resolved stream layout.
   *
   * Called once before any packet is written, giving the sink the chance to
   * configure muxers, encoders, or output channels from the source's tracks.
   *
   * @param info - The resolved stream information for the source being relayed
   *
   * @returns Nothing, or a promise that resolves once initialization completes
   *
   * @example
   * ```typescript
   * await sink.init(info);
   * ```
   */
  init(info: StreamInfo): Promise<void> | void;

  /**
   * Write a single packet to the sink.
   *
   * Called per packet destined for this sink, already keyframe-gated by the
   * relay. The packet is owned by the relay and freed once the returned promise
   * resolves, so the sink must clone it to retain it beyond this call.
   *
   * @param packet - The media packet to consume
   *
   * @returns Nothing, or a promise that resolves once the packet has been
   * consumed
   *
   * @example
   * ```typescript
   * await sink.write(packet);
   * ```
   */
  write(packet: MediaPacket): Promise<void> | void;

  /**
   * Tear the sink down.
   *
   * Called when the relay stops, allowing the sink to flush and release any
   * resources it acquired during `init`.
   *
   * @returns Nothing, or a promise that resolves once teardown completes
   *
   * @example
   * ```typescript
   * await sink.close();
   * ```
   */
  close(): Promise<void> | void;
}
