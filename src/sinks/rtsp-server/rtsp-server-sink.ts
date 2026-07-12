import { AV_PKT_DATA_NEW_EXTRADATA, BitStreamFilterAPI, Muxer, StreamingUtils } from 'node-av';
import { createServer } from 'node:net';

import { deferred } from '../../util/deferred.js';
import { TypedEmitter } from '../../util/emitter.js';
import { ForwardAudioTranscoder } from './forward-audio-transcoder.js';
import { RtspSession } from './session.js';

import type { Server } from 'node:net';
import type { Relay } from '../../relay.js';
import type { Logger, MediaPacket, Sink, StreamInfo, TrackInfo, TrackKind } from '../../types.js';
import type { RtspAuth } from './auth.js';
import type { AudioTranscodeTarget } from './forward-audio-transcoder.js';
import type { RtspSessionHost } from './session.js';

/**
 * Configuration for an {@link RtspServerSink}.
 *
 * Controls the address the server binds to, the path viewers connect on, the RTP
 * packetization size, optional authentication, and whether a talkback
 * (ONVIF backchannel) media is advertised to clients. Every field is optional;
 * sensible defaults are applied for a localhost-only server.
 */
export interface RtspServerSinkOptions {
  /**
   * Hostname or IP address the TCP listener binds to.
   *
   * Use a specific interface address to limit reachability, or `0.0.0.0` to
   * accept connections on every interface.
   *
   * @default '127.0.0.1'
   */
  host?: string;

  /**
   * TCP port the RTSP server listens on.
   *
   * When omitted (or `0`), the operating system assigns a free ephemeral port;
   * the chosen value is reflected by {@link RtspServerSink.url} after
   * {@link RtspServerSink.listen} resolves.
   *
   * @default an ephemeral free port
   */
  port?: number;

  /**
   * Stream path that viewers append to the server URL (the portion after the
   * port, e.g. `rtsp://host:port/live`).
   *
   * Any leading slashes are stripped, so `live` and `/live` are equivalent.
   *
   * @default 'live'
   */
  path?: string;

  /**
   * Authenticator that pulling clients must satisfy before they can DESCRIBE or
   * play the stream.
   *
   * When provided, every request is challenged (Basic or Digest); when omitted
   * the endpoint is open to any client that can reach it.
   *
   * @see {@link RtspAuth}
   */
  auth?: RtspAuth;

  /**
   * Maximum RTP packet size in bytes used by the underlying muxer.
   *
   * Larger payloads are fragmented to fit within this limit. The default keeps
   * packets comfortably below typical network MTUs to avoid IP fragmentation.
   *
   * @default 1200
   */
  mtu?: number;

  /**
   * Advertise a talkback (ONVIF backchannel) media section to viewers so they can
   * send audio back to the camera.
   *
   * Pass `true` to advertise the upstream's own backchannel codec verbatim, so
   * inbound viewer RTP is forwarded straight through (pass-through). Pass a
   * {@link BackchannelAdvertise} to advertise a specific codec instead, in which
   * case the relay transcodes the viewer audio into the camera's native format.
   * When the upstream advertises no backchannel, the request is ignored with a
   * warning.
   */
  backchannel?: boolean | BackchannelAdvertise;

  /**
   * Normalize incoming audio by decoding and re-encoding it, instead of the
   * default bitstream-filter passthrough.
   *
   * Some upstreams deliver unreliable or incompatible elementary audio (for
   * example raw ADTS AAC whose header layout a passthrough bitstream filter
   * cannot adapt), which otherwise fails the whole delivery channel. When set,
   * every `audio` track is routed through a decode → resample → re-encode
   * pipeline and the re-encoded packets are muxed, producing standards-compliant
   * parameters the RTP muxer always accepts. Video and data tracks are never
   * affected; omitted target fields preserve the decoded source's values.
   */
  audioTranscode?: AudioTranscodeTarget;

  /**
   * How long, in milliseconds, to wait for every track to produce its RTP
   * header before generating the DESCRIBE SDP without the stalled tracks.
   *
   * The SDP can only describe tracks whose muxer has emitted a header, which
   * happens on a track's first successfully muxed packet. A track that never
   * produces one (for example a permanently undecodable audio stream routed
   * through {@link RtspServerSinkOptions.audioTranscode}) would otherwise stall
   * SDP generation and hang every DESCRIBE. When the deadline — measured from
   * sink initialization — passes, stalled tracks are excluded from the SDP and
   * the remaining tracks are served; if no track produced a header at all,
   * pending DESCRIBEs fail with `503 Service Unavailable` instead of hanging.
   * Set to `0` to disable and wait indefinitely.
   *
   * @default 10000
   */
  sdpTimeout?: number;

