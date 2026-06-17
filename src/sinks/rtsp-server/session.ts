import { randomBytes } from 'node:crypto';

import { buildResponse, RtspParser } from './protocol.js';

import type { Socket } from 'node:net';
import type { Logger, TrackKind } from '../../types.js';
import type { RtspAuth } from './auth.js';
import type { RtspRequest } from './protocol.js';

/**
 * Server-side hooks a session relies on from its owning server.
 *
 * Decouples an individual viewer session from the server that created it,
 * exposing only the shared configuration and callbacks the session needs to
 * answer the RTSP handshake and forward media. The server implements this
 * interface and passes itself to each {@link RtspSession} it accepts.
 *
 * @internal
 */
export interface RtspSessionHost {
  /**
   * Optional authenticator for incoming requests.
   *
   * When present, every request is checked against this authenticator before it
   * is dispatched; unauthenticated requests receive a 401 challenge. When
   * absent, all requests are served without authentication.
   */
  readonly auth?: RtspAuth;

  /**
   * Optional logger for diagnostics.
   *
   * Used to surface parse failures and request-handling errors. All logging is
   * best-effort and guarded, so a missing logger silently disables it.
   */
  readonly logger?: Logger;

  /**
   * Track kinds indexed by SDP `streamid`.
   *
   * The element at index `n` describes the media kind (for example `video` or
   * `audio`) of the track advertised with `streamid=n` in the SDP. Used to
   * decide whether a viewer's subscription must be keyframe-gated.
   */
  readonly trackKinds: readonly TrackKind[];

  /**
   * SDP `streamid` of the talkback (backchannel) media, if advertised.
   *
   * When set, a viewer that sets up this stream may push audio back to the
   * source over its interleaved RTP channel. Undefined when the source exposes
   * no backchannel.
   */
  readonly backchannelStreamId?: number;

  /**
   * Ensure the upstream source is live and resolve its DESCRIBE SDP.
   *
   * Called the first time a viewer issues DESCRIBE; the server starts (or
   * reuses) the upstream and returns the SDP describing the available tracks.
   *
   * @returns The SDP body to return for DESCRIBE
   */
  activate(): Promise<string>;

  /**
   * Notify the server that a session has entered the playing state.
   *
   * Invoked after a successful PLAY so the server can begin feeding media to
   * this session.
   *
   * @param session - The session that started playing
   */
  sessionPlaying(session: RtspSession): void;

  /**
   * Notify the server that a session has closed.
   *
   * Invoked once when the session tears down or its socket fails, allowing the
   * server to drop it from its active set and release resources.
   *
   * @param session - The session that closed
   */
  sessionClosed(session: RtspSession): void;

  /**
   * Forward inbound talkback RTP from a viewer to the upstream source.
   *
   * The payload has already been de-framed from the interleaved TCP envelope,
   * so it is a bare RTP packet ready to be sent back to the source.
   *
   * @param rtp - The de-framed RTP packet received from the viewer
   */
  onBackchannelRtp(rtp: Buffer): void;
}

/**
 * Interleaved channel pair negotiated for a single track.
 *
 * @internal
 */
interface Transport {
  /** Interleaved TCP channel number carrying RTP for the track. */
  rtp: number;

  /** Interleaved TCP channel number carrying RTCP for the track. */
  rtcp: number;
}

const SUPPORTED_METHODS = 'OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER';

/**
 * A single connected RTSP viewer.
 *
 * Represents one client connection to the RTSP server and drives the full
 * control handshake from OPTIONS through DESCRIBE, SETUP and PLAY. Once playing,
 * the server feeds it packetized media, which the session frames and writes back
 * to the client over the same TCP connection. The session is internal to the
 * server and not part of the public API.
 *
 * @internal
 */
export class RtspSession {
  /** Unique random identifier for this session, used as the RTSP `Session` value. */
  readonly id = randomBytes(8).toString('hex');

  /** Incremental parser for control requests and interleaved frames from the socket. */
  private readonly parser = new RtspParser();

  /** Map of SDP `streamid` to the interleaved channel pair negotiated for that track. */
  private readonly transports = new Map<number, Transport>();

  /** Interleaved RTP channel the client uses to send talkback, set during SETUP of the backchannel track. */
  private backchannelChannel?: number;

  /** Whether the session has issued PLAY and is currently receiving media. */
  private playing = false;

  /** Whether media delivery has actually begun (cleared on each PLAY for keyframe gating). */
  private started = false;

  /** Whether the session has been torn down; guards against double-close and post-close writes. */
  private closed = false;

