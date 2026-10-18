import { describe, expect, it } from 'vitest';

import { buildResponse, RtspParser, uriPath } from '../protocol.js';

describe('RtspParser', () => {
  it('parses a request split across chunks', () => {
    const parser = new RtspParser();
    expect(parser.push(Buffer.from('OPTIONS rtsp://h/live RTSP/1.0\r\nCSe'))).toEqual([]);
    const out = parser.push(Buffer.from('q: 2\r\n\r\n'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'request', request: { method: 'OPTIONS', uri: 'rtsp://h/live', headers: { cseq: '2' } } });
  });

  it('lower-cases header names and upper-cases the method', () => {
    const parser = new RtspParser();
    const [message] = parser.push(Buffer.from('describe rtsp://h RTSP/1.0\r\nCSeq: 1\r\nX-Custom-Thing:  value \r\n\r\n'));
    expect(message).toMatchObject({ type: 'request', request: { method: 'DESCRIBE', headers: { 'x-custom-thing': 'value' } } });
  });

  it('parses a request with a body via Content-Length', () => {
    const parser = new RtspParser();
    const out = parser.push(Buffer.from('ANNOUNCE rtsp://h/live RTSP/1.0\r\nCSeq: 1\r\nContent-Length: 5\r\n\r\nhel'));
    expect(out).toEqual([]);
    const [message] = parser.push(Buffer.from('lo'));
    expect(message.type === 'request' && message.request.body?.toString()).toBe('hello');
  });

  it('parses interleaved binary frames, also when split', () => {
    const parser = new RtspParser();
    const payload = Buffer.from([1, 2, 3, 4]);
    const frame = Buffer.concat([Buffer.from([0x24, 2, 0, payload.length]), payload]);
    expect(parser.push(frame.subarray(0, 3))).toEqual([]);
    expect(parser.push(frame.subarray(3))).toEqual([{ type: 'interleaved', channel: 2, data: payload }]);
  });

  it('keeps arrival order across mixed requests and frames', () => {
    const parser = new RtspParser();
    const frame = Buffer.from([0x24, 1, 0, 1, 0xff]);
    const request = Buffer.from('GET_PARAMETER rtsp://h RTSP/1.0\r\nCSeq: 5\r\n\r\n');
    const out = parser.push(Buffer.concat([frame, request, frame]));
    expect(out.map((message) => message.type)).toEqual(['interleaved', 'request', 'interleaved']);
  });

  it('handles back-to-back requests in one chunk', () => {
    const parser = new RtspParser();
    const out = parser.push(Buffer.from('OPTIONS rtsp://h RTSP/1.0\r\nCSeq: 1\r\n\r\nDESCRIBE rtsp://h RTSP/1.0\r\nCSeq: 2\r\n\r\n'));
    expect(out).toHaveLength(2);
  });

  it('rejects a request head that never terminates', () => {
    const parser = new RtspParser();
    // no CRLFCRLF anywhere, buffering forever would let a client exhaust memory
    expect(() => parser.push(Buffer.alloc(17 * 1024, 0x41))).toThrow(/head exceeds/);
  });

  it('rejects an oversized or malformed Content-Length', () => {
    expect(() => new RtspParser().push(Buffer.from('ANNOUNCE rtsp://h RTSP/1.0\r\nContent-Length: 999999999\r\n\r\n'))).toThrow(/Content-Length/);
    expect(() => new RtspParser().push(Buffer.from('ANNOUNCE rtsp://h RTSP/1.0\r\nContent-Length: -5\r\n\r\n'))).toThrow(/Content-Length/);
    expect(() => new RtspParser().push(Buffer.from('ANNOUNCE rtsp://h RTSP/1.0\r\nContent-Length: 1.5\r\n\r\n'))).toThrow(/Content-Length/);
  });
});

describe('buildResponse', () => {
  it('includes CSeq, Server and Content-Length for bodied responses', () => {
    const text = buildResponse({ status: 200, cseq: '3', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' }).toString();
    expect(text.startsWith('RTSP/1.0 200 OK\r\nCSeq: 3\r\nServer: seydx-rtsp\r\n')).toBe(true);
    expect(text).toContain('Content-Type: application/sdp');
    expect(text).toContain('Content-Length: 5');
    expect(text.endsWith('\r\n\r\nv=0\r\n')).toBe(true);
  });

  it('ends a bodiless response with a blank line', () => {
    const text = buildResponse({ status: 461 }).toString();
    expect(text).toBe('RTSP/1.0 461 Unsupported Transport\r\nServer: seydx-rtsp\r\n\r\n');
  });
});

describe('uriPath', () => {
  it('strips scheme, host, query and surrounding slashes', () => {
    expect(uriPath('rtsp://127.0.0.1:8554/live/')).toBe('live');
    expect(uriPath('rtsp://user:pass@host/cam/live/streamid=1?token=x')).toBe('cam/live/streamid=1');
    expect(uriPath('/live')).toBe('live');
    expect(uriPath('rtsp://host')).toBe('');
    expect(uriPath('*')).toBe('*');
  });
});
