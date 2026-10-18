import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RtspAuth } from '../auth.js';
import { InterleavedFrame, RtspSession } from '../session.js';

import type { Socket } from 'node:net';
import type { RtspSessionHost } from '../session.js';

// in-memory stand-in for a client TCP socket
class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  writableLength = 0;
  destroyed = false;

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  write(buffer: Buffer): boolean {
    this.written.push(buffer);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }

  get text(): string {
    return Buffer.concat(this.written).toString('utf8');
  }

  get responses(): string[] {
    return this.written.map((buffer) => buffer.toString('utf8')).filter((text) => text.startsWith('RTSP/1.0'));
  }
}

interface HostCalls {
  describe: number;
  playing: number;
  paused: number;
  closed: number;
  backchannel: Buffer[];
}

function makeHost(overrides: Partial<RtspSessionHost> = {}): RtspSessionHost & { calls: HostCalls } {
  const calls: HostCalls = { describe: 0, playing: 0, paused: 0, closed: 0, backchannel: [] };
  return {
    calls,
    auth: undefined,
    logger: undefined,
    path: 'live',
    backchannelTrack: undefined,
    describe: () => {
      calls.describe++;
      return Promise.resolve('v=0\r\n');
    },
    trackKind: (id) => (id === 0 ? 'video' : id === 1 ? 'audio' : undefined),
    rtpInfo: () => undefined,
    sessionPlaying: () => calls.playing++,
    sessionPaused: () => calls.paused++,
    sessionClosed: () => calls.closed++,
    backchannelRtp: (_session, rtp) => calls.backchannel.push(rtp),
    ...overrides,
  };
}

function connect(host: RtspSessionHost): { socket: FakeSocket; session: RtspSession } {
  const socket = new FakeSocket();
  const session = new RtspSession(socket as unknown as Socket, host);
  return { socket, session };
}

function request(method: string, uri: string, cseq: number, headers: Record<string, string> = {}): string {
  const lines = [`${method} ${uri} RTSP/1.0`, `CSeq: ${cseq}`, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)];
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function setup(track: number, channel: number, cseq: number): string {
  return request('SETUP', `rtsp://h/live/streamid=${track}`, cseq, { Transport: `RTP/AVP/TCP;unicast;interleaved=${channel}-${channel + 1}` });
}

async function send(socket: FakeSocket, ...requests: string[]): Promise<void> {
  socket.emit('data', Buffer.from(requests.join('')));
  await flush();
}

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function frame(byte: number): InterleavedFrame {
  return new InterleavedFrame(Buffer.from([byte]));
}

