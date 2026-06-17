import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

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
  it('verifies a correct digest response and rejects a wrong one', () => {
    const auth = new RtspAuth({ username: 'u', password: 'p', method: 'Digest', realm: 'r' });
    const nonce = /nonce="([^"]+)"/.exec(auth.challenge())![1];
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const uri = 'rtsp://h/live';
    const ha1 = md5('u:r:p');
    const ha2 = md5(`DESCRIBE:${uri}`);
    const response = md5(`${ha1}:${nonce}:${ha2}`);
    const header = `Digest username="u", realm="r", nonce="${nonce}", uri="${uri}", response="${response}"`;
    expect(auth.verify('DESCRIBE', uri, header)).toBe(true);
    expect(auth.verify('DESCRIBE', uri, header.replace(response, 'deadbeef'))).toBe(false);
    expect(auth.verify('DESCRIBE', uri, undefined)).toBe(false);
  });
});
