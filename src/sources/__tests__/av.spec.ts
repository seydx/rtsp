import { Decoder } from 'node-av/api';
import { AV_CODEC_ID_H264 } from 'node-av/constants';
import { createReadStream } from 'node:fs';
import { copyFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Fixtures, hasFfmpeg } from '../../__tests__/helpers/media.js';
import { Relay } from '../../relay.js';
import { CallbackSink } from '../../sinks/callback.js';
import { AvSource } from '../av.js';

import type { Server, Socket } from 'node:net';
import type { MediaPacket } from '../../types.js';

const suite = hasFfmpeg ? describe : describe.skip;

// accepts RTSP connections and never answers, like a camera that hangs
async function silentServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `rtsp://user:hunter2@127.0.0.1:${port}/stream`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function collect(source: AvSource, limit: number, onPacket?: (packet: MediaPacket, count: number) => void | Promise<void>): Promise<MediaPacket[]> {
  const seen: MediaPacket[] = [];
  const controller = new AbortController();
  try {
    for await (const packet of source.packets(controller.signal)) {
      seen.push({ ...packet, av: undefined, clone: () => packet, free: () => undefined });
      await onPacket?.(packet, seen.length);
      packet.free();
      if (seen.length >= limit) break;
    }
  } finally {
    controller.abort();
  }
  return seen;
}

function expectMonotonic(packets: MediaPacket[]): void {
  const last = new Map<number, number>();
  for (const packet of packets) {
    const ts = packet.dts ?? packet.pts;
    if (ts === undefined) continue;
    const previous = last.get(packet.streamIndex);
    if (previous !== undefined) expect(ts).toBeGreaterThanOrEqual(previous);
    last.set(packet.streamIndex, ts);
  }
}

