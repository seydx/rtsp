/**
 * A parsed RTSP request message.
 *
 * Represents a single client request decoded from the RTSP control stream.
 * Header keys are normalized to lower-case so they can be looked up without
 * worrying about the casing a client used on the wire.
 */
export interface RtspRequest {
  /**
   * The request method, upper-cased.
   *
   * The RTSP verb such as `OPTIONS`, `DESCRIBE`, `SETUP`, `PLAY`, or
   * `TEARDOWN`. Always normalized to upper-case regardless of how the client
   * sent it.
   */
  method: string;

  /**
   * The request target URI.
   *
   * The raw request URI exactly as it appeared on the request line, for
   * example `rtsp://host:554/stream` or `*` for server-wide requests.
   */
  uri: string;

  /**
   * The protocol version token.
   *
   * The version string from the request line, typically `RTSP/1.0`.
   */
  version: string;

  /**
   * The request headers, keyed by lower-cased name.
   *
   * Each header value is trimmed of surrounding whitespace. Header names are
   * lower-cased so callers can read fields such as `cseq` or `content-length`
   * without case-sensitivity concerns.
   */
  headers: Record<string, string>;

  /**
   * The optional request body.
   *
   * Present only when the request carried a non-empty payload, sized by the
   * `Content-Length` header (for example the SDP offer of an `ANNOUNCE`).
   */
  body?: Buffer;
}

/**
 * An RTP/RTCP packet received over an interleaved TCP channel.
 *
 * RTSP allows media to be tunneled over the same TCP connection as the control
 * channel using `$`-framed binary blocks. This represents one such block as
 * delivered by a client (for example backchannel audio).
 */
export interface InterleavedFrame {
  /**
   * The interleaved channel identifier.
   *
   * The single-byte channel number from the frame header, used to demultiplex
   * RTP and RTCP streams that share the TCP connection.
   */
  channel: number;

  /**
   * The raw frame payload.
   *
   * A standalone copy of the RTP or RTCP packet bytes, owned independently of
   * the parser's internal buffer so it remains valid after further parsing.
   */
  data: Buffer;
}

/**
 * A single decoded item produced by the RTSP parser.
 *
 * Either a complete text request or an interleaved binary media frame,
 * discriminated by the `type` field.
 */
export type RtspInbound = { type: 'request'; request: RtspRequest } | { type: 'interleaved'; frame: InterleavedFrame };

// '$' marks the start of an interleaved binary frame; any other leading byte
// begins a text request line.
const MAGIC = 0x24;

// RTSP headers terminate with a blank line (CRLFCRLF), like HTTP.
const HEADER_END = Buffer.from('\r\n\r\n');

/**
 * Incremental parser for the RTSP control stream.
 *
 * RTSP framing consists of HTTP-like text requests that may be interspersed
 * with binary `$`-framed RTP/RTCP packets on the same connection. This parser
 * is fed raw socket chunks as they arrive and yields whatever complete
 * messages it can extract, buffering any partial trailing bytes until more
 * data arrives.
 *
 * @example
 * ```typescript
 * const parser = new RtspParser();
 * socket.on('data', (chunk) => {
 *   for (const item of parser.push(chunk)) {
 *     if (item.type === 'request') handleRequest(item.request);
 *     else handleMedia(item.frame);
 *   }
 * });
 * ```
 *
 * @see {@link RtspServerSink} For the server that consumes parsed requests
 *
 * @see {@link RtspAuth} For authenticating parsed requests
 */
export class RtspParser {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Feed a chunk of bytes and extract any complete messages.
   *
   * Appends the chunk to the internal buffer and repeatedly decodes whichever
   * comes first: a `$`-framed interleaved frame or a fully-received text
   * request (headers plus its declared `Content-Length` body). Incomplete
   * trailing data is retained for the next call.
   *
   * @param chunk - The raw bytes received from the socket
   *
   * @returns The complete messages decoded from the buffer, in order; empty when no message is yet complete
   *
   * @example
   * ```typescript
   * const messages = parser.push(socketChunk);
   * for (const message of messages) {
   *   console.log(message.type);
   * }
   * ```
   */
  push(chunk: Buffer): RtspInbound[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: RtspInbound[] = [];

    for (;;) {
      if (this.buffer.length === 0) break;

      if (this.buffer[0] === MAGIC) {
        // Interleaved header is 4 bytes: '$', channel, then a big-endian length.
        if (this.buffer.length < 4) break;
        const channel = this.buffer[1];
        const length = this.buffer.readUInt16BE(2);
        // Wait until the whole declared payload has arrived.
        if (this.buffer.length < 4 + length) break;
        const data = this.buffer.subarray(4, 4 + length);
        // Copy out so the frame survives the subarray-based buffer reslicing below.
        out.push({ type: 'interleaved', frame: { channel, data: Buffer.from(data) } });
        this.buffer = this.buffer.subarray(4 + length);
        continue;
      }

      // Text request: cannot proceed until the full header block is present.
      const headEnd = this.buffer.indexOf(HEADER_END);
      if (headEnd === -1) break;

      const head = this.buffer.subarray(0, headEnd).toString('utf8');
      const request = parseHead(head);
      const contentLength = Number(request.headers['content-length'] ?? 0);
      const bodyStart = headEnd + HEADER_END.length;

      // Hold back the request until its declared body has fully arrived.
      if (this.buffer.length < bodyStart + contentLength) break;

      if (contentLength > 0) {
        // Copy the body so it is independent of the parser's internal buffer.
        request.body = Buffer.from(this.buffer.subarray(bodyStart, bodyStart + contentLength));
      }
      out.push({ type: 'request', request });
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
    }

    return out;
  }
}

