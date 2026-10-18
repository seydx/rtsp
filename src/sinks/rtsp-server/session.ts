import { randomBytes } from 'node:crypto';

import { buildResponse, RtspParser, uriPath } from './protocol.js';

import type { Socket } from 'node:net';
import type { Logger, TrackKind } from '../../types.js';
import type { RtspAuth } from './auth.js';
import type { RtspRequest } from './protocol.js';

/**
 * What a session needs from the server that owns it.
 *
 * @internal
 */
export interface RtspSessionHost {
  readonly auth?: RtspAuth;
  readonly logger?: Logger;
  /** Stream path without slashes, for example `live`. */
  readonly path: string;
  /** Resolve the SDP, attaching the server to the relay if needed. */
  describe(session: RtspSession): Promise<string>;
  /** Kind of a served track or the talkback track, `undefined` for unknown ids. */
  trackKind(trackId: number): TrackKind | undefined;
  /** Track id of the talkback media, if advertised. */
  readonly backchannelTrack?: number;
  /** `RTP-Info` header value for the given tracks, if any has sent data. */
  rtpInfo(base: string, trackIds: readonly number[]): string | undefined;
  sessionPlaying(session: RtspSession): void;
  sessionPaused(session: RtspSession): void;
  sessionClosed(session: RtspSession): void;
  backchannelRtp(session: RtspSession, rtp: Buffer): void;
}

/**
 * Interleaved channels of one set-up track.
 *
 * @internal
 */
interface Transport {
  rtp: number;
  rtcp: number;
}

/**
 * One RTP or RTCP packet, framed for interleaved delivery once per channel.
 *
 * Viewers usually pick the same channel numbers, so most packets are framed
 * once no matter how many sessions receive them.
 *
 * @internal
 */
export class InterleavedFrame {
  private channel = -1;
  private framed?: Buffer;

  constructor(readonly payload: Buffer) {}

  /**
   * The packet with the `$`, channel and length prefix.
   *
   * @param channel - Interleaved channel number
   *
   * @returns The framed packet
   *
   * @internal
   */
  on(channel: number): Buffer {
    if (channel === this.channel && this.framed) return this.framed;
    const framed = Buffer.allocUnsafe(4 + this.payload.length);
    framed[0] = 0x24;
    framed[1] = channel;
    framed.writeUInt16BE(this.payload.length, 2);
    this.payload.copy(framed, 4);
    this.channel = channel;
    this.framed = framed;
    return framed;
  }
}

const SUPPORTED_METHODS = 'OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER, SET_PARAMETER';
const SESSION_TIMEOUT_S = 60;
// playing sessions are exempt, interleaved clients often stop sending keep-alives once media flows
const IDLE_TIMEOUT_MS = 2 * SESSION_TIMEOUT_S * 1000;
const IDLE_CHECK_MS = 30_000;
const KEEPALIVE_MS = 15_000;
// several seconds of HD video; a viewer this far behind cannot catch up on live media
const MAX_SOCKET_BUFFER = 8 * 1024 * 1024;

/**
 * One RTSP client connection.
 *
 * Handles the request flow from OPTIONS to TEARDOWN over TCP-interleaved
 * transport, writes the media of the tracks the client set up and forwards
 * talkback RTP to the host. A playing session starts at a video keyframe and
 * is dropped when the client stops reading.
 *
 * @internal
 */
export class RtspSession {
  readonly id = randomBytes(8).toString('hex');

  private readonly parser = new RtspParser();
  private readonly transports = new Map<number, Transport>();
  private readonly idleTimer: NodeJS.Timeout;
  private backchannelChannel?: number;
  private playing = false;
  private started = false;
  private closed = false;
  private sdp?: string;
  private pending: Promise<void> = Promise.resolve();
  private lastActivity = performance.now();

