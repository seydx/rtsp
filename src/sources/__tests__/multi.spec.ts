import { AV_NOPTS_VALUE } from 'node-av/constants';
import { createReadStream } from 'node:fs';
import { copyFile, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Fixtures, hasFfmpeg } from '../../__tests__/helpers/media.js';
import { Relay } from '../../relay.js';
import { CallbackSink } from '../../sinks/callback.js';
import { MultiSource } from '../multi.js';

import type { Socket } from 'node:net';
import type { MediaPacket, StreamInfo } from '../../types.js';

const suite = hasFfmpeg ? describe : describe.skip;

// an MJPEG camera over HTTP; its first client gets `stallAfter` frames and then nothing, on an open connection
async function mjpegServer(frames: Buffer[], stallAfter = Number.POSITIVE_INFINITY): Promise<{ url: string; connections: () => number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createHttpServer((_request, response) => {
    const connection = ++connections;
    response.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace;boundary=ffmpeg' });
    (async () => {
      for (let i = 0; !response.destroyed && (connection > 1 || i < stallAfter); i++) {
        response.write(frames[i % frames.length]);
        await delay(40);
      }
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/video.mjpg`,
    connections: () => connections,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// a live 32 kHz mono pcm wav over HTTP whose first client gets `endAfter` ms of samples; libav reads 64 KiB of a pcm wav while opening, a second here
async function wavServer(endAfter: number): Promise<{ url: string; close: () => Promise<void> }> {
  const rate = 32_000;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(0xffffffff, 40);
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createHttpServer((_request, response) => {
    const connection = ++connections;
    response.writeHead(200, { 'Content-Type': 'audio/wav' });
    response.write(header);
    (async () => {
      const start = performance.now();
      // paced by elapsed time, timers fire late and a sample clock slower than the wallclock would drift
      for (let sent = 0; !response.destroyed && (connection > 1 || sent < endAfter); sent += 20) {
        response.write(Buffer.alloc((rate / 50) * 2));
        await delay(Math.max(0, start + sent + 20 - performance.now()));
      }
      response.end();
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/audio.wav`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// the parts of an mpjpeg file, each a complete frame with its boundary
function mjpegFrames(data: Buffer): Buffer[] {
  const marker = Buffer.from('--ffmpeg');
  const frames: Buffer[] = [];
  for (let at = data.indexOf(marker), next; at >= 0; at = next) {
    next = data.indexOf(marker, at + marker.length);
    const part = data.subarray(at, next < 0 ? data.length : next);
    // the closing boundary carries no frame
    if (part.length > 100) frames.push(part);
  }
  return frames;
}

async function drain(source: MultiSource, onPacket: (packet: MediaPacket) => void | Promise<void> = () => undefined): Promise<number> {
  let count = 0;
  for await (const packet of source.packets(new AbortController().signal)) {
    count++;
    await onPacket(packet);
    packet.free();
  }
  return count;
}

suite('MultiSource', () => {
  let fixtures: Fixtures;
  let h264: string;
  let aac: string;
  let frames: Buffer[];

  beforeAll(async () => {
    fixtures = await Fixtures.create();
    let mjpeg: string;
    [h264, aac, mjpeg] = await Promise.all([fixtures.clip('h264', 1), fixtures.clip('adts', 1), fixtures.clip('mjpeg', 1)]);
    frames = mjpegFrames(await readFile(mjpeg));
  }, 30_000);

  afterAll(async () => {
    await fixtures?.dispose();
  });

  function rawPair(): MultiSource {
    return new MultiSource([
      { input: createReadStream(h264), format: 'h264' },
      { input: createReadStream(aac), format: 'aac' },
    ]);
  }

  it('merges separate raw inputs into one source that feeds a relay', async () => {
    const relay = new Relay({ source: rawPair() });
    const indexes = new Set<number>();
    let info: StreamInfo | undefined;
    let firstVideo: boolean | undefined;

    await new Promise<void>((resolve, reject) => {
      relay.on('error', reject);
      relay.on('stop', resolve);
      relay.on('start', (started) => (info = started));
      relay.pipe(
        new CallbackSink({
          onPacket: (packet) => {
            indexes.add(packet.streamIndex);
            if (packet.streamIndex === 0) firstVideo ??= packet.isKeyframe;
          },
        }),
      );
    });

    expect(info?.tracks.map((track) => [track.index, track.kind, track.codec])).toEqual([
      [0, 'video', 'h264'],
      [1, 'audio', 'aac'],
    ]);
    expect([...indexes].sort()).toEqual([0, 1]);
    expect(firstVideo).toBe(true);
  });

  it('numbers the tracks of every input one after another', async () => {
    const source = new MultiSource([
      { input: createReadStream(h264), format: 'h264' },
      { input: createReadStream(aac), format: 'aac' },
      { input: h264, format: 'h264' },
    ]);
    const info = await source.open();
    try {
      expect(info.tracks.map((track) => [track.index, track.codec])).toEqual([
        [0, 'h264'],
        [1, 'aac'],
        [2, 'h264'],
      ]);
      const counts = new Map<number, number>();
      await drain(source, (packet) => {
        counts.set(packet.streamIndex, (counts.get(packet.streamIndex) ?? 0) + 1);
      });
      expect(counts.get(0)).toBe(15);
      expect(counts.get(2)).toBe(15);
      expect(counts.get(1)).toBeGreaterThan(40);
    } finally {
      await source.close();
    }
  });

  it('synthesizes a monotonic constant frame rate for raw video', async () => {
    const source = rawPair();
    await source.open();
    const pts: bigint[] = [];
    try {
      await drain(source, (packet) => {
        if (packet.streamIndex === 0 && packet.av) pts.push(packet.av.pts);
      });
    } finally {
      await source.close();
    }

    // annex-b h264 carries no timing, the 15 fps clip must come out in equal steps
    expect(pts.length).toBe(15);
    expect(pts.every((value) => value !== AV_NOPTS_VALUE)).toBe(true);
    const steps = pts.slice(1).map((value, i) => value - pts[i]);
    expect(steps.every((step) => step > 0n)).toBe(true);
    expect(new Set(steps.map(String)).size).toBe(1);
  });

  it('delivers everything to a slow consumer', async () => {
    const fast = rawPair();
    await fast.open();
    const total = await drain(fast);
    await fast.close();

    const slow = rawPair();
    await slow.open();
    try {
      expect(await drain(slow, () => delay(1))).toBe(total);
    } finally {
      await slow.close();
    }
  });

  it('stops its readers when the consumer leaves early', async () => {
    const source = new MultiSource([
      { input: h264, format: 'h264' },
      { input: aac, format: 'aac' },
    ]);
    await source.open();
    let seen = 0;
    for await (const packet of source.packets(new AbortController().signal)) {
      packet.free();
      if (++seen === 3) break;
    }
    const start = performance.now();
    await source.close();
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('fails the whole open when one input fails and closes the rest', async () => {
    const source = new MultiSource([
      { input: h264, format: 'h264' },
      { input: fixtures.path('missing.aac'), format: 'aac' },
    ]);
    await expect(source.open()).rejects.toThrow();
    await source.close();
  });

  it('aborts a pending open on close', async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    const source = new MultiSource([{ input: h264, format: 'h264' }, { input: `rtsp://127.0.0.1:${port}/hang` }]);
    try {
      const opening = source.open();
      await delay(100);
      await source.close();
      await expect(opening).rejects.toThrow();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reconnects an input that ended while the others keep running, its timeline skipping the gap', async () => {
    // a live MJPEG feed that never ends, mpjpeg would report the end of the bytes as a read error
    const feed = new PassThrough();
    const writing = (async () => {
      for (let i = 0; !feed.destroyed; i++) {
        feed.write(frames[i % frames.length]);
        await delay(40);
      }
    })();
    const warnings: string[] = [];
    const source = new MultiSource(
      [
        { input: feed, format: 'mpjpeg', wallclock: true },
        { input: aac, format: 'aac', reconnect: { delay: 50 } },
      ],
      { logger: { warn: (...args: unknown[]) => warnings.push(String(args[0])) } },
    );
    await source.open();
    const audio: number[] = [];
    let video = 0;
    try {
      for await (const packet of source.packets(new AbortController().signal)) {
        const av = packet.av;
        if (packet.streamIndex === 1 && av) audio.push((Number(av.pts) * av.timeBase.num * 1000) / av.timeBase.den);
        else video++;
        packet.free();
        if (warnings.length >= 2 && video >= 10) break;
      }
    } finally {
      await source.close();
      feed.destroy();
      await writing;
    }

    expect(warnings[0]).toContain('MultiSource input 1 ended, reconnecting in 50ms');
    const steps = audio.slice(1).map((pts, i) => pts - audio[i]);
    expect(steps.every((step) => step > 0)).toBe(true);
    // a file pass takes a few milliseconds of wall time, the backoff in between shows up in the timeline
    expect(Math.max(...steps)).toBeGreaterThanOrEqual(45);
  }, 15_000);

  it('dates what an input reads while reopening from the start of the reopen, so its timeline stays on the wallclock', async () => {
    const wav = await wavServer(1800);
    const warnings: string[] = [];
    // the explicit format keeps the probe short, what is left is the 64 KiB libav reads ahead
    const source = new MultiSource([{ input: wav.url, format: 'wav', reconnect: { delay: 20 } }], {
      logger: { warn: (...args: unknown[]) => warnings.push(String(args[0])) },
    });
    const packets: { offset: number; reopened: boolean }[] = [];
    let resumed: number | undefined;
    try {
      await source.open();
      for await (const packet of source.packets(new AbortController().signal)) {
        const av = packet.av;
        const at = performance.now();
        if (av) packets.push({ offset: (Number(av.pts) * av.timeBase.num * 1000) / av.timeBase.den - at, reopened: warnings.length > 0 });
        packet.free();
        if (warnings.length > 0) resumed ??= at;
        if (resumed !== undefined && at - resumed > 800) break;
      }
    } finally {
      await source.close();
      await wav.close();
    }

    expect(warnings[0]).toContain('MultiSource input 0 ended, reconnecting in 20ms');
    // the last packet of each pass arrived in real time, after the burst of what the open read ahead
    const before = packets.filter((packet) => !packet.reopened).at(-1);
    const after = packets.at(-1);
    expect(after?.reopened).toBe(true);
    expect(Math.abs((after?.offset ?? 0) - (before?.offset ?? 0))).toBeLessThan(150);
  }, 15_000);

  it('reconnects a stalled input after its timeout while the others keep delivering', async () => {
    const steady = await mjpegServer(frames);
    const flaky = await mjpegServer(frames, 3);
    const warnings: string[] = [];
    const source = new MultiSource(
      [
        { input: steady.url, format: 'mpjpeg', wallclock: true },
        { input: flaky.url, format: 'mpjpeg', wallclock: true, timeout: 300, reconnect: { delay: 20 } },
      ],
      { logger: { warn: (...args: unknown[]) => warnings.push(String(args[0])) } },
    );
    const arrivals: { track: number; at: number }[] = [];
    try {
      await source.open();
      for await (const packet of source.packets(new AbortController().signal)) {
        arrivals.push({ track: packet.streamIndex, at: performance.now() });
        packet.free();
        if (arrivals.filter((arrival) => arrival.track === 1).length >= 6) break;
      }
    } finally {
      await source.close();
      await Promise.all([steady.close(), flaky.close()]);
    }

    expect(flaky.connections()).toBe(2);
    expect(steady.connections()).toBe(1);
    expect(warnings.some((warning) => warning.includes('MultiSource input 1'))).toBe(true);
    const flakyFrames = arrivals.filter((arrival) => arrival.track === 1);
    const stalled = flakyFrames[2].at;
    const resumed = flakyFrames[3].at;
    expect(resumed - stalled).toBeGreaterThan(250);
    expect(arrivals.filter((arrival) => arrival.track === 0 && arrival.at > stalled && arrival.at < resumed).length).toBeGreaterThan(3);
  }, 15_000);

  it('fails as a whole once an input used up its retries', async () => {
    const vanishing = fixtures.path('vanishing.aac');
    await copyFile(aac, vanishing);
    const source = new MultiSource([
      { input: h264, format: 'h264' },
      { input: vanishing, format: 'aac', reconnect: { delay: 10, maxRetries: 1 } },
    ]);
    await source.open();
    try {
      let removed = false;
      await expect(
        drain(source, async (packet) => {
          if (packet.streamIndex !== 1 || removed) return;
          removed = true;
          await rm(vanishing);
        }),
      ).rejects.toThrow();
    } finally {
      await source.close();
    }
  });

  it('starts without an optional input that fails to open', async () => {
    const warnings: string[] = [];
    const source = new MultiSource(
      [
        { input: h264, format: 'h264' },
        { input: fixtures.path('missing.aac'), format: 'aac', optional: true },
      ],
      { logger: { warn: (...args: unknown[]) => warnings.push(String(args[0])) } },
    );
    try {
      const info = await source.open();
      expect(info.tracks.map((track) => [track.index, track.codec])).toEqual([[0, 'h264']]);
      expect(warnings[0]).toContain('MultiSource input 1 left out');
      expect(await drain(source)).toBe(15);
    } finally {
      await source.close();
    }
  });

  it('fails when no input opens, optional or not', async () => {
    const source = new MultiSource([
      { input: fixtures.path('missing.h264'), format: 'h264', optional: true },
      { input: fixtures.path('missing.aac'), format: 'aac', optional: true },
    ]);
    await expect(source.open()).rejects.toThrow();
    await source.close();
  });

  it('cuts back wallclock audio that a burst of buffered data keeps ahead', async () => {
    // the wav demuxer reads 64 KiB ahead while it opens, a second of this stream that then arrives at once
    const wav = await wavServer(Number.POSITIVE_INFINITY);
    const debug: string[] = [];
    const source = new MultiSource([{ input: wav.url, format: 'wav', wallclock: true }], {
      logger: { debug: (...args: unknown[]) => debug.push(String(args[0])) },
    });
    // how far each packet's timestamp is ahead of its arrival, both counted from the open
    const leads: { at: number; lead: number }[] = [];
    let first: number | undefined;
    try {
      const start = performance.now();
      await source.open();
      for await (const packet of source.packets(new AbortController().signal)) {
        const av = packet.av;
        const at = performance.now() - start;
        first ??= at;
        if (av) leads.push({ at, lead: (Number(av.pts) * av.timeBase.num * 1000) / av.timeBase.den - at });
        packet.free();
        // the lead shows over a second, the cut follows a second later
        if (at > first + 3800) break;
      }
    } finally {
      await source.close();
      await wav.close();
    }

    const opened = first ?? 0;
    expect(Math.max(...leads.filter((entry) => entry.at < opened + 500).map((entry) => entry.lead))).toBeGreaterThan(300);
    expect(debug.some((message) => message.includes('ahead of the wallclock'))).toBe(true);
    expect(Math.max(...leads.filter((entry) => entry.at > opened + 3200).map((entry) => entry.lead))).toBeLessThan(200);
    const steps = leads.slice(1).map((entry, i) => entry.lead + entry.at - (leads[i].lead + leads[i].at));
    expect(steps.every((step) => step > 0)).toBe(true);
  }, 15_000);

  it('refuses to reconnect a Readable', () => {
    expect(() => new MultiSource([{ input: new PassThrough(), format: 'h264', reconnect: true }])).toThrow(/Readable/);
  });

  it('needs at least one input and an open before packets', async () => {
    expect(() => new MultiSource([])).toThrow(/at least one input/);
    const source = new MultiSource([{ input: h264, format: 'h264' }]);
    await expect(drain(source)).rejects.toThrow(/open\(\) must be called/);
  });
});
