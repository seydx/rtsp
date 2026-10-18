import { BitStreamFilterAPI, Muxer, StreamingUtils } from 'node-av/api';
import { AV_PKT_DATA_NEW_EXTRADATA } from 'node-av/constants';
import { createServer } from 'node:net';

import { BackchannelTranscoder } from '../../transcode/backchannel-transcoder.js';
import { TranscodeSink } from '../../transcode/transcode-sink.js';
import { supportsBackchannel } from '../../types.js';
import { deferred } from '../../util/deferred.js';
import { TypedEmitter } from '../../util/emitter.js';
import { isRtcp, rtpmapValue } from '../../util/rtp.js';
import { InterleavedFrame, RtspSession } from './session.js';

import type { Packet, Stream } from 'node-av/lib';
import type { Server } from 'node:net';
import type { Relay } from '../../relay.js';
import type { TranscodeOptions } from '../../transcode/track-transcoder.js';
import type { BackchannelFormat, BackchannelInfo, Logger, MediaPacket, Sink, StreamInfo, TrackKind } from '../../types.js';
import type { Deferred } from '../../util/deferred.js';
import type { RtspAuth } from './auth.js';
import type { RtspSessionHost } from './session.js';

/**
 * Options for an {@link RtspServerSink}.
 */
export interface RtspServerSinkOptions {
  /**
   * Interface to listen on. Use `0.0.0.0` to accept remote viewers.
   *
   * @default '127.0.0.1'
   */
  host?: string;

  /**
   * TCP port to listen on; `0` picks a free port, see {@link RtspServerSink.url}.
   *
   * @default 0
   */
  port?: number;

  /**
   * Stream path, served as `rtsp://host:port/<path>`.
   *
   * @default 'live'
   */
  path?: string;

  /**
   * Require credentials from every viewer.
   */
  auth?: RtspAuth;

  /**
   * Maximum RTP packet size in bytes.
   *
   * @default 1200
   */
  mtu?: number;

  /**
   * Accept talkback audio from viewers and advertise it in the SDP.
   *
   * `true` advertises the upstream's own talkback format. An object can
   * advertise a different format, for example PCMA for browsers while the
   * camera expects AAC. Received audio is always emitted as `backchannel`. If
   * the source supports talkback, it is also forwarded to it, transcoded when
   * the formats differ.
   *
   * @default false
   */
  backchannel?: boolean | RtspBackchannelOptions;

  /**
   * Re-encode tracks before serving them, for example MJPEG to H.264.
   *
   * Tracks are encoded once for all viewers, on the hardware the options
   * select. Tracks that already match are served as they are.
   */
  transcode?: TranscodeOptions;

  /**
   * Time in milliseconds a DESCRIBE waits for every track to produce its first RTP packet.
   *
   * Tracks that stay silent longer are left out of the SDP; if none produced
   * anything, DESCRIBE fails with 503.
   *
   * @default 10000
   */
  sdpTimeout?: number;

  /**
   * Time in milliseconds the server stays attached to the relay after the last viewer left.
   *
   * A viewer that returns within this window gets the running stream at once.
   *
   * @default 5000
   */
  detachDelay?: number;

  /**
   * Logger for server, session and transcoding diagnostics.
   */
  logger?: Logger;
}

/**
 * Talkback options of an {@link RtspServerSink}.
 */
export interface RtspBackchannelOptions {
  /**
   * Format advertised to viewers, defaults to the upstream's talkback format.
   */
  advertise?: BackchannelFormat;

  /**
   * Time in milliseconds without talkback packets after which `backchannel:stop` is emitted.
   *
   * @default 2000
   */
  idleTimeout?: number;
}

/**
 * Events emitted by an {@link RtspServerSink}.
 */
export interface RtspServerEvents {
  /**
   * A viewer started playing.
   *
   * @param count - Playing viewers afterwards
   */
  'viewer:added': (count: number) => void;

  /**
   * A viewer paused, left or was dropped.
   *
   * @param count - Playing viewers afterwards
   */
  'viewer:removed': (count: number) => void;