  /**
   * Create a session bound to an accepted client socket.
   *
   * Wires up the socket's `data`, `error` and `close` events so the session can
   * parse incoming control messages and tear itself down on disconnect.
   *
   * @param socket - The accepted TCP socket for this client
   *
   * @param host - The owning server's hooks and shared configuration
   *
   * @internal
   */
  constructor(
    private readonly socket: Socket,
    private readonly host: RtspSessionHost,
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }

  /**
   * Deliver one packetized RTP/RTCP buffer to this client.
   *
   * Drops the packet unless the session is playing and open. The first time
   * media is delivered after PLAY, delivery waits for a video keyframe (when the
   * client subscribed to video) so the viewer starts at an IDR; once started,
   * every packet for a set-up track is framed and written. Packets for tracks
   * the client did not set up are ignored.
   *
   * @param streamId - SDP `streamid` the packet belongs to
   *
   * @param isRtcp - Whether the buffer is RTCP rather than RTP
   *
   * @param isVideoKeyframe - Whether this RTP packet begins a video keyframe
   *
   * @param data - The packetized RTP/RTCP bytes to deliver
   *
   * @internal
   */
  feed(streamId: number, isRtcp: boolean, isVideoKeyframe: boolean, data: Buffer): void {
    if (!this.playing || this.closed) return;

    if (!this.started) {
      if (this.requiresKeyframe) {
        if (!isVideoKeyframe) return;
      }
      this.started = true;
    }

    const transport = this.transports.get(streamId);
    if (!transport) return;
    this.sendInterleaved(isRtcp ? transport.rtcp : transport.rtp, data);
  }

  /**
   * Tear down the session and release its socket.
   *
   * Idempotent: the first call stops playback, notifies the server, and destroys
   * the socket; subsequent calls do nothing.
   *
   * @internal
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.playing = false;
    this.host.sessionClosed(this);
    this.socket.destroy();
  }

  /**
   * Whether media delivery to this client must wait for a video keyframe.
   *
   * @returns `true` if the client set up at least one video track
   *
   * @internal
   */
  private get requiresKeyframe(): boolean {
    // Only gate on a keyframe if this client actually set up a video track;
    // audio-only subscriptions can start mid-stream without artifacts.
    for (const [streamId] of this.transports) {
      if (this.host.trackKinds[streamId] === 'video') return true;
    }
    return false;
  }

  /**
   * Handle a chunk of raw bytes from the socket.
   *
   * Feeds the chunk through the parser and dispatches each complete message:
   * control requests are routed to the handler, and interleaved frames on the
   * backchannel channel are forwarded upstream. A parse failure closes the
   * session.
   *
   * @param chunk - Raw bytes received from the client socket
   *
   * @internal
   */
  private onData(chunk: Buffer): void {
    let messages;
    try {
      messages = this.parser.push(chunk);
    } catch (error) {
      this.host.logger?.warn?.('[rtsp] parse error:', error);
      this.close();
      return;
    }
    for (const message of messages) {
      if (message.type === 'request') {
        this.handle(message.request);
      } else if (message.frame.channel === this.backchannelChannel) {
        // Talkback RTP from the client → forward upstream.
        this.host.onBackchannelRtp(message.frame.data);
      }
    }
  }

