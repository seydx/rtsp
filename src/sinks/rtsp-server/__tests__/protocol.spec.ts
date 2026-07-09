import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { RtspAuth } from '../auth.js';
import { buildResponse, RtspParser } from '../protocol.js';

describe('RtspParser', () => {
  it('parses a request split across chunks', () => {
    const parser = new RtspParser();
    expect(parser.push(Buffer.from('OPTIONS rtsp://h/live RTSP/1.0\r\nCSe'))).toEqual([]);
    const out = parser.push(Buffer.from('q: 2\r\n\r\n'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'request' });
    if (out[0].type === 'request') {
      expect(out[0].request.method).toBe('OPTIONS');
      expect(out[0].request.headers.cseq).toBe('2');
    }
  });

  it('parses a request with a body via Content-Length', () => {
    const parser = new RtspParser();
    const msg = 'ANNOUNCE rtsp://h/live RTSP/1.0\r\nCSeq: 1\r\nContent-Length: 5\r\n\r\nhello';
    const out = parser.push(Buffer.from(msg));
    expect(out).toHaveLength(1);
    if (out[0].type === 'request') expect(out[0].request.body?.toString()).toBe('hello');
  });

  it('parses interleaved binary frames', () => {
    const parser = new RtspParser();
    const payload = Buffer.from([1, 2, 3, 4]);
    const frame = Buffer.concat([Buffer.from([0x24, 2, 0, payload.length]), payload]);
    const out = parser.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: 'interleaved', frame: { channel: 2, data: payload } });
  });

  it('handles back-to-back messages in one chunk', () => {
    const parser = new RtspParser();
    const a = 'OPTIONS rtsp://h RTSP/1.0\r\nCSeq: 1\r\n\r\n';
    const b = 'DESCRIBE rtsp://h RTSP/1.0\r\nCSeq: 2\r\n\r\n';
    const out = parser.push(Buffer.from(a + b));
    expect(out).toHaveLength(2);
  });

  it('rejects a request head that never terminates (buffer-growth DoS)', () => {
    const parser = new RtspParser();
    // No CRLFCRLF anywhere — the parser must bail instead of buffering forever.
    expect(() => parser.push(Buffer.alloc(17 * 1024, 0x41))).toThrow(/head exceeds/);
  });

  it('rejects an oversized declared Content-Length', () => {
    const parser = new RtspParser();
    const msg = 'ANNOUNCE rtsp://h/live RTSP/1.0\r\nCSeq: 1\r\nContent-Length: 999999999\r\n\r\n';
    expect(() => parser.push(Buffer.from(msg))).toThrow(/Content-Length/);
  });

  it('rejects a malformed Content-Length', () => {
    const parser = new RtspParser();
    const msg = 'ANNOUNCE rtsp://h/live RTSP/1.0\r\nCSeq: 1\r\nContent-Length: -5\r\n\r\n';
    expect(() => parser.push(Buffer.from(msg))).toThrow(/Content-Length/);
  });
});

describe('buildResponse', () => {
  it('includes CSeq, Server and Content-Length for bodied responses', () => {
    const text = buildResponse({ status: 200, cseq: '3', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' }).toString();
    expect(text).toContain('RTSP/1.0 200 OK');
    expect(text).toContain('CSeq: 3');
    expect(text).toContain('Content-Type: application/sdp');
    expect(text).toContain(`Content-Length: ${Buffer.byteLength('v=0\r\n')}`);
  });
});

describe('RtspAuth (Digest)', () => {
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');

  function digestHeader(nonce: string, uri = 'rtsp://h/live', method = 'DESCRIBE'): string {
    const ha1 = md5('u:r:p');
    const ha2 = md5(`${method}:${uri}`);
    const response = md5(`${ha1}:${nonce}:${ha2}`);
    return `Digest username="u", realm="r", nonce="${nonce}", uri="${uri}", response="${response}"`;
  }

  it('verifies a correct digest response and rejects a wrong one', () => {
    const auth = new RtspAuth({ username: 'u', password: 'p', method: 'Digest', realm: 'r' });
    const nonce = /nonce="([^"]+)"/.exec(auth.challenge())![1];
    const uri = 'rtsp://h/live';
    const header = digestHeader(nonce, uri);
    const response = /response="([^"]+)"/.exec(header)![1];
    expect(auth.verify('DESCRIBE', uri, header)).toBe(true);
    expect(auth.verify('DESCRIBE', uri, header.replace(response, 'deadbeef'))).toBe(false);
    expect(auth.verify('DESCRIBE', uri, undefined)).toBe(false);
  });

  it('issues a fresh nonce per challenge and accepts every unexpired one', () => {
    const auth = new RtspAuth({ username: 'u', password: 'p', method: 'Digest', realm: 'r' });
    const first = /nonce="([^"]+)"/.exec(auth.challenge())![1];
    const second = /nonce="([^"]+)"/.exec(auth.challenge())![1];
    expect(first).not.toBe(second);
    // A client mid-handshake keeps using the nonce it was challenged with.
    expect(auth.verify('DESCRIBE', 'rtsp://h/live', digestHeader(first))).toBe(true);
    expect(auth.verify('DESCRIBE', 'rtsp://h/live', digestHeader(second))).toBe(true);
  });

  it('rejects a nonce the server never issued (replay from another instance)', () => {
    const auth = new RtspAuth({ username: 'u', password: 'p', method: 'Digest', realm: 'r' });
    auth.challenge();
    expect(auth.verify('DESCRIBE', 'rtsp://h/live', digestHeader('feedfacefeedface'))).toBe(false);
  });

  it('expires nonces after their time-to-live window', () => {
    vi.useFakeTimers();
    try {
      const auth = new RtspAuth({ username: 'u', password: 'p', method: 'Digest', realm: 'r' });
      const nonce = /nonce="([^"]+)"/.exec(auth.challenge())![1];
      expect(auth.verify('DESCRIBE', 'rtsp://h/live', digestHeader(nonce))).toBe(true);

      vi.advanceTimersByTime(6 * 60 * 1000);
      // Beyond the 5-minute window a captured Authorization header is useless.
      expect(auth.verify('DESCRIBE', 'rtsp://h/live', digestHeader(nonce))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
