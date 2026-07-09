import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { RtspSession } from '../session.js';

import type { Socket } from 'node:net';
import type { RtspSessionHost } from '../session.js';

/** In-memory stand-in for a client TCP socket. */
class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  writableLength = 0;
  destroyed = false;

  write(buffer: Buffer, callback?: (error?: Error) => void): boolean {
    this.written.push(buffer);
    callback?.();
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }

  /** All response text written so far, in write order. */
  get text(): string {
    return Buffer.concat(this.written).toString('utf8');
  }
}

function makeHost(overrides: Partial<RtspSessionHost> = {}): RtspSessionHost {
  return {
    auth: undefined,
    logger: undefined,
    trackKinds: ['video', 'audio'],
    backchannelStreamId: undefined,
    activate: () => Promise.resolve('v=0\r\n'),
    sessionPlaying: () => undefined,
    sessionClosed: () => undefined,
    onBackchannelRtp: () => undefined,
    ...overrides,
  };
}

function connect(host: RtspSessionHost): { socket: FakeSocket; session: RtspSession } {
  const socket = new FakeSocket();
  const session = new RtspSession(socket as unknown as Socket, host);
  return { socket, session };
}

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('RtspSession request handling', () => {
  it('answers pipelined requests strictly in order', async () => {
    // DESCRIBE resolves late; a pipelined OPTIONS must still be answered after it.
    let releaseSdp!: (sdp: string) => void;
    const host = makeHost({ activate: () => new Promise<string>((resolve) => (releaseSdp = resolve)) });
    const { socket } = connect(host);

    socket.emit('data', Buffer.from('DESCRIBE rtsp://h/live RTSP/1.0\r\nCSeq: 1\r\n\r\nOPTIONS rtsp://h/live RTSP/1.0\r\nCSeq: 2\r\n\r\n'));
    await flush();
    expect(socket.written).toHaveLength(0);

    releaseSdp('v=0\r\n');
    await flush();

    expect(socket.written.length).toBe(2);
    expect(socket.written[0].toString()).toContain('CSeq: 1');
    expect(socket.written[1].toString()).toContain('CSeq: 2');
  });

  it('responds 503 when DESCRIBE activation fails instead of hanging', async () => {
    const host = makeHost({ activate: () => Promise.reject(new Error('upstream down')) });
    const { socket } = connect(host);

    socket.emit('data', Buffer.from('DESCRIBE rtsp://h/live RTSP/1.0\r\nCSeq: 1\r\n\r\n'));
    await flush();

    expect(socket.text).toContain('RTSP/1.0 503 Service Unavailable');
    expect(socket.text).toContain('CSeq: 1');
  });

  it('closes the session on a parser violation', async () => {
    const host = makeHost();
    const { socket, session } = connect(host);

    // A giant head with no CRLFCRLF trips the parser's size limit.
    socket.emit('data', Buffer.alloc(20 * 1024, 0x41));
    await flush();

    expect(socket.destroyed).toBe(true);
    // Idempotent close: a second close must not throw.
    session.close();
  });
});

describe('RtspSession media delivery', () => {
  async function playingSession(host: RtspSessionHost): Promise<{ socket: FakeSocket; session: RtspSession }> {
    const { socket, session } = connect(host);
    socket.emit(
      'data',
      Buffer.from(
        'SETUP rtsp://h/live/streamid=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n' + 'PLAY rtsp://h/live RTSP/1.0\r\nCSeq: 2\r\n\r\n',
      ),
    );
    await flush();
    socket.written.length = 0;
    return { socket, session };
  }

  it('frames fed media as interleaved packets once playing', async () => {
    const closedSessions: unknown[] = [];
    const host = makeHost({ sessionClosed: (s) => closedSessions.push(s) });
    const { socket, session } = await playingSession(host);

    const payload = Buffer.from([1, 2, 3, 4]);
    session.feed(0, false, true, payload);

    expect(socket.written).toHaveLength(1);
    const frame = socket.written[0];
    expect(frame[0]).toBe(0x24);
    expect(frame[1]).toBe(0); // negotiated RTP channel
    expect(frame.readUInt16BE(2)).toBe(payload.length);
    expect(frame.subarray(4)).toEqual(payload);
    expect(closedSessions).toHaveLength(0);
  });

  it('waits for a video keyframe before starting delivery', async () => {
    const host = makeHost();
    const { socket, session } = await playingSession(host);

    session.feed(0, false, false, Buffer.from([1]));
    expect(socket.written).toHaveLength(0);

    session.feed(0, false, true, Buffer.from([2]));
    session.feed(0, false, false, Buffer.from([3]));
    expect(socket.written).toHaveLength(2);
  });

  it('drops a viewer whose socket buffer exceeds the backpressure limit', async () => {
    const warnings: string[] = [];
    const host = makeHost({ logger: { warn: (...args: unknown[]) => warnings.push(String(args[0])) } });
    const { socket, session } = await playingSession(host);

    socket.writableLength = 9 * 1024 * 1024;
    session.feed(0, false, true, Buffer.from([1]));

    expect(socket.destroyed).toBe(true);
    expect(socket.written).toHaveLength(0);
    expect(warnings.some((w) => w.includes('too slow'))).toBe(true);
  });
});