  /**
   * A viewer sent one talkback RTP packet in the advertised format.
   *
   * @param rtp - The RTP packet
   */
  backchannel: (rtp: Buffer) => void;

  /**
   * Talkback started after being idle.
   */
  'backchannel:start': () => void;

  /**
   * No talkback arrived for {@link RtspBackchannelOptions.idleTimeout}, or the stream stopped.
   */
  'backchannel:stop': () => void;
}

/**
 * One track as served over RTP.
 *
 * @internal
 */
interface ServedTrack {
  id: number;
  source: number;
  kind: TrackKind;
  muxer?: Muxer;
  index: number;
  bsf?: BitStreamFilterAPI;
  extradataSet: boolean;
  ready: boolean;
  excluded: boolean;
  seq: number;
  rtpTime: number;
  seen: boolean;
}

/**
 * Talkback state of the current stream.
 *
 * @internal
 */
interface Talkback {
  format: BackchannelFormat;
  track: number;
  idleTimeout: number;
  active: boolean;
  timer?: NodeJS.Timeout;
  transcoder?: BackchannelTranscoder;
}

const DEFAULT_TALKBACK_IDLE_MS = 2000;

/**
 * Serves a relay to many viewers over RTSP.
 *
 * A lean RTSP server over TCP-interleaved transport. It attaches to the relay
 * when the first viewer asks for the stream and detaches after the last one
 * left, so an idle server holds no upstream connection. Every track is
 * packetized once, whatever the number of viewers, and each viewer starts at a
 * video keyframe. Tracks can be re-encoded on the way, for example MJPEG to
 * H.264 with hardware acceleration, and viewers can send talkback audio that
 * reaches the camera.
 *
 * @example
 * ```typescript
 * import { AvSource, Relay, RtspServerSink } from '@seydx/rtsp';
 *
 * const relay = new Relay({ source: new AvSource('rtsp://camera.local/stream'), idleTimeout: 5000 });
 * const server = await new RtspServerSink(relay, { port: 8554 }).listen();
 * console.log(`play ${server.url}`);
 * ```
 *
 * @example
 * ```typescript
 * import { AvSource, Relay, RtspServerSink } from '@seydx/rtsp';
 *
 * // MJPEG camera served as H.264
 * const relay = new Relay({ source: new AvSource('http://camera.local/video.mjpg', { wallclock: true }) });
 * const server = await new RtspServerSink(relay, { transcode: { video: { codec: 'h264' } } }).listen();
 * ```
 *
 * @example
 * ```typescript
 * import { AvSource, Relay, RtspServerSink } from '@seydx/rtsp';
 *
 * // browsers send PCMA, the camera gets its own talkback codec
 * const relay = new Relay({ source: new AvSource('rtsp://camera.local/stream', { backchannel: true }) });
 * const server = await new RtspServerSink(relay, {
 *   backchannel: { advertise: { codec: 'pcm_alaw', payloadType: 8, clockRate: 8000, channels: 1 } },
 * }).listen();
 * ```
 *
 * @see {@link Relay} For the stream it serves
 *
 * @see {@link RtspAuth} For viewer authentication
 *
 * @see {@link TranscodeSink} For the re-encoding behind `transcode`
 *
 * @see {@link BackchannelTranscoder} For talkback conversion
 */
export class RtspServerSink extends TypedEmitter<RtspServerEvents> implements Sink, RtspSessionHost {
  readonly auth?: RtspAuth;
  readonly logger?: Logger;
  readonly path: string;

  private readonly host: string;
  private readonly mtu: number;
  private readonly sdpTimeout: number;
  private readonly detachDelay: number;
  private readonly attachment: Sink;
  private readonly sessions = new Set<RtspSession>();
  private readonly playing = new Set<RtspSession>();
  private readonly bound = new Set<RtspSession>();
  private readonly bySource = new Map<number, ServedTrack>();
  private port: number;
  private server?: Server;
  private tracks: ServedTrack[] = [];
  private talkback?: Talkback;
  private sdp: Deferred<string> = deferred<string>();
  private sdpReady = false;
  private sdpTimer?: NodeJS.Timeout;
  private keyframe = false;
  private piped = false;
  private detachTimer?: NodeJS.Timeout;
  private detaching?: Promise<void>;

