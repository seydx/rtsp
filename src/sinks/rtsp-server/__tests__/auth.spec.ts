import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RtspAuth } from '../auth.js';

const URI = 'rtsp://h/live';

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

function nonceOf(challenge: string): string {
  return /nonce="([^"]+)"/.exec(challenge)![1];
}

function digestHeader(nonce: string, password = 'p', uri = URI, method = 'DESCRIBE'): string {
  const response = md5(`${md5(`u:r:${password}`)}:${nonce}:${md5(`${method}:${uri}`)}`);
  return `Digest username="u", realm="r", nonce="${nonce}", uri="${uri}", response="${response}"`;
}

describe('RtspAuth (Digest)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to Digest', () => {
    const auth = new RtspAuth({ username: 'u', password: 'p' });
    expect(auth.method).toBe('Digest');
    expect(auth.challenge()).toMatch(/^Digest realm="seydx-rtsp", nonce="[0-9a-f]{32}"$/);
  });

  it('accepts a correct response and denies a wrong one', () => {
    const auth = new RtspAuth({ username: 'u', password: 'p', realm: 'r' });
    const nonce = nonceOf(auth.challenge());
    expect(auth.verify('DESCRIBE', URI, digestHeader(nonce))).toBe('ok');
    expect(auth.verify('DESCRIBE', URI, digestHeader(nonce, 'wrong'))).toBe('denied');
    expect(auth.verify('SETUP', URI, digestHeader(nonce))).toBe('denied');
    expect(auth.verify('DESCRIBE', URI, undefined)).toBe('denied');
    expect(auth.verify('DESCRIBE', URI, 'Basic dTpw')).toBe('denied');
  });

  it('accepts every unexpired nonce it issued', () => {
    const auth = new RtspAuth({ username: 'u', password: 'p', realm: 'r' });
    const first = nonceOf(auth.challenge());
    const second = nonceOf(auth.challenge());
    expect(first).not.toBe(second);
    // a client mid-handshake keeps using the nonce it was challenged with
    expect(auth.verify('DESCRIBE', URI, digestHeader(first))).toBe('ok');
    expect(auth.verify('DESCRIBE', URI, digestHeader(second))).toBe('ok');
  });

  it('reports right credentials with an unknown nonce as stale', () => {
    const auth = new RtspAuth({ username: 'u', password: 'p', realm: 'r' });
    expect(auth.verify('DESCRIBE', URI, digestHeader('feedfacefeedface'))).toBe('stale');
    expect(auth.verify('DESCRIBE', URI, digestHeader('feedfacefeedface', 'wrong'))).toBe('denied');
  });

  it('expires nonces after five minutes', () => {
    vi.useFakeTimers();
    const auth = new RtspAuth({ username: 'u', password: 'p', realm: 'r' });
    const nonce = nonceOf(auth.challenge());
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(auth.verify('DESCRIBE', URI, digestHeader(nonce))).toBe('ok');
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(auth.verify('DESCRIBE', URI, digestHeader(nonce))).toBe('stale');
  });

  it('keeps at most 64 nonces', () => {
    const auth = new RtspAuth({ username: 'u', password: 'p', realm: 'r' });
    const oldest = nonceOf(auth.challenge());
    for (let i = 0; i < 64; i++) auth.challenge();
    expect(auth.verify('DESCRIBE', URI, digestHeader(oldest))).toBe('stale');
  });

  it('marks a challenge stale on request', () => {
    const auth = new RtspAuth({ username: 'u', password: 'p' });
    expect(auth.challenge(true)).toMatch(/, stale=TRUE$/);
  });
});

describe('RtspAuth (Basic)', () => {
  const auth = new RtspAuth({ username: 'u', password: 'p', method: 'Basic', realm: 'r' });

  it('challenges without a nonce', () => {
    expect(auth.challenge()).toBe('Basic realm="r"');
    expect(auth.challenge(true)).toBe('Basic realm="r"');
  });

  it('checks the base64 credentials', () => {
    expect(auth.verify('DESCRIBE', URI, `Basic ${Buffer.from('u:p').toString('base64')}`)).toBe('ok');
    expect(auth.verify('DESCRIBE', URI, `basic ${Buffer.from('u:p').toString('base64')}`)).toBe('ok');
    expect(auth.verify('DESCRIBE', URI, `Basic ${Buffer.from('u:x').toString('base64')}`)).toBe('denied');
    expect(auth.verify('DESCRIBE', URI, 'Basic')).toBe('denied');
    expect(auth.verify('DESCRIBE', URI, digestHeader('n'))).toBe('denied');
  });
});