describe('RtspSession requests', () => {
  it('answers OPTIONS with the supported methods', async () => {
    const { socket } = connect(makeHost());
    await send(socket, request('OPTIONS', 'rtsp://h/live', 1));
    expect(socket.text).toMatch(/^RTSP\/1.0 200 OK\r\nCSeq: 1\r\n/);
    expect(socket.text).toContain('Public: OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER, SET_PARAMETER');
  });

  it('answers pipelined requests strictly in order', async () => {
    // DESCRIBE resolves late, the pipelined OPTIONS must still come second
    let release!: (sdp: string) => void;
    const { socket } = connect(makeHost({ describe: () => new Promise<string>((resolve) => (release = resolve)) }));

    await send(socket, request('DESCRIBE', 'rtsp://h/live', 1), request('OPTIONS', 'rtsp://h/live', 2));
    expect(socket.written).toHaveLength(0);

    release('v=0\r\n');
    await flush();
    expect(socket.responses).toHaveLength(2);
    expect(socket.responses[0]).toContain('CSeq: 1');
    expect(socket.responses[1]).toContain('CSeq: 2');
  });

  it('answers DESCRIBE with the SDP and a Content-Base', async () => {
    const { socket } = connect(makeHost());
    await send(socket, request('DESCRIBE', 'rtsp://h:8554/live?token=x', 1));
    expect(socket.text).toContain('Content-Type: application/sdp');
    expect(socket.text).toContain('Content-Base: rtsp://h:8554/live/');
    expect(socket.text.endsWith('\r\n\r\nv=0\r\n')).toBe(true);
  });

  it('answers 404 for a DESCRIBE of another path', async () => {
    const host = makeHost();
    const { socket } = connect(host);
    await send(socket, request('DESCRIBE', 'rtsp://h/other', 1));
    expect(socket.text).toMatch(/^RTSP\/1.0 404 Not Found/);
    expect(host.calls.describe).toBe(0);
  });

  it('answers 503 when the upstream is unavailable', async () => {
    const { socket } = connect(makeHost({ describe: () => Promise.reject(new Error('upstream down')) }));
    await send(socket, request('DESCRIBE', 'rtsp://h/live', 1));
    expect(socket.text).toMatch(/^RTSP\/1.0 503 Service Unavailable\r\nCSeq: 1/);
  });

  it('stays silent when a DESCRIBE fails after the session closed', async () => {
    // a viewer that gave up leaves its DESCRIBE waiting on the shared SDP, a later rejection must not warn or answer
    const warnings: unknown[] = [];
    let reject!: (error: Error) => void;
    const host = makeHost({
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
      describe: () => new Promise<string>((_resolve, fail) => (reject = fail)),
    });
    const { socket, session } = connect(host);

    await send(socket, request('DESCRIBE', 'rtsp://h/live', 1));
    session.close();
    reject(new Error('closed'));
    await flush();

    expect(socket.written).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('describes once per session and lets SETUP describe when DESCRIBE was skipped', async () => {
    const host = makeHost();
    const { socket } = connect(host);
    await send(socket, setup(0, 0, 1));
    expect(socket.text).toContain('Transport: RTP/AVP/TCP;unicast;interleaved=0-1');
    await send(socket, request('DESCRIBE', 'rtsp://h/live', 2), setup(1, 2, 3));
    expect(host.calls.describe).toBe(1);
  });

  it('rejects SETUP for UDP, foreign paths and unknown tracks', async () => {
    const { socket } = connect(makeHost());
    await send(
      socket,
      request('SETUP', 'rtsp://h/live/streamid=0', 1, { Transport: 'RTP/AVP;unicast;client_port=5000-5001' }),
      request('SETUP', 'rtsp://h/other/streamid=0', 2, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' }),
      setup(7, 0, 3),
    );
    expect(socket.responses.map((text) => text.split('\r\n')[0])).toEqual(['RTSP/1.0 461 Unsupported Transport', 'RTSP/1.0 404 Not Found', 'RTSP/1.0 404 Not Found']);
  });

  it('answers 455 for PLAY before SETUP', async () => {
    const host = makeHost();
    const { socket } = connect(host);
    await send(socket, request('PLAY', 'rtsp://h/live', 1));
    expect(socket.text).toMatch(/^RTSP\/1.0 455 /);
    expect(host.calls.playing).toBe(0);
  });

  it('includes RTP-Info for the media tracks on PLAY', async () => {
    const seen: { base: string; ids: readonly number[] }[] = [];
    const host = makeHost({
      backchannelTrack: 2,
      trackKind: (id) => (id === 0 ? 'video' : id === 1 ? 'audio' : id === 2 ? 'audio' : undefined),
      rtpInfo: (base, ids) => {
        seen.push({ base, ids });
        return `url=${base}/streamid=0;seq=1;rtptime=0`;
      },
    });
    const { socket } = connect(host);
    await send(socket, setup(1, 2, 1), setup(0, 0, 2), setup(2, 4, 3), request('PLAY', 'rtsp://h/live/', 4));

    expect(seen).toEqual([{ base: 'rtsp://h/live', ids: [0, 1] }]);
    expect(socket.responses[3]).toContain('RTP-Info: url=rtsp://h/live/streamid=0;seq=1;rtptime=0');
    expect(socket.responses[3]).toContain('Range: npt=0.000-');
    expect(host.calls.playing).toBe(1);
  });

  it('pauses and resumes delivery', async () => {
    const host = makeHost();
    const { socket, session } = connect(host);
    await send(socket, setup(0, 0, 1), request('PLAY', 'rtsp://h/live', 2), request('PAUSE', 'rtsp://h/live', 3));
    expect(host.calls.paused).toBe(1);

    socket.written.length = 0;
    session.deliver(0, false, true, frame(1));
    expect(socket.written).toHaveLength(0);

    await send(socket, request('PLAY', 'rtsp://h/live', 4));
    expect(host.calls.playing).toBe(2);
    socket.written.length = 0;
    // a resumed session starts at a keyframe again
    session.deliver(0, false, false, frame(2));
    session.deliver(0, false, true, frame(3));
    expect(socket.written.map((buffer) => buffer[4])).toEqual([3]);
  });

  it('answers TEARDOWN before closing', async () => {
    const host = makeHost();
    const { socket, session } = connect(host);
    await send(socket, request('TEARDOWN', 'rtsp://h/live', 1));
    expect(socket.text).toMatch(/^RTSP\/1.0 200 OK\r\nCSeq: 1\r\n.*\r\nSession: [0-9a-f]{16}\r\n/s);
    expect(socket.destroyed).toBe(true);
    session.close();
    expect(host.calls.closed).toBe(1);
  });

  it('answers keep-alives and rejects unknown methods', async () => {
    const { socket } = connect(makeHost());
    await send(socket, request('GET_PARAMETER', 'rtsp://h/live', 1), request('SET_PARAMETER', 'rtsp://h/live', 2), request('RECORD', 'rtsp://h/live', 3));
    expect(socket.responses.map((text) => text.split('\r\n')[0])).toEqual(['RTSP/1.0 200 OK', 'RTSP/1.0 200 OK', 'RTSP/1.0 501 Not Implemented']);
  });

  it('closes the session on a parser violation', async () => {
    const host = makeHost();
    const { socket } = connect(host);
    await send(socket, 'A'.repeat(20 * 1024));
    expect(socket.destroyed).toBe(true);
    expect(host.calls.closed).toBe(1);
  });
});

describe('RtspSession authentication', () => {
  const md5 = (input: string): string => createHash('md5').update(input).digest('hex');

  function authorization(challenge: string, method: string, uri: string): string {
    const nonce = /nonce="([^"]+)"/.exec(challenge)![1];
    const response = md5(`${md5('u:r:p')}:${nonce}:${md5(`${method}:${uri}`)}`);
    return `Digest username="u", realm="r", nonce="${nonce}", uri="${uri}", response="${response}"`;
  }

  it('challenges unauthenticated requests and accepts the retry', async () => {
    const host = makeHost({ auth: new RtspAuth({ username: 'u', password: 'p', realm: 'r' }) });
    const { socket } = connect(host);

    await send(socket, request('DESCRIBE', 'rtsp://h/live', 1));
    expect(socket.text).toMatch(/^RTSP\/1.0 401 Unauthorized/);
    expect(host.calls.describe).toBe(0);

    const challenge = /WWW-Authenticate: (.*)\r\n/.exec(socket.text)![1];
    socket.written.length = 0;
    await send(socket, request('DESCRIBE', 'rtsp://h/live', 2, { Authorization: authorization(challenge, 'DESCRIBE', 'rtsp://h/live') }));
    expect(socket.text).toMatch(/^RTSP\/1.0 200 OK/);
  });

  it('sends a stale challenge for an unknown nonce with right credentials', async () => {
    const host = makeHost({ auth: new RtspAuth({ username: 'u', password: 'p', realm: 'r' }) });
    const { socket } = connect(host);
    await send(socket, request('DESCRIBE', 'rtsp://h/live', 1, { Authorization: authorization('nonce="abcd"', 'DESCRIBE', 'rtsp://h/live') }));
    expect(socket.text).toMatch(/^RTSP\/1.0 401 Unauthorized/);
    expect(socket.text).toContain('stale=TRUE');
  });
});

describe('RtspSession media delivery', () => {
  async function playing(host: RtspSessionHost, tracks = [0]): Promise<{ socket: FakeSocket; session: RtspSession }> {
    const { socket, session } = connect(host);
    await send(socket, ...tracks.map((track, i) => setup(track, track * 2, i + 1)), request('PLAY', 'rtsp://h/live', tracks.length + 1));
    socket.written.length = 0;
    return { socket, session };
  }

  it('writes nothing before PLAY', async () => {
    const { socket, session } = connect(makeHost());
    await send(socket, setup(0, 0, 1));
    socket.written.length = 0;
    session.deliver(0, false, true, frame(1));
    expect(socket.written).toHaveLength(0);
  });

  it('frames packets on the negotiated channels', async () => {
    const { socket, session } = await playing(makeHost());
    session.deliver(0, false, true, new InterleavedFrame(Buffer.from([1, 2, 3, 4])));
    session.deliver(0, true, false, new InterleavedFrame(Buffer.from([9])));

    expect(socket.written[0]).toEqual(Buffer.from([0x24, 0, 0, 4, 1, 2, 3, 4]));
    expect(socket.written[1]).toEqual(Buffer.from([0x24, 1, 0, 1, 9]));
  });

  it('ignores tracks the client did not set up', async () => {
    const { socket, session } = await playing(makeHost());
    session.deliver(1, false, true, frame(1));
    expect(socket.written).toHaveLength(0);
  });

  it('waits for a video keyframe before starting', async () => {
    const { socket, session } = await playing(makeHost(), [0, 1]);
    session.deliver(1, false, false, frame(1));
    session.deliver(0, false, false, frame(2));
    session.deliver(0, false, true, frame(3));
    session.deliver(1, false, false, frame(4));
    expect(socket.written.map((buffer) => buffer[4])).toEqual([3, 4]);
  });

  it('starts audio-only sessions at once', async () => {
    const { socket, session } = await playing(makeHost(), [1]);
    session.deliver(1, false, false, frame(1));
    expect(socket.written).toHaveLength(1);
  });

  it('drops a viewer whose socket buffer exceeds the backpressure limit', async () => {
    const warnings: string[] = [];
    const host = makeHost({ logger: { warn: (message: unknown) => warnings.push(String(message)) } });
    const { socket, session } = await playing(host);

    socket.writableLength = 9 * 1024 * 1024;
    session.deliver(0, false, true, frame(1));

    expect(socket.destroyed).toBe(true);
    expect(socket.written).toHaveLength(0);
    expect(warnings.some((warning) => warning.includes('too slow'))).toBe(true);
  });

  it('forwards talkback frames on the backchannel channel only', async () => {
    const host = makeHost({ backchannelTrack: 2, trackKind: (id) => (id <= 2 ? 'audio' : undefined) });
    const { socket } = await playing(host, [1, 2]);
    socket.emit('data', Buffer.from([0x24, 4, 0, 2, 7, 7, 0x24, 2, 0, 1, 8, 0x24, 5, 0, 1, 9]));
    expect(host.calls.backchannel).toEqual([Buffer.from([7, 7])]);
  });
});

describe('RtspSession idle timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a session that never plays and keeps a playing one', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const idle = connect(makeHost());
    const active = connect(makeHost());
    await send(active.socket, setup(0, 0, 1), request('PLAY', 'rtsp://h/live', 2));

    vi.advanceTimersByTime(90_000);
    expect(idle.socket.destroyed).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(idle.socket.destroyed).toBe(true);
    expect(active.socket.destroyed).toBe(false);
    active.session.close();
  });
});

describe('InterleavedFrame', () => {
  it('reuses the framed buffer for the same channel', () => {
    const packet = new InterleavedFrame(Buffer.from([5, 6]));
    const first = packet.on(0);
    expect(packet.on(0)).toBe(first);
    expect(packet.on(2)).toEqual(Buffer.from([0x24, 2, 0, 2, 5, 6]));
  });
});
