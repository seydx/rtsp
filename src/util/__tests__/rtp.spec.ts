import { describe, expect, it } from 'vitest';

import { fmtpParam, isRtcp, parseRtp, RtpClock, rtpmapName, rtpmapValue, splitAacAccessUnits } from '../rtp.js';

interface RtpInit {
  payloadType?: number;
  marker?: boolean;
  sequence?: number;
  timestamp?: number;
  csrc?: number;
  extension?: Buffer;
  padding?: number;
  payload: Buffer;
}

function rtp(init: RtpInit): Buffer {
  const csrc = init.csrc ?? 0;
  const header = Buffer.alloc(12 + csrc * 4);
  header[0] = 0x80 | (init.padding ? 0x20 : 0) | (init.extension ? 0x10 : 0) | csrc;
  header[1] = (init.marker ? 0x80 : 0) | (init.payloadType ?? 96);
  header.writeUInt16BE(init.sequence ?? 1, 2);
  header.writeUInt32BE(init.timestamp ?? 0, 4);
  header.writeUInt32BE(0x1234, 8);
  const parts: Buffer[] = [header];
  if (init.extension) {
    const ext = Buffer.alloc(4);
    ext.writeUInt16BE(0xbede, 0);
    ext.writeUInt16BE(init.extension.length / 4, 2);
    parts.push(ext, init.extension);
  }
  parts.push(init.payload);
  if (init.padding) {
    const pad = Buffer.alloc(init.padding);
    pad[init.padding - 1] = init.padding;
    parts.push(pad);
  }
  return Buffer.concat(parts);
}

describe('parseRtp', () => {
  it('reads header fields and payload', () => {
    const parsed = parseRtp(rtp({ payloadType: 8, marker: true, sequence: 513, timestamp: 0xfffffff0, payload: Buffer.from([1, 2, 3]) }));
    expect(parsed).toEqual({ payloadType: 8, marker: true, sequence: 513, timestamp: 0xfffffff0, payload: Buffer.from([1, 2, 3]) });
  });

  it('skips CSRCs, header extensions and padding', () => {
    const parsed = parseRtp(rtp({ csrc: 2, extension: Buffer.alloc(8, 0xaa), padding: 3, payload: Buffer.from([9, 8]) }));
    expect(parsed?.payload).toEqual(Buffer.from([9, 8]));
  });

  it('rejects packets that are not RTP version 2 or too short', () => {
    expect(parseRtp(Buffer.alloc(8))).toBeUndefined();
    const v1 = rtp({ payload: Buffer.from([1]) });
    v1[0] = 0x40;
    expect(parseRtp(v1)).toBeUndefined();
    const truncated = rtp({ extension: Buffer.alloc(8), payload: Buffer.alloc(0) }).subarray(0, 14);
    expect(parseRtp(truncated)).toBeUndefined();
  });
});

describe('splitAacAccessUnits', () => {
  it('splits an AAC-hbr payload with several AU headers', () => {
    const first = Buffer.alloc(5, 1);
    const second = Buffer.alloc(3, 2);
    const header = Buffer.alloc(6);
    header.writeUInt16BE(32, 0);
    header.writeUInt16BE(first.length << 3, 2);
    header.writeUInt16BE(second.length << 3, 4);
    expect(splitAacAccessUnits(Buffer.concat([header, first, second]))).toEqual([first, second]);
  });

  it('returns nothing for malformed payloads', () => {
    expect(splitAacAccessUnits(Buffer.alloc(1))).toEqual([]);
    const header = Buffer.alloc(4);
    header.writeUInt16BE(16, 0);
    header.writeUInt16BE(100 << 3, 2);
    expect(splitAacAccessUnits(Buffer.concat([header, Buffer.alloc(4)]))).toEqual([]);
  });
});

describe('RtpClock', () => {
  it('starts at zero and survives the 32-bit wrap', () => {
    const clock = new RtpClock();
    expect(clock.extend(0xffffff00)).toBe(0n);
    expect(clock.extend(0xffffffa0)).toBe(0xa0n);
    expect(clock.extend(0x00000040)).toBe(0x140n);
  });

  it('follows small backward steps', () => {
    const clock = new RtpClock();
    clock.extend(1000);
    expect(clock.extend(900)).toBe(-100n);
  });
});

describe('SDP helpers', () => {
  it('maps codec names to rtpmap encodings', () => {
    expect(rtpmapName('pcm_mulaw')).toBe('PCMU');
    expect(rtpmapName('pcm_alaw')).toBe('PCMA');
    expect(rtpmapName('aac')).toBe('MPEG4-GENERIC');
    expect(rtpmapName('g722')).toBe('G722');
    expect(rtpmapValue('pcm_alaw', 8000, 1)).toBe('PCMA/8000');
    expect(rtpmapValue('pcm_s16be', 16000, 2)).toBe('L16/16000/2');
    expect(rtpmapValue('opus', 48000, 1)).toBe('opus/48000/2');
  });

  it('reads fmtp parameters case-insensitively', () => {
    const fmtp = 'streamtype=5; Mode=AAC-hbr;config=1408';
    expect(fmtpParam(fmtp, 'mode')).toBe('AAC-hbr');
    expect(fmtpParam(fmtp, 'CONFIG')).toBe('1408');
    expect(fmtpParam(fmtp, 'missing')).toBeUndefined();
    expect(fmtpParam(undefined, 'config')).toBeUndefined();
  });

  it('tells RTCP from RTP', () => {
    expect(isRtcp(Buffer.from([0x80, 200]))).toBe(true);
    expect(isRtcp(Buffer.from([0x80, 204]))).toBe(true);
    expect(isRtcp(Buffer.from([0x80, 96]))).toBe(false);
    expect(isRtcp(Buffer.from([0x80, 0x80 | 8]))).toBe(false);
  });
});