/**
 * Parse the textual head of an RTSP request into a structured object.
 *
 * Splits the request line into method, URI and version, then folds each
 * subsequent `Name: value` line into the headers map with lower-cased keys.
 *
 * @param head - The request head text, excluding the terminating blank line
 *
 * @returns The parsed request with an empty body
 *
 * @internal
 */
function parseHead(head: string): RtspRequest {
  const lines = head.split('\r\n');
  const [method = '', uri = '', version = ''] = lines[0].split(' ');
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    // Skip malformed lines that lack a colon separator.
    if (idx === -1) continue;
    const key = lines[i].slice(0, idx).trim().toLowerCase();
    headers[key] = lines[i].slice(idx + 1).trim();
  }
  return { method: method.toUpperCase(), uri, version, headers };
}

// Maps RTSP status codes to their reason phrases for the response status line.
const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  454: 'Session Not Found',
  455: 'Method Not Valid In This State',
  461: 'Unsupported Transport',
  500: 'Internal Server Error',
  501: 'Not Implemented',
};

/**
 * Options for building an RTSP response.
 *
 * Describes the status line, optional sequencing, extra headers and body used
 * to serialize a single RTSP reply.
 */
export interface RtspResponseInit {
  /**
   * The numeric RTSP status code.
   *
   * Used for the status line; its reason phrase is resolved from a known table,
   * falling back to `Unknown` for unrecognized codes (for example `200`, `401`,
   * `461`).
   */
  status: number;

  /**
   * The request sequence number to echo back.
   *
   * When provided, emitted as the `CSeq` header so the client can correlate the
   * response with its originating request. Omit for responses that have no
   * associated request.
   */
  cseq?: string;

  /**
   * Additional response headers to include.
   *
   * Key-value pairs appended verbatim after the mandatory headers, for example
   * `Public`, `Transport` or `Session`. Header names are emitted exactly as
   * given.
   */
  headers?: Record<string, string>;

  /**
   * The optional response body.
   *
   * When present, the body text is appended and a matching `Content-Length`
   * header is generated automatically (for example an SDP description).
   */
  body?: string;
}

/**
 * Serialize an RTSP response into a wire-ready buffer.
 *
 * Builds the status line from the code and its reason phrase, always emits the
 * `Server` header and (when supplied) the `CSeq` header, appends any extra
 * headers, and—when a body is present—adds a computed `Content-Length` before
 * the body.
 *
 * @param init - The response status, sequence number, headers and body
 *
 * @param init.status - Numeric RTSP status code (its reason phrase is looked up)
 *
 * @param init.cseq - Sequence number echoed back in the `CSeq` header, if present
 *
 * @param init.headers - Additional headers to append after the standard ones
 *
 * @param init.body - Optional response body; sets a matching `Content-Length`
 *
 * @returns The encoded response, ready to write to the socket
 *
 * @example
 * ```typescript
 * const reply = buildResponse({
 *   status: 200,
 *   cseq: request.headers['cseq'],
 *   headers: { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN' },
 * });
 * socket.write(reply);
 * ```
 *
 * @see {@link RtspParser} For decoding the requests these respond to
 */
export function buildResponse({ status, cseq, headers, body }: RtspResponseInit): Buffer {
  const lines = [`RTSP/1.0 ${status} ${STATUS_TEXT[status] ?? 'Unknown'}`];
  if (cseq !== undefined) lines.push(`CSeq: ${cseq}`);
  lines.push('Server: seydx-rtsp');
  for (const [key, value] of Object.entries(headers ?? {})) lines.push(`${key}: ${value}`);
  if (body !== undefined) {
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  }
  lines.push('', body ?? '');
  return Buffer.from(lines.join('\r\n'), 'utf8');
}