  /**
   * Create a server for a relay. Nothing listens until {@link RtspServerSink.listen}.
   *
   * @param relay - The relay to serve; the server pipes itself into it on demand
   *
   * @param options - Network, auth, transcoding and talkback options
   *
   * @example
   * ```typescript
   * const server = new RtspServerSink(relay, { host: '0.0.0.0', port: 8554, path: 'camera' });
   * ```
   */
  constructor(
    private readonly relay: Relay,
    private readonly options: RtspServerSinkOptions = {},
  ) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    this.path = (options.path ?? 'live').replace(/^\/+|\/+$/g, '');
    this.mtu = options.mtu ?? 1200;
    this.sdpTimeout = options.sdpTimeout ?? 10_000;
    this.detachDelay = options.detachDelay ?? 5000;
    this.auth = options.auth;
    this.logger = options.logger;
    // the relay feeds the transcoder, which initializes this server once every track has output
    this.attachment = options.transcode ? new TranscodeSink(this, { ...options.transcode, timeout: this.sdpTimeout, logger: this.logger }) : this;
  }

  /**
   * The URL viewers connect to. The password is masked.
   *
   * @example
   * ```typescript
   * await server.listen();
   * console.log(server.url); // rtsp://127.0.0.1:41235/live
   * ```
   */
  get url(): string {
    const credentials = this.auth ? `${encodeURIComponent(this.auth.username)}:***@` : '';
    return `rtsp://${credentials}${this.host}:${this.port}/${this.path}`;
  }

  /**
   * Number of playing viewers.
   *
   * @example
   * ```typescript
   * console.log(`${server.viewers} viewers`);
   * ```
   */
  get viewers(): number {
    return this.playing.size;
  }

  /**
   * Talkback format advertised to viewers, while the stream is running.
   *
   * @example
   * ```typescript
   * console.log(server.backchannelFormat?.codec);
   * ```
   */
  get backchannelFormat(): BackchannelFormat | undefined {
    return this.talkback?.format;
  }

  /**
   * Track id of the talkback media in the SDP.
   *
   * @internal
   */
  get backchannelTrack(): number | undefined {
    return this.talkback?.track;
  }

  /**
   * Start accepting viewers. Calling it again does nothing.
   *
   * @returns This server, once it listens
   *
   * @throws {Error} If the port cannot be bound
   *
   * @example
   * ```typescript
   * const server = await new RtspServerSink(relay, { port: 8554 }).listen();
   * ```
   */
  async listen(): Promise<this> {
    if (this.server) return this;
    const server = createServer((socket) => {
      // a returning viewer keeps the warm stream
      this.cancelDetach();
      this.sessions.add(new RtspSession(socket, this));
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        server.off('error', reject);
        const address = server.address();
        if (address && typeof address === 'object') this.port = address.port;
        resolve();
      });
    }).catch((error: unknown) => {
      this.server = undefined;
      throw error;
    });
    // an unhandled accept error (EMFILE) would otherwise crash the process
    server.on('error', (error) => this.logger?.error?.('[rtsp] server error:', error));
    this.logger?.log?.(`[rtsp] serving ${this.url}`);
    return this;
  }

  /**
   * Disconnect every viewer, stop listening and detach from the relay.
   *
   * @returns A promise that resolves once everything is closed
   *
   * @example
   * ```typescript
   * await server.shutdown();
   * ```
   */
  async shutdown(): Promise<void> {
    for (const session of [...this.sessions]) session.close();
    this.cancelDetach();
    await this.detaching;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.piped) await this.relay.unpipe(this.attachment);
  }

  /**
   * Prepare one RTP muxer per servable track.
   *
   * Called by the relay. Data tracks and tracks without a native stream are
   * skipped.
   *
   * @param info - The stream layout
   *
   * @throws {Error} If no track can be served
   *
   * @internal
   */
  init(info: StreamInfo): void {
    for (const track of info.tracks) {
      if (track.kind === 'data') continue;
      if (!track.native) {
        this.logger?.warn?.(`[rtsp] skipping ${track.kind} track #${track.index}, it has no native stream`);
        continue;
      }
      const served: ServedTrack = {
        id: this.tracks.length,
        source: track.index,
        kind: track.kind,
        index: 0,
        extradataSet: false,
        ready: false,
        excluded: false,
        seq: 0,
        rtpTime: 0,
        seen: false,
      };
      // registered first, so close() releases whatever was created if a later step throws
      this.tracks.push(served);
      this.bySource.set(track.index, served);
      served.muxer = Muxer.openSync({ write: (chunk: Buffer) => this.onRtp(served, chunk) }, { format: 'rtp', maxPacketSize: this.mtu, useSyncQueue: false });
      served.index = served.muxer.addStream(track.native);
      if (needsAdtsFilter(track.codec, track.native)) served.bsf = BitStreamFilterAPI.create('aac_adtstoasc', track.native);
    }
    if (this.tracks.length === 0) throw new Error('RtspServerSink: the upstream has no servable video or audio track');

    this.setupTalkback(info.backchannel);
    if (this.sdpTimeout > 0) {
      this.sdpTimer = setTimeout(() => this.onSdpTimeout(), this.sdpTimeout);
      this.sdpTimer.unref();
    }
  }

  /**
   * Packetize one packet for every playing viewer.
   *
   * @param packet - The packet, owned by the relay
   *
   * @throws {Error} If muxing fails
   *
   * @internal
   */
  write(packet: MediaPacket): void {
    const track = this.bySource.get(packet.streamIndex);
    const av = packet.av;
    if (!track?.muxer || !av) return;

    if (track.bsf) {
      // the filter takes over the packet data, the relay frees the emptied shell
      const filtered = track.bsf.filterAllSync(av);
      if (filtered.length === 0) return;
      this.writeOwned(track, filtered);
    } else {
      this.keyframe = packet.isKeyframe;
      track.muxer.writePacketSync(av, track.index);
    }
    this.markReady(track);
  }

  /**
   * Release every muxer and disconnect the viewers of this stream.
   *
   * Called by the relay when the stream ends, fails or the server detaches.
   * Viewers are disconnected so they reconnect at once instead of waiting for
   * their own timeout.
   *
   * @internal
   */
  close(): void {
    this.piped = false;
    this.cancelDetach();
    clearTimeout(this.sdpTimer);
    this.sdpTimer = undefined;

    for (const session of [...this.bound]) session.close();
    this.bound.clear();
    this.stopTalkback();
    this.talkback = undefined;

    const tracks = this.tracks;
    this.tracks = [];
    this.bySource.clear();
    for (const track of tracks) {
      const muxer = track.muxer;
      track.muxer = undefined;
      track.bsf?.close();
      try {
        muxer?.closeSync();
      } catch (error) {
        this.logger?.debug?.('[rtsp] muxer close failed:', error);
      }
    }

    // a describe still waiting must fail now, the stream is gone
    this.sdp.reject(new Error('RTSP stream closed before its SDP was ready'));
    this.sdp = deferred<string>();
    this.sdpReady = false;
  }

  /**
   * Attach to the relay if needed and wait for the SDP.
   *
   * @param session - The session asking
   *
   * @returns The SDP
   *
   * @throws {Error} If the stream closes or no track produced data in time
   *
   * @internal
   */
  async describe(session: RtspSession): Promise<string> {
    this.cancelDetach();
    // only yield when needed, a close in between would swap the SDP this describe has to wait for
    if (this.detaching) await this.detaching;
    if (!this.piped) {
      this.piped = true;
      this.relay.pipe(this.attachment);
    }
    const sdp = await this.sdp.promise;
    // a viewer that left while waiting must not be held until the stream closes
    if (this.sessions.has(session)) this.bound.add(session);
    return sdp;
  }

  /**
   * Kind of a served track or the talkback track.
   *
   * @param trackId - SDP track id
   *
   * @returns The kind, or `undefined` for unknown ids
   *
   * @internal
   */
  trackKind(trackId: number): TrackKind | undefined {
    if (trackId === this.talkback?.track) return 'audio';
    const track = this.tracks[trackId] as ServedTrack | undefined;
    return track && !track.excluded ? track.kind : undefined;
  }

  /**
   * Build the `RTP-Info` header from the last packet of each track.
   *
   * @param base - Aggregate control URL
   *
   * @param trackIds - Tracks the viewer set up
   *
   * @returns The header value, or `undefined` before any track sent data
   *
   * @internal
   */
  rtpInfo(base: string, trackIds: readonly number[]): string | undefined {
    const entries: string[] = [];
    for (const id of trackIds) {
      const track = this.tracks[id] as ServedTrack | undefined;
      if (track?.seen) entries.push(`url=${base}/streamid=${id};seq=${(track.seq + 1) & 0xffff};rtptime=${track.rtpTime}`);
    }
    return entries.length > 0 ? entries.join(',') : undefined;
  }

  /**
   * Count a viewer that started playing.
   *
   * @param session - The session
   *
   * @internal
   */
  sessionPlaying(session: RtspSession): void {
    this.playing.add(session);
    this.emit('viewer:added', this.playing.size);
  }

  /**
   * Stop counting a paused viewer.
   *
   * @param session - The session
   *
   * @internal
   */
  sessionPaused(session: RtspSession): void {
    if (this.playing.delete(session)) this.emit('viewer:removed', this.playing.size);
  }

  /**
   * Forget a closed session and schedule the detach after the last one.
   *
   * @param session - The session
   *
   * @internal
   */
  sessionClosed(session: RtspSession): void {
    this.sessions.delete(session);
    this.bound.delete(session);
    if (this.playing.delete(session)) this.emit('viewer:removed', this.playing.size);
    if (this.sessions.size === 0 && this.piped) this.scheduleDetach();
  }

  /**
   * Handle one talkback RTP packet from a viewer.
   *
   * @param rtp - The RTP packet in the advertised format
   *
   * @internal
   */
  backchannelRtp(rtp: Buffer): void {
    const talkback = this.talkback;
    if (!talkback) return;
    if (!talkback.active) {
      talkback.active = true;
      this.emit('backchannel:start');
    }
    clearTimeout(talkback.timer);
    talkback.timer = setTimeout(() => this.stopTalkback(), talkback.idleTimeout);
    talkback.timer.unref();

    this.emit('backchannel', rtp);
    this.forwardTalkback(talkback, rtp);
  }

  /**
   * Decide the advertised talkback format for this stream.
   *
   * @param upstream - The upstream's talkback format, if any
   *
   * @internal
   */
  private setupTalkback(upstream: BackchannelInfo | undefined): void {
    const option = this.options.backchannel;
    if (!option) return;
    const config = option === true ? {} : option;
    const advertised = config.advertise ?? upstream;
    if (!advertised) {
      this.logger?.warn?.('[rtsp] backchannel requested but the upstream advertises none');
      return;
    }
    const { codec, payloadType, clockRate, channels, fmtp } = advertised;
    this.talkback = {
      format: { codec, payloadType, clockRate, channels, fmtp },
      track: this.tracks.length,
      idleTimeout: config.idleTimeout ?? DEFAULT_TALKBACK_IDLE_MS,
      active: false,
    };
  }

  /**
   * Send viewer talkback to the source, transcoding it when the formats differ.
   *
   * @param talkback - Talkback state
   *
   * @param rtp - The viewer's RTP packet
   *
   * @internal
   */
  private forwardTalkback(talkback: Talkback, rtp: Buffer): void {
    const source = this.relay.source;
    if (!supportsBackchannel(source)) return;
    const camera = source.backchannel;
    if (!camera) return;

    const { format } = talkback;
    if (format.codec === camera.codec && format.clockRate === camera.clockRate && format.channels === camera.channels) {
      source.sendBackchannel(format.payloadType === camera.payloadType ? rtp : withPayloadType(rtp, camera.payloadType));
      return;
    }

    if (!talkback.transcoder) {
      const transcoder = new BackchannelTranscoder({
        from: format,
        to: { codec: camera.codec, codecId: camera.codecId, sampleRate: camera.clockRate, channels: camera.channels, payloadType: camera.payloadType },
        output: (chunk) => source.sendBackchannel(chunk),
        onError: () => {
          if (talkback.transcoder === transcoder) talkback.transcoder = undefined;
        },
        logger: this.logger,
      });
      try {
        transcoder.start();
      } catch (error) {
        this.logger?.error?.('[rtsp] backchannel transcoder failed to start:', error);
        return;
      }
      talkback.transcoder = transcoder;
    }
    talkback.transcoder.push(rtp);
  }

  /**
   * End the current talkback burst.
   *
   * @internal
   */
  private stopTalkback(): void {
    const talkback = this.talkback;
    if (!talkback) return;
    clearTimeout(talkback.timer);
    talkback.timer = undefined;
    talkback.transcoder?.close();
    talkback.transcoder = undefined;
    if (talkback.active) {
      talkback.active = false;
      this.emit('backchannel:stop');
    }
  }

  /**
   * Mux packets produced by a bitstream filter and free them.
   *
   * @param track - The served track
   *
   * @param packets - Packets owned by the caller
   *
   * @throws {Error} If muxing fails; all packets are freed anyway
   *
   * @internal
   */
  private writeOwned(track: ServedTrack, packets: Packet[]): void {
    try {
      for (const out of packets) {
        if (!track.extradataSet) this.applyFilterExtradata(track, out);
        this.keyframe = out.isKeyframe;
        track.muxer!.writePacketSync(out, track.index);
      }
    } finally {
      for (const out of packets) out.free();
    }
  }

  /**
   * Copy the configuration a bitstream filter announces onto the output stream before its header is written.
   *
   * @param track - The served track
   *
   * @param packet - A filtered packet
   *
   * @internal
   */
  private applyFilterExtradata(track: ServedTrack, packet: Packet): void {
    const extradata = packet.getSideData(AV_PKT_DATA_NEW_EXTRADATA);
    const stream = track.muxer?.getStream(track.index);
    if (extradata && stream?.codecpar.extradataSize === 0) stream.codecpar.extradata = extradata;
    track.extradataSet = true;
  }

  /**
   * Fan one muxer chunk out to the playing viewers.
   *
   * @param track - The track the chunk belongs to
   *
   * @param chunk - One RTP or RTCP packet, a fresh buffer from the muxer
   *
   * @internal
   */
  private onRtp(track: ServedTrack, chunk: Buffer): void {
    const rtcp = isRtcp(chunk);
    if (!rtcp && chunk.length >= 12) {
      track.seq = chunk.readUInt16BE(2);
      track.rtpTime = chunk.readUInt32BE(4);
      track.seen = true;
    }
    if (this.playing.size === 0) return;
    const keyframe = !rtcp && this.keyframe && track.kind === 'video';
    const frame = new InterleavedFrame(chunk);
    for (const session of this.playing) session.deliver(track.id, rtcp, keyframe, frame);
  }

  /**
   * Note a track's first muxed packet and publish the SDP once all tracks have one.
   *
   * @param track - The track that just muxed a packet
   *
   * @internal
   */
  private markReady(track: ServedTrack): void {
    if (track.ready) return;
    track.ready = true;
    if (!this.sdpReady && this.tracks.every((t) => t.ready || t.excluded)) this.publishSdp();
  }

  /**
   * Leave silent tracks out of the SDP once the deadline passed.
   *
   * @internal
   */
  private onSdpTimeout(): void {
    this.sdpTimer = undefined;
    if (this.sdpReady) return;
    const silent = this.tracks.filter((track) => !track.ready);
    if (silent.length === this.tracks.length) {
      this.logger?.warn?.(`[rtsp] no track produced data within ${this.sdpTimeout}ms, DESCRIBE unavailable`);
      this.sdp.reject(new Error(`No track produced data within ${this.sdpTimeout}ms`));
      return;
    }
    for (const track of silent) {
      this.logger?.warn?.(`[rtsp] leaving ${track.kind} track #${track.source} out of the SDP, it produced no data within ${this.sdpTimeout}ms`);
      track.excluded = true;
      this.bySource.delete(track.source);
    }
    this.publishSdp();
  }

  /**
   * Build the SDP from the ready tracks and resolve waiting DESCRIBEs.
   *
   * @internal
   */
  private publishSdp(): void {
    clearTimeout(this.sdpTimer);
    this.sdpTimer = undefined;
    const tracks = this.tracks.filter((track) => track.ready && !track.excluded);
    const sdp = StreamingUtils.createSdp(tracks.map((track) => track.muxer!.getFormatContext()));
    if (!sdp) {
      this.logger?.warn?.('[rtsp] SDP generation failed');
      this.sdp.reject(new Error('SDP generation failed'));
      return;
    }
    this.sdpReady = true;
    this.sdp.resolve(appendTalkback(controlIds(sdp, tracks), this.talkback));
  }

  /**
   * Detach from the relay after {@link RtspServerSinkOptions.detachDelay}.
   *
   * @internal
   */
  private scheduleDetach(): void {
    if (this.detachTimer || this.detaching) return;
    if (this.detachDelay <= 0) {
      this.detachNow();
      return;
    }
    this.detachTimer = setTimeout(() => {
      this.detachTimer = undefined;
      this.detachNow();
    }, this.detachDelay);
    this.detachTimer.unref();
  }

  /**
   * Detach from the relay unless a viewer came back.
   *
   * @internal
   */
  private detachNow(): void {
    if (this.sessions.size > 0 || !this.piped) return;
    this.detaching = this.relay.unpipe(this.attachment).finally(() => (this.detaching = undefined));
  }

  /**
   * Cancel a scheduled detach.
   *
   * @internal
   */
  private cancelDetach(): void {
    clearTimeout(this.detachTimer);
    this.detachTimer = undefined;
  }
}