suite('AvSource', () => {
  let fixtures: Fixtures;
  let av: string;

  beforeAll(async () => {
    fixtures = await Fixtures.create();
    av = await fixtures.clip('av', 1);
  }, 30_000);

  afterAll(async () => {
    await fixtures?.dispose();
  });

  it('describes video and audio tracks', async () => {
    const source = new AvSource(av);
    const info = await source.open();
    await source.close();

    expect(info.tracks.map((track) => [track.kind, track.codec])).toEqual([
      ['video', 'h264'],
      ['audio', 'aac'],
    ]);
    expect(info.tracks[0].native).toBeDefined();
    expect(info.tracks[0].timeBase?.den).toBeGreaterThan(0);
    expect(info.backchannel).toBeUndefined();
  });

  it('feeds a relay that starts at a keyframe', async () => {
    const relay = new Relay({ source: new AvSource(av) });
    const seen: { index: number; keyframe: boolean; native: boolean }[] = [];
    await new Promise<void>((resolve, reject) => {
      relay.on('stop', resolve);
      relay.on('error', reject);
      relay.pipe(new CallbackSink({ onPacket: (packet) => void seen.push({ index: packet.streamIndex, keyframe: packet.isKeyframe, native: packet.av !== undefined }) }));
    });

    expect(seen.length).toBeGreaterThan(20);
    expect(seen.every((packet) => packet.native)).toBe(true);
    expect(seen.find((packet) => packet.index === 0)?.keyframe).toBe(true);
  });

  it('reads Buffer and Readable inputs', async () => {
    const fromBuffer = new AvSource(await readFile(av));
    await fromBuffer.open();
    expect((await collect(fromBuffer, 1000)).length).toBeGreaterThan(20);
    await fromBuffer.close();

    const fromStream = new AvSource(createReadStream(await fixtures.clip('h264', 1)), { format: 'h264' });
    const info = await fromStream.open();
    expect(info.tracks.map((track) => track.codec)).toEqual(['h264']);
    const packets = await collect(fromStream, 1000);
    expect(packets.length).toBe(15);
    expectMonotonic(packets);
    await fromStream.close();
  });

  it('keeps timestamps monotonic across loop passes', async () => {
    // every pass reopens the file and its clock restarts at zero
    const source = new AvSource(av, { loop: true });
    await source.open();
    try {
      // about 62 packets per pass, so this spans three boundaries
      const packets = await collect(source, 200);
      expect(packets.filter((packet) => packet.streamIndex === 0).length).toBeGreaterThan(45);
      expectMonotonic(packets);
    } finally {
      await source.close();
    }
  }, 15_000);

  it('keeps the native streams usable across reopens', async () => {
    // sinks may open decoders from them long after the first pass was closed
    const source = new AvSource(av, { loop: true });
    const info = await source.open();
    try {
      await collect(source, 150);
      const native = info.tracks[0].native!;
      expect(native.codecpar.codecId).toBe(AV_CODEC_ID_H264);
      expect([native.codecpar.width, native.codecpar.height]).toEqual([320, 240]);
      const decoder = Decoder.createSync(native);
      decoder.close();
    } finally {
      await source.close();
    }
  }, 15_000);

  it('paces reading with readrate', async () => {
    const source = new AvSource(av, { readrate: 2 });
    await source.open();
    const start = performance.now();
    await collect(source, 1000);
    await source.close();
    // a 1s clip at twice the speed
    expect(performance.now() - start).toBeGreaterThan(350);
  });

  it('refuses to loop or reconnect a Readable', () => {
    expect(() => new AvSource(new PassThrough(), { loop: true })).toThrow(/Readable/);
    expect(() => new AvSource(new PassThrough(), { reconnect: true })).toThrow(/Readable/);
  });

  it('needs open before packets', async () => {
    const source = new AvSource(av);
    await expect(collect(source, 1)).rejects.toThrow(/open\(\) must be called/);
  });

  it('reconnects when the input ends', async () => {
    const warnings: unknown[] = [];
    const source = new AvSource(av, { reconnect: { delay: 20 }, logger: { warn: (...args: unknown[]) => warnings.push(args[0]) } });
    await source.open();
    try {
      const packets = await collect(source, 100);
      expect(packets.length).toBe(100);
      expectMonotonic(packets);
      expect(warnings.some((warning) => String(warning).includes('input ended, reconnecting in 20ms'))).toBe(true);
    } finally {
      await source.close();
    }
  }, 15_000);

  it('gives up after maxRetries failed reopens', async () => {
    const file = fixtures.path('vanishing.mp4');
    await copyFile(av, file);
    const warnings: string[] = [];
    const logger = { warn: (...args: unknown[]) => warnings.push(String(args[0])) };
    const source = new AvSource(file, { reconnect: { delay: 10, maxDelay: 20, maxRetries: 2 }, logger });
    await source.open();
    try {
      await expect(
        collect(source, 10_000, async (_packet, count) => {
          if (count === 1) await rm(file);
        }),
      ).rejects.toThrow();
      expect(warnings.filter((warning) => warning.includes('reopen failed, retrying in')).length).toBe(1);
    } finally {
      await source.close();
    }
  }, 15_000);

  it('fails when a reopened input changed its layout', async () => {
    const file = fixtures.path('swapped.mp4');
    await copyFile(av, file);
    const videoOnly = await fixtures.clip('video', 1);
    const source = new AvSource(file, { reconnect: { delay: 10 } });
    await source.open();
    try {
      await expect(
        collect(source, 10_000, async (_packet, count) => {
          if (count === 1) await copyFile(videoOnly, file);
        }),
      ).rejects.toThrow(/stream layout/);
    } finally {
      await source.close();
    }
  }, 15_000);

  it('aborts a hanging open on close', async () => {
    const server = await silentServer();
    const source = new AvSource(server.url);
    try {
      const opening = source.open();
      await delay(100);
      const start = performance.now();
      await source.close();
      await expect(opening).rejects.toThrow();
      expect(performance.now() - start).toBeLessThan(2000);
    } finally {
      await server.close();
    }
  });

  it('applies timeout in milliseconds', async () => {
    const server = await silentServer();
    const source = new AvSource(server.url, { timeout: 300 });
    const start = performance.now();
    try {
      await expect(source.open()).rejects.toThrow();
      expect(performance.now() - start).toBeLessThan(3000);
    } finally {
      await source.close();
      await server.close();
    }
  });

  it('masks credentials in its logs', async () => {
    const server = await silentServer();
    const lines: string[] = [];
    const source = new AvSource(server.url, { logger: { debug: (...args: unknown[]) => lines.push(args.map(String).join(' ')) } });
    try {
      const opening = source.open().catch(() => undefined);
      await delay(50);
      await source.close();
      await opening;
      expect(lines.join('\n')).toContain('rtsp://***@127.0.0.1');
      expect(lines.join('\n')).not.toContain('hunter2');
    } finally {
      await server.close();
    }
  });

  it('stamps a live MJPEG feed with arrival times on a fine clock', async () => {
    const data = await readFile(await fixtures.clip('mjpeg', 1));
    const feed = new PassThrough();
    const source = new AvSource(feed, { format: 'mpjpeg', wallclock: true });

    // deliver the 15 frames over about a second, as a camera would
    const chunks = 30;
    const size = Math.ceil(data.length / chunks);
    const writing = (async () => {
      for (let i = 0; i < chunks; i++) {
        feed.write(data.subarray(i * size, (i + 1) * size));
        await delay(33);
      }
      feed.end();
    })();

    try {
      const info = await source.open();
      expect(info.tracks[0].timeBase).toEqual({ num: 1, den: 90_000 });
      const pts: number[] = [];
      // mpjpeg reports the end of the feed as invalid data
      await collect(source, 1000, (packet) => void pts.push(packet.pts!)).catch(() => undefined);
      await writing;

      expect(pts.length).toBeGreaterThan(8);
      for (let i = 1; i < pts.length; i++) expect(pts[i]).toBeGreaterThan(pts[i - 1]);
      // arrival times spread over the feed instead of collapsing onto one instant
      expect((pts[pts.length - 1] - pts[0]) / 90_000).toBeGreaterThan(0.4);
    } finally {
      await source.close();
    }
  }, 15_000);
});
