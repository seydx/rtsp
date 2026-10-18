import { AV_NOPTS_VALUE } from 'node-av/constants';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Fixtures, hasFfmpeg } from '../../__tests__/helpers/media.js';
import { Relay } from '../../relay.js';
import { CallbackSink } from '../../sinks/callback.js';
import { MultiSource } from '../multi.js';

import type { Socket } from 'node:net';
import type { MediaPacket, StreamInfo } from '../../types.js';

const suite = hasFfmpeg ? describe : describe.skip;

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

  beforeAll(async () => {
    fixtures = await Fixtures.create();
    [h264, aac] = await Promise.all([fixtures.clip('h264', 1), fixtures.clip('adts', 1)]);
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
      await drain(source, (packet) => void counts.set(packet.streamIndex, (counts.get(packet.streamIndex) ?? 0) + 1));
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

  it('needs at least one input and an open before packets', async () => {
    expect(() => new MultiSource([])).toThrow(/at least one input/);
    const source = new MultiSource([{ input: h264, format: 'h264' }]);
    await expect(drain(source)).rejects.toThrow(/open\(\) must be called/);
  });
});
