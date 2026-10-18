import { describe, expect, it } from 'vitest';

import { SinkChannel } from '../sink-channel.js';
import { flush, PacketTracker } from './helpers/fake-source.js';

import type { MediaPacket, Sink } from '../types.js';

const NO_VIDEO = new Set<number>();

// write() resolves only when the test releases it
function gatedSink(): { sink: Sink; written: MediaPacket[]; release: () => void; closed: () => boolean } {
  let closed = false;
  const written: MediaPacket[] = [];
  let releases: (() => void)[] = [];
  return {
    sink: {
      init: () => undefined,
      write: (packet: MediaPacket) => {
        written.push(packet);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
      close: () => {
        closed = true;
      },
    },
    written,
    release: () => {
      const pending = releases;
      releases = [];
      for (const r of pending) r();
    },
    closed: () => closed,
  };
}

describe('SinkChannel', () => {
  it('drainAndClose flushes the backlog before closing the sink', async () => {
    const tracker = new PacketTracker();
    const gated = gatedSink();
    const channel = new SinkChannel(gated.sink, { videoIndexes: NO_VIDEO, maxQueue: 16 });
    await channel.init({ tracks: [] });

    for (let i = 0; i < 3; i++) channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false }));

    const closing = channel.drainAndClose();
    for (let i = 0; i < 3; i++) {
      await flush();
      gated.release();
    }
    await closing;

    expect(gated.written.length).toBe(3);
    expect(gated.closed()).toBe(true);
    expect(tracker.live).toBe(0);
  });

  it('close() waits for the in-flight write before closing the sink', async () => {
    const tracker = new PacketTracker();
    const gated = gatedSink();
    const channel = new SinkChannel(gated.sink, { videoIndexes: NO_VIDEO, maxQueue: 16 });
    await channel.init({ tracks: [] });

    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();
    expect(gated.written.length).toBe(1);

    let closed = false;
    const closing = channel.close().then(() => (closed = true));
    await flush();
    expect(closed).toBe(false);
    expect(gated.closed()).toBe(false);

    gated.release();
    await closing;
    expect(gated.closed()).toBe(true);
    expect(tracker.live).toBe(0);
  });

  it('invokes onError and closes itself when a write fails', async () => {
    const tracker = new PacketTracker();
    const errors: unknown[] = [];
    const sink: Sink = {
      init: () => undefined,
      write: () => {
        throw new Error('write blew up');
      },
      close: () => undefined,
    };
    const channel = new SinkChannel(sink, {
      videoIndexes: NO_VIDEO,
      maxQueue: 16,
      onError: (_channel, error) => errors.push(error),
    });
    await channel.init({ tracks: [] });

    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();

    expect(errors).toHaveLength(1);
    expect(channel.accepts(tracker.make({ streamIndex: 0, isKeyframe: true }))).toBe(false);
    expect(tracker.live).toBe(1);
  });

  it('skips forward to the newest buffered keyframe on overflow instead of flushing', async () => {
    const tracker = new PacketTracker();
    const gated = gatedSink();
    const videoIndexes = new Set([0]);
    const channel = new SinkChannel(gated.sink, { videoIndexes, maxQueue: 4 });
    await channel.init({ tracks: [] });

    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: true }));
    await flush();
    expect(gated.written.length).toBe(1);

    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false })); // d1
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false })); // d2
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: true })); // KF1
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false })); // d3, queue full

    // the overflow skips to KF1 and frees d1 and d2, the gate stays open
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false })); // d4
    const probe = tracker.make({ streamIndex: 0, isKeyframe: false });
    expect(channel.accepts(probe)).toBe(true);
    probe.free();

    for (let i = 0; i < 5; i++) {
      gated.release();
      await flush();
    }

    // the first keyframe plus KF1, d3 and d4
    expect(gated.written.length).toBe(4);
    await channel.close();
    expect(tracker.live).toBe(0);
  });

  it('drops the backlog and re-gates on overflow', async () => {
    const tracker = new PacketTracker();
    const gated = gatedSink();
    const videoIndexes = new Set([0]);
    const channel = new SinkChannel(gated.sink, { videoIndexes, maxQueue: 2 });
    await channel.init({ tracks: [] });

    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: true }));
    await flush();
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false }));
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false }));
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();

    // the gate is closed again: a delta is dropped, a keyframe reopens it
    const delta = tracker.make({ streamIndex: 0, isKeyframe: false });
    expect(channel.accepts(delta)).toBe(false);
    channel.offer(delta);
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: true }));

    gated.release();
    await flush();
    gated.release();
    await flush();

    expect(gated.written.at(-1)?.isKeyframe).toBe(true);
    await channel.close();
    expect(tracker.live).toBe(0);
  });

  it('accepts nothing before init and closes itself when init fails', async () => {
    const tracker = new PacketTracker();
    const errors: unknown[] = [];
    let closed = 0;
    const sink: Sink = {
      init: () => {
        throw new Error('init failed');
      },
      write: () => undefined,
      close: () => {
        closed++;
      },
    };
    const channel = new SinkChannel(sink, { videoIndexes: NO_VIDEO, maxQueue: 4, onError: (_channel, error) => errors.push(error) });
    const packet = tracker.make({ streamIndex: 0, isKeyframe: true });
    expect(channel.accepts(packet)).toBe(false);

    await expect(channel.init({ tracks: [] })).resolves.toBeUndefined();
    await channel.init({ tracks: [] });
    expect(errors).toHaveLength(1);
    expect(closed).toBe(1);
    channel.offer(packet);
    expect(tracker.live).toBe(0);
  });

  it('gates video sinks on a keyframe of a video track', async () => {
    const tracker = new PacketTracker();
    const channel = new SinkChannel(gatedSink().sink, { videoIndexes: new Set([0]), maxQueue: 4 });
    await channel.init({ tracks: [] });
    const audio = tracker.make({ streamIndex: 1, isKeyframe: true });
    const delta = tracker.make({ streamIndex: 0, isKeyframe: false });
    const keyframe = tracker.make({ streamIndex: 0, isKeyframe: true });
    expect(channel.accepts(audio)).toBe(false);
    expect(channel.accepts(delta)).toBe(false);
    expect(channel.accepts(keyframe)).toBe(true);
    for (const packet of [audio, delta, keyframe]) packet.free();
  });
});