/**
 * Whether an AAC track arrives as ADTS and needs `aac_adtstoasc` before RTP packetization.
 *
 * @param codec - Track codec name
 *
 * @param stream - The native stream
 *
 * @returns `true` for AAC without global configuration
 *
 * @internal
 */
function needsAdtsFilter(codec: string, stream: Stream): boolean {
  return codec === 'aac' && stream.codecpar.extradataSize === 0;
}

/**
 * Rewrite the `a=control` lines to `streamid=<track id>` in media order.
 *
 * @param sdp - SDP from libav
 *
 * @param tracks - The tracks in media order
 *
 * @returns The rewritten SDP
 *
 * @internal
 */
function controlIds(sdp: string, tracks: readonly ServedTrack[]): string {
  let media = -1;
  return sdp
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith('m=')) media++;
      return line.startsWith('a=control:') ? `a=control:streamid=${tracks[media]?.id ?? media}` : line;
    })
    .join('\r\n');
}

/**
 * Append the send-only talkback media to an SDP.
 *
 * @param sdp - The SDP of the served tracks
 *
 * @param talkback - Talkback state, if advertised
 *
 * @returns The SDP with the talkback media
 *
 * @internal
 */
function appendTalkback(sdp: string, talkback: Talkback | undefined): string {
  if (!talkback) return sdp;
  const { format, track } = talkback;
  const lines = [
    `m=audio 0 RTP/AVP ${format.payloadType}`,
    `a=rtpmap:${format.payloadType} ${rtpmapValue(format.codec, format.clockRate, format.channels)}`,
    ...(format.fmtp ? [`a=fmtp:${format.payloadType} ${format.fmtp}`] : []),
    'a=sendonly',
    `a=control:streamid=${track}`,
  ];
  return `${sdp.trimEnd()}\r\n${lines.join('\r\n')}\r\n`;
}

/**
 * Copy an RTP packet with another payload type.
 *
 * @param rtp - The RTP packet
 *
 * @param payloadType - The payload type to set
 *
 * @returns The rewritten copy
 *
 * @internal
 */
function withPayloadType(rtp: Buffer, payloadType: number): Buffer {
  const copy = Buffer.from(rtp);
  if (copy.length > 1) copy[1] = (copy[1] & 0x80) | (payloadType & 0x7f);
  return copy;
}
