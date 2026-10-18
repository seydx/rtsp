/**
 * A parsed RTSP request.
 *
 * @internal
 */
export interface RtspRequest {
  method: string;
  uri: string;
  version: string;
  /** Header names are lower-case. */
  headers: Record<string, string>;
  body?: Buffer;
}

/**
 * Something read from an RTSP connection: a request or an interleaved binary frame.
 *
 * @internal
 */
export type RtspInbound = { type: 'request'; request: RtspRequest } | { type: 'interleaved'; channel: number; data: Buffer };

/**
 * Fields of an RTSP response.
 *
 * @internal
 */
export interface RtspResponseInit {
  status: number;
  cseq?: string;
  headers?: Record<string, string>;
  body?: string;
}

// '$' starts an interleaved binary frame, anything else a text request
const INTERLEAVED_MAGIC = 0x24;
const HEADER_END = Buffer.from('\r\n\r\n');
// real request heads stay well under 2 KiB, a larger one is a broken or hostile client
const MAX_HEAD_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 64 * 1024;

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
  503: 'Service Unavailable',
};

/**
 * Incremental parser for the client side of an RTSP connection.
 *
 * Feeds on raw socket chunks and returns complete requests and interleaved
 * frames in arrival order. Partial data is kept until it completes.
 *
 * @internal
 */
export class RtspParser {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Append a chunk and extract every complete message.
   *
   * @param chunk - Bytes read from the socket
   *
   * @returns The complete messages, possibly none
   *
   * @throws {Error} If a request head or body exceeds its size limit
   *
   * @internal
   */
  push(chunk: Buffer): RtspInbound[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: RtspInbound[] = [];

    while (this.buffer.length > 0) {
      if (this.buffer[0] === INTERLEAVED_MAGIC) {
        if (this.buffer.length < 4) break;
        const length = this.buffer.readUInt16BE(2);
        if (this.buffer.length < 4 + length) break;
        // copy out, the buffer is resliced below and may be concatenated later
        out.push({ type: 'interleaved', channel: this.buffer[1], data: Buffer.from(this.buffer.subarray(4, 4 + length)) });
        this.buffer = this.buffer.subarray(4 + length);
        continue;
      }

      const headEnd = this.buffer.indexOf(HEADER_END);
      if (headEnd === -1 ? this.buffer.length > MAX_HEAD_BYTES : headEnd > MAX_HEAD_BYTES) {
        throw new Error(`RTSP request head exceeds ${MAX_HEAD_BYTES} bytes`);
      }
      if (headEnd === -1) break;

      const request = parseHead(this.buffer.subarray(0, headEnd).toString('utf8'));
      const contentLength = Number(request.headers['content-length'] ?? 0);
      if (!Number.isInteger(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
        throw new Error(`RTSP request declares an invalid Content-Length (max ${MAX_BODY_BYTES} bytes)`);
      }
      const bodyStart = headEnd + HEADER_END.length;
      if (this.buffer.length < bodyStart + contentLength) break;

      if (contentLength > 0) request.body = Buffer.from(this.buffer.subarray(bodyStart, bodyStart + contentLength));
      out.push({ type: 'request', request });
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
    }
    return out;
  }
}

/**
 * Serialize an RTSP response.
 *
 * @param init - Status, CSeq, headers and body
 *
 * @returns The response bytes
 *
 * @internal
 */
export function buildResponse(init: RtspResponseInit): Buffer {
  const { status, cseq, headers, body } = init;
  const lines = [`RTSP/1.0 ${status} ${STATUS_TEXT[status] ?? 'Unknown'}`];
  if (cseq !== undefined) lines.push(`CSeq: ${cseq}`);
  lines.push('Server: seydx-rtsp');
  for (const [key, value] of Object.entries(headers ?? {})) lines.push(`${key}: ${value}`);
  if (body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  lines.push('', body ?? '');
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

/**
 * Path of a request URI without query and surrounding slashes.
 *
 * @param uri - Absolute (`rtsp://host/live`) or path-only (`/live`) URI
 *
 * @returns The path, for example `live/streamid=0`
 *
 * @internal
 */
export function uriPath(uri: string): string {
  let path = uri;
  const scheme = path.indexOf('://');
  if (scheme !== -1) {
    const slash = path.indexOf('/', scheme + 3);
    path = slash === -1 ? '' : path.slice(slash);
  }
  const query = path.indexOf('?');
  if (query !== -1) path = path.slice(0, query);
  return path.replace(/^\/+|\/+$/g, '');
}

/**
 * Parse a request line and its headers.
 *
 * @param head - Everything before the blank line
 *
 * @returns The request without body
 *
 * @internal
 */
function parseHead(head: string): RtspRequest {
  const lines = head.split('\r\n');
  const [method = '', uri = '', version = ''] = lines[0].split(' ');
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon === -1) continue;
    headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
  }
  return { method: method.toUpperCase(), uri, version, headers };
}