  /**
   * How long, in milliseconds, to stay attached to the relay after the last
   * client disconnects.
   *
   * Detaching tears down the per-track muxers and the resolved SDP, so an
   * immediate detach forces the next viewer through a full warm-up (muxer
   * headers, keyframe sync, SDP generation) even when it reconnects right
   * away — the typical pattern of pulling clients that retry on a read timeout
   * (for example ffmpeg with `-timeout`, or a restreamer that reconnects). The
   * grace period keeps that state warm
   * across the gap: a viewer arriving within the window is answered from the
   * existing SDP immediately, and the upstream never observes the detach. The
   * relay's own `idleTimeout` only starts counting once the sink actually
   * detaches. Set to `0` to detach as soon as the last client leaves.
   *
   * @default 5000
   */
  detachDelay?: number;

  /**
   * Logger used to emit diagnostics about the server lifecycle and per-request
   * activity.
   *
   * When omitted no diagnostics are emitted.
   */
  logger?: Logger;
}

/**
 * Talkback codec descriptor advertised to viewers in the DESCRIBE SDP.
 *
 * Describes the RTP payload format of the backchannel media so a viewer can
 * SETUP a matching sendonly stream and push audio toward the camera.
 */
export interface BackchannelAdvertise {
  /**
   * Lower-case FFmpeg codec name used to derive the SDP rtpmap encoding
   * (e.g. `pcm_mulaw`, `pcm_alaw`, `opus`, `aac`).
   */
  codec: string;

  /**
   * RTP payload type number announced for the talkback media in the SDP.
   */
  payloadType: number;

  /**
   * RTP clock rate in Hz announced in the rtpmap line (e.g. `8000` for G.711).
   */
  clockRate: number;

  /**
   * Number of audio channels; values greater than one append a `/N` suffix to
   * the rtpmap encoding.
   */
  channels: number;
}

/**
 * One node-av RTP muxer bound to a single source track.
 *
 * @internal
 */
interface TrackMuxer {
  muxer: Muxer;
  muxIndex: number;
  sourceIndex: number;
  sdpStreamId: number;
  kind: TrackKind;
  bsf?: BitStreamFilterAPI;
  transcode?: ForwardAudioTranscoder;
  extradataInjected?: boolean;
}

/**
 * Events emitted by an {@link RtspServerSink}.
 *
 * Surfaces viewer connect/disconnect transitions and inbound talkback RTP from
 * clients, allowing callers to track activity or route backchannel audio.
 */
export interface RtspServerEvents {
  /**
   * Emitted when a viewer transitions into the playing state.
   *
   * @param count - The current number of playing viewers.
   */
  'viewer:added': (count: number) => void;

  /**
   * Emitted when a playing viewer disconnects.
   *
   * @param count - The remaining number of playing viewers.
   */
  'viewer:removed': (count: number) => void;

  /**
   * Emitted for each inbound talkback RTP packet received from a viewer.
   *
   * The buffer is raw RTP in the advertised backchannel codec, ready to be
   * forwarded (or transcoded) toward the camera.
   *
   * @param rtp - The raw RTP packet sent by the viewer.
   */
  backchannel: (rtp: Buffer) => void;
}

/**
 * Derive a pass-through advertise format from the upstream's backchannel.
 *
 * @param info - Stream description from the relay's upstream.
 *
 * @returns The upstream backchannel mapped to an advertise descriptor, or `undefined` when the upstream advertises none.
 *
 * @internal
 */