  /**
   * Dispatch a parsed RTSP request to its method handler.
   *
   * Enforces authentication first (replying 401 with a challenge when it fails),
   * then routes by method. Unknown methods return 501 and any handler error
   * returns 500, so the connection stays usable.
   *
   * @param req - The parsed RTSP request to handle
   *
   * @internal
   */
  private async handle(req: RtspRequest): Promise<void> {
    const cseq = req.headers.cseq;

    if (this.host.auth && !this.host.auth.verify(req.method, req.uri, req.headers.authorization)) {
      this.send(buildResponse({ status: 401, cseq, headers: { 'WWW-Authenticate': this.host.auth.challenge() } }));
      return;
    }

    try {
      switch (req.method) {
        case 'OPTIONS':
          this.send(buildResponse({ status: 200, cseq, headers: { Public: SUPPORTED_METHODS } }));
          break;
        case 'DESCRIBE':
          await this.onDescribe(req, cseq);
          break;
        case 'SETUP':
          this.onSetup(req, cseq);
          break;
        case 'PLAY':
          this.onPlay(cseq);
          break;
        case 'PAUSE':
          this.playing = false;
          this.send(buildResponse({ status: 200, cseq, headers: { Session: this.id } }));
          break;
        case 'GET_PARAMETER':
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
   * Handle a DESCRIBE request by returning the upstream SDP.
   *
   * Activates the upstream source to obtain the SDP, then replies with it and a
   * `Content-Base` so the client resolves relative track URIs correctly.
   * Activation is asynchronous, so the session may have closed in the meantime;
   * if so, nothing is sent.
   *
   * @param req - The DESCRIBE request, used for its target URI
   *
   * @param cseq - The request's CSeq to echo back, if present
   *
   * @internal
   */
  private async onDescribe(req: RtspRequest, cseq: string | undefined): Promise<void> {
    const sdp = await this.host.activate();
    if (this.closed) return;
    this.send(
      buildResponse({
        status: 200,
        cseq,
        headers: { 'Content-Type': 'application/sdp', 'Content-Base': `${stripQuery(req.uri)}/` },
        body: sdp,
      }),
    );
  }

  /**
   * Handle a SETUP request by negotiating an interleaved transport.
   *
   * Accepts only TCP-interleaved transport; any other transport is rejected with
   * 461 Unsupported Transport. On success it records the RTP/RTCP channel pair
   * for the requested track and, if that track is the backchannel, remembers its
   * RTP channel so inbound talkback can be recognized.
   *
   * @param req - The SETUP request carrying the Transport header and track URI
   *
   * @param cseq - The request's CSeq to echo back, if present
   *
   * @internal
   */
  private onSetup(req: RtspRequest, cseq: string | undefined): void {
    const transport = req.headers.transport ?? '';
    const interleaved = /interleaved=(\d+)-(\d+)/.exec(transport);
    if (!transport.includes('TCP') || !interleaved) {
      // Only TCP-interleaved transport is supported; reject UDP and others.
      this.send(buildResponse({ status: 461, cseq }));
      return;
    }

    // Fall back to insertion order when the URI omits an explicit streamid.
    const streamId = Number(/streamid=(\d+)/.exec(req.uri)?.[1] ?? this.transports.size);
    const rtp = Number(interleaved[1]);
    const rtcp = Number(interleaved[2]);
    this.transports.set(streamId, { rtp, rtcp });
    if (streamId === this.host.backchannelStreamId) this.backchannelChannel = rtp;

    this.send(
      buildResponse({
        status: 200,
        cseq,
        headers: {
          Transport: `RTP/AVP/TCP;unicast;interleaved=${rtp}-${rtcp}`,
          Session: `${this.id};timeout=60`,
        },
      }),
    );
  }

  /**
   * Handle a PLAY request and start media delivery.
   *
   * Marks the session as playing, resets the keyframe gate so delivery resumes
   * cleanly, and notifies the server to begin feeding media. The response
   * includes an `RTP-Info` header listing each set-up track's initial sequence
   * and timestamp.
   *
   * @param cseq - The request's CSeq to echo back, if present
   *
   * @internal
   */
  private onPlay(cseq: string | undefined): void {
    const rtpInfo = [...this.transports.keys()]
      .sort((a, b) => a - b)
      .map((id) => `url=streamid=${id};seq=0;rtptime=0`)
      .join(',');

    this.playing = true;
    this.started = false;
    this.host.sessionPlaying(this);

    this.send(
      buildResponse({
        status: 200,
        cseq,
        headers: { Session: this.id, Range: 'npt=0.000-', ...(rtpInfo ? { 'RTP-Info': rtpInfo } : {}) },
      }),
    );
  }

  /**
   * Wrap a payload in an interleaved binary frame and send it.
   *
   * Prepends the 4-byte `$`-channel-length header RTSP uses to multiplex binary
   * media over the control connection, then writes the framed bytes.
   *
   * @param channel - Interleaved channel number to tag the frame with
   *
   * @param data - The RTP/RTCP payload to frame
   *
   * @internal
   */
  private sendInterleaved(channel: number, data: Buffer): void {
    const frame = Buffer.allocUnsafe(4 + data.length);
    frame[0] = 0x24; // '$' magic byte marking an interleaved binary frame
    frame[1] = channel;
    frame.writeUInt16BE(data.length, 2);
    data.copy(frame, 4);
    this.send(frame);
  }

  /**
   * Write raw bytes to the client socket.
   *
   * No-ops once the session is closed, and closes the session if the write
   * fails, so a broken connection is cleaned up promptly.
   *
   * @param buffer - The bytes to write
   *
   * @internal
   */
  private send(buffer: Buffer): void {
    if (this.closed) return;
    this.socket.write(buffer, (error) => {
      if (error) this.close();
    });
  }
}

/**
 * Strip the query string from a URI.
 *
 * @param uri - The URI to trim
 *
 * @returns The URI up to but not including the first `?`, or the original URI when none is present
 *
 * @internal
 */
function stripQuery(uri: string): string {
  const q = uri.indexOf('?');
  return q === -1 ? uri : uri.slice(0, q);
}