  /**
   * @param socket - The accepted client connection
   *
   * @param host - The owning server
   *
   * @internal
   */
  constructor(
    private readonly socket: Socket,
    private readonly host: RtspSessionHost,
  ) {
    socket.setNoDelay(true);
    // detects viewers that vanished without closing, for example after a network change
    socket.setKeepAlive(true, KEEPALIVE_MS);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_MS);
    this.idleTimer.unref();
  }

  /**
   * Deliver one RTP or RTCP packet of a track to the client.
   *
   * @param trackId - Track the packet belongs to
   *
   * @param rtcp - Whether the packet is RTCP
   *
   * @param keyframe - Whether it belongs to a video keyframe
   *
   * @param frame - The packet, framed per channel on demand
   *
   * @internal
   */
  deliver(trackId: number, rtcp: boolean, keyframe: boolean, frame: InterleavedFrame): void {
    if (!this.playing) return;
    const transport = this.transports.get(trackId);
    if (!transport) return;

    if (this.socket.writableLength > MAX_SOCKET_BUFFER) {
      this.host.logger?.warn?.(`[rtsp] viewer ${this.id} is too slow (${this.socket.writableLength} bytes queued), closing session`);
      this.close();
      return;
    }
    if (!this.started) {
      if (!keyframe && this.needsKeyframe()) return;
      this.started = true;
    }
    this.socket.write(frame.on(rtcp ? transport.rtcp : transport.rtp));
  }

  /**
   * Close the connection. Idempotent.
   *
   * @internal
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.playing = false;
    clearInterval(this.idleTimer);
    this.host.sessionClosed(this);
    this.socket.destroy();
  }

  /**
   * Parse incoming bytes and dispatch requests and talkback frames.
   *
   * @param chunk - Bytes read from the socket
   *
   * @internal
   */
  private onData(chunk: Buffer): void {
    this.lastActivity = performance.now();
    let messages;
    try {
      messages = this.parser.push(chunk);
    } catch (error) {
      this.host.logger?.warn?.('[rtsp] invalid request, closing session:', error);
      this.close();
      return;
    }
    for (const message of messages) {
      if (message.type === 'interleaved') {
        if (message.channel === this.backchannelChannel) this.host.backchannelRtp(this, message.data);
        continue;
      }
      const { request } = message;
      // clients expect responses in request order, a slow DESCRIBE must not be overtaken
      this.pending = this.pending.then(() => this.handle(request));
    }
  }

  /**
   * Close a session that has been idle too long without playing.
   *
   * @internal
   */
  private checkIdle(): void {
    if (this.playing || performance.now() - this.lastActivity < IDLE_TIMEOUT_MS) return;
    this.host.logger?.debug?.(`[rtsp] session ${this.id} idle for ${IDLE_TIMEOUT_MS / 1000}s without playing, closing`);
    this.close();
  }

  /**
   * Authenticate and answer one request.
   *
   * @param request - The request
   *
   * @returns A promise that resolves once the response is written
   *
   * @internal
   */
  private async handle(request: RtspRequest): Promise<void> {
    if (this.closed) return;
    const cseq = request.headers.cseq;

    const auth = this.host.auth?.verify(request.method, request.uri, request.headers.authorization) ?? 'ok';
    if (auth !== 'ok') {
      this.send(buildResponse({ status: 401, cseq, headers: { 'WWW-Authenticate': this.host.auth!.challenge(auth === 'stale') } }));
      return;
    }

    try {
      switch (request.method) {
        case 'OPTIONS':
          this.send(buildResponse({ status: 200, cseq, headers: { Public: SUPPORTED_METHODS } }));
          break;
        case 'DESCRIBE':
          await this.onDescribe(request, cseq);
          break;
        case 'SETUP':
          await this.onSetup(request, cseq);
          break;
        case 'PLAY':
          this.onPlay(request, cseq);
          break;
        case 'PAUSE':
          if (this.playing) {
            this.playing = false;
            this.host.sessionPaused(this);
          }
          this.send(buildResponse({ status: 200, cseq, headers: { Session: this.id } }));
          break;
        case 'GET_PARAMETER':
        case 'SET_PARAMETER':
          this.send(buildResponse({ status: 200, cseq, headers: { Session: this.id } }));
          break;
        case 'TEARDOWN':
          this.send(buildResponse({ status: 200, cseq, headers: { Session: this.id } }));
          this.close();
          break;
        default:
          this.send(buildResponse({ status: 501, cseq }));
      }
    } catch (error) {
      this.host.logger?.error?.('[rtsp] request handling failed:', error);
      this.send(buildResponse({ status: 500, cseq }));
    }
  }

  /**
   * Answer DESCRIBE with the SDP of the stream.
   *
   * @param request - The request
   *
   * @param cseq - Its CSeq
   *
   * @returns A promise that resolves once the response is written
   *
   * @internal
   */
  private async onDescribe(request: RtspRequest, cseq: string | undefined): Promise<void> {
    if (uriPath(request.uri) !== this.host.path) {
      this.send(buildResponse({ status: 404, cseq }));
      return;
    }
    const sdp = await this.ensureDescribed();
    if (sdp === undefined) {
      this.send(buildResponse({ status: 503, cseq }));
      return;
    }
    this.send(
      buildResponse({
        status: 200,
        cseq,
        headers: { 'Content-Type': 'application/sdp', 'Content-Base': `${stripQuery(request.uri).replace(/\/+$/, '')}/` },
        body: sdp,
      }),
    );
  }

  /**
   * Bind a track to interleaved channels.
   *
   * @param request - The request
   *
   * @param cseq - Its CSeq
   *
   * @returns A promise that resolves once the response is written
   *
   * @internal
   */
  private async onSetup(request: RtspRequest, cseq: string | undefined): Promise<void> {
    const transport = request.headers.transport ?? '';
    const interleaved = /interleaved=(\d+)-(\d+)/.exec(transport);
    if (!transport.includes('TCP') || !interleaved) {
      this.send(buildResponse({ status: 461, cseq }));
      return;
    }
    const path = uriPath(request.uri);
    if (this.host.path !== '' && path !== this.host.path && !path.startsWith(`${this.host.path}/`)) {
      this.send(buildResponse({ status: 404, cseq }));
      return;
    }
    // a client may skip DESCRIBE when it cached the SDP, the stream still has to run
    if ((await this.ensureDescribed()) === undefined) {
      this.send(buildResponse({ status: 503, cseq }));
      return;
    }

    const trackId = Number(/streamid=(\d+)/.exec(path)?.[1] ?? this.transports.size);
    if (this.host.trackKind(trackId) === undefined) {
      this.send(buildResponse({ status: 404, cseq }));
      return;
    }
    const rtp = Number(interleaved[1]);
    const rtcp = Number(interleaved[2]);
    this.transports.set(trackId, { rtp, rtcp });
    if (trackId === this.host.backchannelTrack) this.backchannelChannel = rtp;

    this.send(
      buildResponse({
        status: 200,
        cseq,
        headers: { Transport: `RTP/AVP/TCP;unicast;interleaved=${rtp}-${rtcp}`, Session: `${this.id};timeout=${SESSION_TIMEOUT_S}` },
      }),
    );
  }

  /**
   * Start delivering media.
   *
   * @param request - The request
   *
   * @param cseq - Its CSeq
   *
   * @internal
   */
  private onPlay(request: RtspRequest, cseq: string | undefined): void {
    if (this.transports.size === 0) {
      this.send(buildResponse({ status: 455, cseq }));
      return;
    }
    const base = stripQuery(request.uri).replace(/\/+$/, '');
    const media = [...this.transports.keys()].filter((id) => id !== this.host.backchannelTrack).sort((a, b) => a - b);
    const rtpInfo = this.host.rtpInfo(base, media);

    this.send(buildResponse({ status: 200, cseq, headers: { Session: this.id, Range: 'npt=0.000-', ...(rtpInfo ? { 'RTP-Info': rtpInfo } : {}) } }));
    if (!this.playing) {
      this.playing = true;
      this.started = false;
      this.host.sessionPlaying(this);
    }
  }

  /**
   * Fetch the SDP once per session, attaching the server to the relay.
   *
   * @returns The SDP, or `undefined` when the upstream is unavailable or the session closed
   *
   * @internal
   */
  private async ensureDescribed(): Promise<string | undefined> {
    if (this.sdp !== undefined) return this.sdp;
    try {
      const sdp = await this.host.describe(this);
      if (this.closed) return undefined;
      this.sdp = sdp;
      return sdp;
    } catch (error) {
      // a viewer that already left needs no answer, and its failed describe is expected
      if (!this.closed) this.host.logger?.warn?.('[rtsp] DESCRIBE failed, upstream unavailable:', error);
      return undefined;
    }
  }

  /**
   * Whether the client set up a video track and must start at a keyframe.
   *
   * @returns `true` with a video track
   *
   * @internal
   */
  private needsKeyframe(): boolean {
    for (const trackId of this.transports.keys()) {
      if (this.host.trackKind(trackId) === 'video') return true;
    }
    return false;
  }

  /**
   * Write to the socket unless the session is closed.
   *
   * @param data - Bytes to write
   *
   * @internal
   */
  private send(data: Buffer): void {
    if (!this.closed) this.socket.write(data);
  }
}

/**
 * Remove the query string from a URI.
 *
 * @param uri - The URI
 *
 * @returns The URI without query
 *
 * @internal
 */
function stripQuery(uri: string): string {
  const query = uri.indexOf('?');
  return query === -1 ? uri : uri.slice(0, query);
}