function backchannelFromInfo(info: StreamInfo): BackchannelAdvertise | undefined {
  const bc = info.backchannel;
  if (!bc) return undefined;
  return { codec: bc.codec, payloadType: bc.payloadType, clockRate: bc.clockRate, channels: bc.channels };
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
 * Pick the bitstream filter a track needs to be muxable into RTP, if any.
 *
 * Raw elementary streams that carry their codec configuration in-band rather than
 * as global headers must be adapted before the RTP muxer can emit a header and
 * SDP. The canonical case is ADTS AAC (every frame self-describes, no extradata):
 * the RTP muxer rejects it with "AAC with no global headers", which fails SDP
 * generation. `aac_adtstoasc` strips the ADTS headers and emits the
 * AudioSpecificConfig as `AV_PKT_DATA_NEW_EXTRADATA` packet side data, which is
 * lifted onto the output stream in {@link RtspServerSink.writeFiltered}.
 * H.264/HEVC in Annex B need no filter — the RTP muxer reads their in-band
 * SPS/PPS directly.
 *
 * @param track - The upstream track to inspect.
 *
 * @returns The bitstream filter name to apply, or `null` to mux as-is.
 *
 * @internal
 */
function bsfForTrack(track: TrackInfo): string | null {
  if (track.kind === 'audio' && track.codec === 'aac') {
    const extradata = track.native?.codecpar.extradata;
    if (!extradata || extradata.length === 0) return 'aac_adtstoasc';
  }
  return null;
}

/**
 * Sink that re-publishes a relayed stream as a multi-client RTSP server.
 *
 * Each track is packetized exactly once and the resulting RTP is fanned out to
 * every playing viewer over interleaved TCP, so the upstream is pulled a single
 * time regardless of how many clients are connected. The server is created lazily
 * via the relay, attaching to it on the first client and detaching a grace period
 * after the last viewer leaves (so a quickly retrying client finds the stream
 * still warm), and can optionally advertise an ONVIF talkback channel and require
 * authentication.
 *
 * @example
 * ```typescript
 * import { Relay } from '@seydx/rtsp';
 *
 * const relay = new Relay({ source });
 * const server = await relay.serveRtsp({ port: 8554, path: 'live' });
 * console.log('playing at', server.url);
 * ```
 *
 * @example
 * ```typescript
 * import { Relay, RtspAuth } from '@seydx/rtsp';
 *
 * const relay = new Relay({ source });
 * const server = await relay.serveRtsp({
 *   port: 8554,
 *   auth: new RtspAuth({ username: 'admin', password: 'secret' }),
 *   backchannel: true,
 * });
 *
 * server.on('viewer:added', (count) => console.log('viewers:', count));
 * ```
 *
 * @see {@link Relay} For the relay that feeds this sink
 *
 * @see {@link RtspAuth} For securing the endpoint
 */
export class RtspServerSink extends TypedEmitter<RtspServerEvents> implements Sink, RtspSessionHost {
  readonly auth?: RtspAuth;
  readonly logger?: Logger;

  private readonly host: string;
  private readonly path: string;
  private readonly mtu: number;
  private port: number;

  private server?: Server;
  private readonly sessions = new Set<RtspSession>();
  private readonly playing = new Set<RtspSession>();

  private readonly muxers: TrackMuxer[] = [];
  private readonly muxerBySource = new Map<number, TrackMuxer>();
  private pendingHeaders = new Set<number>();
  private sdp = deferred<string>();
  private sdpResolved = false;
  private sdpTimer?: ReturnType<typeof setTimeout>;
  private currentKeyframe = false;
  private piped = false;
  private dropped: TrackMuxer[] = [];
  private detachTimer?: ReturnType<typeof setTimeout>;
  private detaching?: Promise<void>;

  private readonly backchannelOption?: boolean | BackchannelAdvertise;
  private readonly audioTranscode?: AudioTranscodeTarget;
  private readonly sdpTimeout: number;
  private readonly detachDelay: number;
  private backchannelAdvertise?: BackchannelAdvertise;
  backchannelStreamId?: number;

  trackKinds: readonly TrackKind[] = [];

  /**
   * Create an RTSP server sink bound to a relay.
   *
   * Prefer {@link Relay.serveRtsp}, which constructs the sink, starts listening,
   * and wires up backchannel handling for you.
   *
   * @param relay - The relay whose stream is re-published.
   *
   * @param options - Server configuration such as bind address, path, MTU, auth, and backchannel.
   */
  constructor(
    private readonly relay: Relay,
    options: RtspServerSinkOptions = {},
  ) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    this.path = (options.path ?? 'live').replace(/^\/+/, '');
    this.mtu = options.mtu ?? 1200;
    this.auth = options.auth;
    this.logger = options.logger;
    this.backchannelOption = options.backchannel;
    this.audioTranscode = options.audioTranscode;
    this.sdpTimeout = options.sdpTimeout ?? 10_000;
    this.detachDelay = options.detachDelay ?? 5000;
  }

  /**
   * The talkback codec actually advertised to viewers, once the upstream is
   * known.
   *
   * Resolves to the negotiated format only after {@link init} has run and the
   * upstream's backchannel (or the configured override) has been determined;
   * otherwise `undefined`.
   *
   * @example
   * ```typescript
   * const format = server.backchannelFormat;
   * if (format) console.log('talkback codec:', format.codec);
   * ```
   */
  get backchannelFormat(): BackchannelAdvertise | undefined {
    return this.backchannelAdvertise;
  }

  /**
   * The fully qualified `rtsp://` URL viewers connect to.
   *
   * Includes the bound host and port (resolved after {@link listen}) and the
   * stream path; when authentication is configured the username is shown with the
   * password masked.
   *
   * @example
   * ```typescript
   * await server.listen();
   * console.log('connect to', server.url);
   * ```
   */
  get url(): string {
    const cred = this.auth ? `${encodeURIComponent(this.auth.username)}:***@` : '';
    return `rtsp://${cred}${this.host}:${this.port}/${this.path}`;
  }

  /**
   * The number of viewers currently in the playing state.
   *
   * @example
   * ```typescript
   * console.log('active viewers:', server.viewers);
   * ```
   */
  get viewers(): number {
    return this.playing.size;
  }

  /**
   * Start the TCP listener and begin accepting RTSP clients.
   *
   * Binding is idempotent: calling this again after the server is already
   * listening returns immediately. When no explicit port was configured, the
   * chosen ephemeral port is filled in and becomes visible via {@link url}.
   *
   * @returns This sink, once the socket is bound.
   *
   * @throws {Error} If the socket cannot bind (for example, the port is in use).
   *
   * @example
   * ```typescript
   * const server = new RtspServerSink(relay, { port: 8554 });
   * await server.listen();
   * console.log(server.url);
   * ```
   */
  async listen(): Promise<this> {
    if (this.server) return this;
    const server = createServer((socket) => {
      socket.setNoDelay(true);
      // A returning client cancels a pending detach so the warm muxer/SDP
      // state survives the gap between its attempts.
      this.cancelDetach();
      const session = new RtspSession(socket, this);
      this.sessions.add(session);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => {
        const address = server.address();
        if (address && typeof address === 'object') this.port = address.port;
        server.off('error', reject);
        resolve();
      });
    });
    // Keep a handler attached for the server's lifetime: a later runtime error
    // (e.g. EMFILE on accept) would otherwise crash the process as an
    // unhandled 'error' event.
    server.on('error', (error) => this.logger?.error?.('[rtsp] server error:', error));
    this.logger?.log?.(`[rtsp] serving ${this.url}`);
    return this;
  }

  /**
   * Fully tear the server down.
   *
   * Closes every connected viewer, stops the TCP listener, and detaches from the
   * relay so the upstream can go idle. Safe to call even if the server was never
   * started.
   *
   * @returns A promise that resolves once the listener is closed and the relay is detached.
   *
   * @example
   * ```typescript
   * await server.shutdown();
   * ```
   */
  async shutdown(): Promise<void> {
    for (const session of [...this.sessions]) session.close();
    // Closing the last session may have scheduled (or begun) a lazy detach;
    // supersede it with this deliberate teardown.
    this.cancelDetach();
    if (this.detaching) await this.detaching;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    if (this.piped) await this.relay.unpipe(this);
  }

  /**
   * Handle one inbound talkback RTP packet received from a viewer.
   *
   * Forwards the packet to listeners by re-emitting it as a `backchannel` event;
   * the relay (or application) is responsible for routing it toward the camera.
   *
   * @param rtp - The raw RTP packet sent by the viewer.
   *
   * @example
   * ```typescript
   * server.on('backchannel', (rtp) => camera.sendAudio(rtp));
   * ```
   */
  onBackchannelRtp(rtp: Buffer): void {
    this.emit('backchannel', rtp);
  }

  /**
   * Ensure the upstream is live and resolve the DESCRIBE SDP.
   *
   * Invoked by a session handling its first DESCRIBE. Attaches to the relay on
   * the first call (which lazily opens the upstream) and returns a promise for the
   * SDP, which resolves once headers for every track have been seen.
   *
   * @returns The SDP describing the available media, including any talkback section.
   *
   * @throws {Error} If the sink is torn down (e.g. the upstream failed to start)
   * before the SDP became available.
   *
   * @example
   * ```typescript
   * const sdp = await server.activate();
   * ```
   */
  async activate(): Promise<string> {
    this.cancelDetach();
    // A detach may already be tearing the sink down (close() rejects and
    // re-arms the SDP deferred). Wait it out and re-attach with fresh state —
    // otherwise this DESCRIBE would be handed the very promise the teardown
    // is about to reject.
    if (this.detaching) await this.detaching;
    if (!this.piped) {
      this.piped = true;
      this.relay.pipe(this);
    }
    return this.sdp.promise;
  }

  /**
   * Register a session as actively playing.
   *
   * Tracks the session for fan-out and emits a `viewer:added` event with the new
   * viewer count.
   *
   * @param session - The session that just entered the playing state.
   *
   * @example
   * ```typescript
   * server.sessionPlaying(session);
   * ```
   */
  sessionPlaying(session: RtspSession): void {
    this.playing.add(session);
    this.emit('viewer:added', this.playing.size);
  }

  /**
   * Deregister a session that has disconnected.
   *
   * Removes the session from the connected and playing sets, emitting
   * `viewer:removed` if it was playing. When no sessions remain, a detach from
   * the relay is scheduled after the configured grace period (so a quickly
   * retrying client finds the sink still warm); once it fires, the relay — and
   * thus the upstream — can go idle.
   *
   * @param session - The session that closed.
   *
   * @example
   * ```typescript
   * server.sessionClosed(session);
   * ```
   */
  sessionClosed(session: RtspSession): void {
    this.sessions.delete(session);
    if (this.playing.delete(session)) {
      this.emit('viewer:removed', this.playing.size);
    }
    if (this.sessions.size === 0 && this.piped) {
      this.scheduleDetach();
    }
  }

  /**
   * Schedule the detach from the relay after the last client left.
   *
   * With a zero grace period the detach begins immediately; otherwise a timer
   * is armed and cancelled again if a client connects (or a DESCRIBE activates
   * the sink) before it fires.
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
    this.detachTimer.unref?.();
  }

  /**
   * Begin the actual detach, re-checking that no client returned in the
   * meantime.
   *
   * The unpipe (which closes this sink and resets it for reuse) is tracked in
   * `detaching` so a DESCRIBE racing the teardown can await it instead of
   * being handed the SDP promise the teardown is about to reject. Unpipe never
   * rejects — channel close isolates sink errors.
   *
   * @internal
   */
  private detachNow(): void {
    if (this.sessions.size > 0 || !this.piped) return;
    this.detaching = this.relay.unpipe(this).finally(() => {
      this.detaching = undefined;
    });
  }

  /**
   * Cancel a scheduled (but not yet started) detach.
   *
   * @internal
   */
  private cancelDetach(): void {
    if (this.detachTimer) {
      clearTimeout(this.detachTimer);
      this.detachTimer = undefined;
    }
  }

  /**
   * Initialize the sink for a freshly opened upstream.
   *
   * Creates one RTP muxer per relayable source track, records the track kinds,
   * and (when requested) resolves the talkback media to advertise. Data tracks
   * and tracks without a native stream handle are skipped: they cannot be RTP
   * packetized, and waiting for a header from a track that rarely (or never)
   * produces packets would stall SDP generation and hang every DESCRIBE. Called
   * by the relay when the upstream stream description becomes available.
   *
   * @param info - Description of the upstream tracks and any backchannel it offers.
   *
   * @returns A promise that resolves once all per-track muxers are open.
   *
   * @throws {Error} If the upstream carries no track that can be served over RTP.
   *
   * @example
   * ```typescript
   * await server.init(streamInfo);
   * ```
   */
  async init(info: StreamInfo): Promise<void> {
    const kinds: TrackKind[] = [];
    let sdpStreamId = 0;
    for (const track of info.tracks) {
      if (track.kind === 'data') {
        this.logger?.debug?.(`[rtsp] skipping data track #${track.index} (not RTP-servable)`);
        continue;
      }
      if (!track.native) {
        this.logger?.warn?.(`[rtsp] skipping ${track.kind} track #${track.index} — no native stream handle (non-AV source?)`);
        continue;
      }
      const id = sdpStreamId++;
      kinds.push(track.kind);
      const muxer = await Muxer.open(
        {
          write: (buffer: Buffer) => {
            this.onRtp(id, buffer);
            return buffer.length;
          },
        },
        { format: 'rtp', maxPacketSize: this.mtu } as never,
      );
      const entry: TrackMuxer = { muxer, muxIndex: -1, sourceIndex: track.index, sdpStreamId: id, kind: track.kind };

      if (track.kind === 'audio' && this.audioTranscode) {
        // Consumer opted into normalizing this audio: decode and re-encode it
        // rather than passing an incompatible elementary stream through a
        // bitstream filter. The transcoder owns the output stream (the encoder).
        const transcoder = new ForwardAudioTranscoder(this.audioTranscode, this.logger);
        entry.muxIndex = await transcoder.start(track.native, muxer);
        entry.transcode = transcoder;
      } else {
        entry.muxIndex = muxer.addStream(track.native);

        // Raw elementary streams (e.g. ADTS AAC) need a bitstream filter before the
        // RTP muxer can write its header / generate SDP. The output stream is
        // adapted lazily once the filter has produced its parameters (see write()).
        const bsfName = bsfForTrack(track);
        if (bsfName) {
          entry.bsf = BitStreamFilterAPI.create(bsfName, track.native);
          this.logger?.debug?.(`[rtsp] applying ${bsfName} to ${track.kind} track #${track.index}`);
        }
      }

      this.muxers.push(entry);
      this.muxerBySource.set(track.index, entry);
      this.pendingHeaders.add(id);
    }
    this.trackKinds = kinds;
    if (this.muxers.length === 0) {
      throw new Error('RtspServerSink: upstream carries no RTP-servable (video/audio) track');
    }
    // Arm the SDP deadline: a track that never muxes a packet must not hang
    // DESCRIBE forever (see onSdpTimeout).
    this.armSdpTimer();

    // Talkback media is advertised after the regular tracks so its streamid follows them.
    if (this.backchannelOption) {
      const advertise = this.backchannelOption === true ? backchannelFromInfo(info) : this.backchannelOption;
      if (advertise) {
        this.backchannelAdvertise = advertise;
        this.backchannelStreamId = sdpStreamId;
      } else {
        this.logger?.warn?.('[rtsp] backchannel requested but the upstream advertises none');
      }
    }
  }

  /**
   * Packetize and fan out one media packet to all playing viewers.
   *
   * Routes the packet to its track's muxer (which emits RTP via `onRtp`);
   * packets for unknown tracks or without native data are dropped. Once the muxer
   * for every track has produced its header, the deferred SDP is resolved.
   *
   * @param packet - The media packet to packetize and deliver.
   *
   * @returns A promise that resolves once the packet has been written to its muxer.
   *
   * @example
   * ```typescript
   * await server.write(packet);
   * ```
   */
  async write(packet: MediaPacket): Promise<void> {
    const entry = this.muxerBySource.get(packet.streamIndex);
    if (!entry || !packet.av) return;
    // Remember the current packet's keyframe flag so onRtp can gate viewers on an IDR.
    this.currentKeyframe = packet.isKeyframe;

    let muxed: number;
    if (entry.transcode) {
      muxed = await entry.transcode.write(packet.av, entry.muxer);
    } else if (entry.bsf) {
      muxed = await this.writeFiltered(entry, packet);
    } else {
      await entry.muxer.writePacket(packet.av, entry.muxIndex);
      muxed = 1;
    }

    // The SDP can only be built once every track's muxer has emitted its header,
    // which happens on the first muxed packet. Encoding/filtering paths buffer, so
    // an early call can produce zero packets — clearing the pending header before
    // the header exists would serialise the track with unresolved codecpar
    // (e.g. `m=application RTP/AVP 3`). Only clear it once a packet was muxed.
    if (!this.sdpResolved && muxed > 0 && this.pendingHeaders.delete(entry.sdpStreamId) && this.pendingHeaders.size === 0) {
      this.resolveSdp();
    }
  }

  /**
   * Run a packet through the track's bitstream filter and mux the results.
   *
   * A filter that adapts a raw elementary stream (e.g. `aac_adtstoasc`) emits the
   * codec's global headers as `AV_PKT_DATA_NEW_EXTRADATA` side data on its first
   * output packet. That extradata is lifted onto the output stream before the
   * first packet writes the muxer header, so the header — and thus the SDP — is
   * built with the configuration the RTP muxer requires.
   *
   * @param entry - The track muxer whose `bsf` is set.
   *
   * @param packet - The raw upstream packet to filter and write.
   *
   * @returns The number of packets written to the muxer this call (zero while the
   * filter is still buffering, before its header is emitted).
   *
   * @internal
   */
  private async writeFiltered(entry: TrackMuxer, packet: MediaPacket): Promise<number> {
    const filtered = await entry.bsf!.filterAll(packet.av!);
    if (filtered.length === 0) return 0; // filter needs more data before it emits anything

    let written = 0;
    for (const out of filtered) {
      try {
        // The filter signals fresh global headers via NEW_EXTRADATA side data;
        // copy it onto the output stream before its first packet writes the header.
        if (!entry.extradataInjected) {
          const extradata = out.getSideData(AV_PKT_DATA_NEW_EXTRADATA);
          const outStream = entry.muxer.getStream(entry.muxIndex);
          if (extradata && outStream?.codecpar.extradataSize === 0) {
            outStream.codecpar.extradata = extradata;
            entry.extradataInjected = true;
          }
        }
        await entry.muxer.writePacket(out, entry.muxIndex);
        written++;
      } finally {
        out.free();
      }
    }
    return written;
  }

  /**
   * Release all per-track muxers and reset state for a fresh upstream.
   *
   * Closes every muxer, clears the track bookkeeping, and re-arms the deferred SDP
   * so the sink can be reused when the relay reattaches. Called by the relay when
   * the upstream ends or is detached.
   *
   * @returns A promise that resolves once all muxers are closed.
   *
   * @example
   * ```typescript
   * await server.close();
   * ```
   */
  async close(): Promise<void> {
    this.cancelSdpTimer();
    this.cancelDetach();
    // Include deadline-excluded tracks: they were only unrouted, their native
    // resources are still alive and owned here.
    const all = [...this.muxers, ...this.dropped];
    this.dropped = [];
    for (const m of all) m.bsf?.close();
    await Promise.all(all.flatMap((m) => (m.transcode ? [m.transcode.close()] : [])));
    await Promise.all(all.map((m) => m.muxer.close().catch(() => undefined)));
    this.muxers.length = 0;
    this.muxerBySource.clear();
    this.pendingHeaders = new Set();
    this.sdpResolved = false;
    // Fail any DESCRIBE still waiting on the old SDP — the upstream is gone
    // (failed start or teardown), and leaving the promise pending would hang
    // those viewers forever. A settled deferred ignores the reject.
    this.sdp.reject(new Error('RTSP server sink closed before the SDP became available'));
    this.sdp = deferred<string>();
    this.backchannelAdvertise = undefined;
    this.backchannelStreamId = undefined;
    this.piped = false;
  }

  /**
   * Fan one muxer-produced RTP/RTCP buffer out to all playing viewers.
   *
   * @param sdpStreamId - SDP streamid of the track the buffer belongs to.
   *
   * @param buffer - The packetized RTP or RTCP bytes from the muxer.
   *
   * @internal
   */
  private onRtp(sdpStreamId: number, buffer: Buffer): void {
    // RTCP payload types fall in 72..76; everything else is treated as RTP.
    const pt = buffer[1] & 0x7f;
    const isRtcp = pt >= 72 && pt <= 76;
    const isVideoKeyframe = !isRtcp && this.currentKeyframe && this.trackKinds[sdpStreamId] === 'video';
    if (this.playing.size === 0) return;

    const data = Buffer.from(buffer); // copy out — the muxer reuses its buffer
    for (const session of this.playing) {
      session.feed(sdpStreamId, isRtcp, isVideoKeyframe, data);
    }
  }

  /**
   * Build the DESCRIBE SDP from the open muxers and resolve the deferred.
   *
   * Generates the base SDP, normalizes the per-media control attributes, appends
   * any talkback section, and resolves the promise returned by {@link activate}.
   *
   * @internal
   */
  private resolveSdp(): void {
    this.cancelSdpTimer();
    const sdp = StreamingUtils.createSdp(this.muxers.map((m) => m.muxer.getFormatContext()));
    if (!sdp) {
      this.logger?.warn?.('[rtsp] SDP generation returned null');
      return;
    }
    this.sdpResolved = true;
    this.sdp.resolve(
      this.appendBackchannel(
        this.rewriteControl(
          sdp,
          this.muxers.map((m) => m.sdpStreamId),
        ),
      ),
    );
  }

  /**
   * Arm the SDP deadline timer, if enabled and not already resolved or armed.
   *
   * @internal
   */
  private armSdpTimer(): void {
    if (this.sdpTimeout <= 0 || this.sdpResolved || this.sdpTimer) return;
    this.sdpTimer = setTimeout(() => {
      this.sdpTimer = undefined;
      this.onSdpTimeout();
    }, this.sdpTimeout);
    this.sdpTimer.unref?.();
  }

  /**
   * Cancel a pending SDP deadline timer.
   *
   * @internal
   */
  private cancelSdpTimer(): void {
    if (this.sdpTimer) {
      clearTimeout(this.sdpTimer);
      this.sdpTimer = undefined;
    }
  }

  /**
   * Handle the SDP deadline: serve what is ready, drop what is not.
   *
   * Tracks that still have no muxer header (nothing was ever muxed for them —
   * e.g. permanently undecodable audio) are excluded from the SDP so waiting
   * DESCRIBEs can be answered with the tracks that do work. Exclusion is pure
   * bookkeeping — the track is removed from packet routing and SDP generation,
   * but its native resources stay alive until {@link close} because a write may
   * be in flight on it. The remaining tracks keep their original SDP streamids,
   * so already-cached client state stays valid. When no track produced a header
   * at all, the SDP promise is rejected instead and pending DESCRIBEs fail with
   * 503 rather than hanging.
   *
   * @internal
   */
  private onSdpTimeout(): void {
    if (this.sdpResolved || this.pendingHeaders.size === 0) return;

    const stalled = this.muxers.filter((m) => this.pendingHeaders.has(m.sdpStreamId));
    if (stalled.length === this.muxers.length) {
      this.logger?.warn?.(`[rtsp] no track produced an RTP header within ${this.sdpTimeout}ms — DESCRIBE unavailable`);
      // Clear the pending set so a late packet cannot re-trigger resolveSdp
      // against the now-rejected deferred; the endpoint stays unavailable until
      // close() re-arms it.
      this.pendingHeaders.clear();
      this.sdp.reject(new Error(`No track produced an RTP header within ${this.sdpTimeout}ms`));
      return;
    }

    for (const entry of stalled) {
      this.logger?.warn?.(`[rtsp] excluding ${entry.kind} track #${entry.sourceIndex} from the SDP — no RTP header within ${this.sdpTimeout}ms`);
      this.dropped.push(entry);
      this.muxers.splice(this.muxers.indexOf(entry), 1);
      this.muxerBySource.delete(entry.sourceIndex);
      this.pendingHeaders.delete(entry.sdpStreamId);
    }
    this.resolveSdp();
  }

  /**
   * Append a sendonly talkback media section so viewers can SETUP it.
   *
   * No-op when no backchannel is advertised; otherwise adds an audio media line
   * with the advertised rtpmap and a control attribute matching its streamid.
   *
   * @param sdp - The base SDP for the regular media tracks.
   *
   * @returns The SDP with the talkback media section appended, or unchanged if none is advertised.
   *
   * @internal
   */
  private appendBackchannel(sdp: string): string {
    const bc = this.backchannelAdvertise;
    if (!bc || this.backchannelStreamId === undefined) return sdp;
    const channels = bc.channels > 1 ? `/${bc.channels}` : '';
    const lines = [
      `m=audio 0 RTP/AVP ${bc.payloadType}`,
      `a=rtpmap:${bc.payloadType} ${rtpmapName(bc.codec)}/${bc.clockRate}${channels}`,
      'a=sendonly',
      `a=control:streamid=${this.backchannelStreamId}`,
    ];
    return `${sdp.trimEnd()}\r\n${lines.join('\r\n')}\r\n`;
  }

  /**
   * Rewrite each media's control attribute to a relative `a=control:streamid=N`.
   *
   * Normalizes whatever control URL the muxer emitted into the relative form
   * clients use during SETUP. Media sections carry the streamids assigned at
   * init rather than their position, so tracks excluded by the SDP deadline do
   * not shift the ids of the remaining tracks.
   *
   * @param sdp - The SDP whose control attributes are rewritten.
   *
   * @param streamIds - The original streamid for each media section, in order.
   *
   * @returns The SDP with relative per-media control attributes.
   *
   * @internal
   */
  private rewriteControl(sdp: string, streamIds: number[]): string {
    let media = -1;
    return sdp
      .split('\n')
      .map((line) => {
        if (line.startsWith('m=')) media++;
        if (line.startsWith('a=control:')) return `a=control:streamid=${streamIds[media] ?? media}`;
        return line;
      })
      .join('\n');
  }
}
