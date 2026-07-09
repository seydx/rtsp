import { describe, expect, it } from 'vitest';

import { SinkChannel } from '../sink-channel.js';
import { flush, PacketTracker } from './helpers/fake-source.js';

import type { MediaPacket, Sink } from '../types.js';

const NO_VIDEO = new Set<number>();

/** A sink whose write() resolves only when the test releases it. */
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
    // Release the writes one by one; the channel must deliver all of them.
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
    // The write is still pending — close() must not have completed yet.
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
    expect(channel.ready).toBe(false);
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
    // One write in flight; two more fill the queue, the next overflows it.
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false }));
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false }));
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();

    // Overflow re-gates: a delta frame is dropped, a keyframe reopens the gate.
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: false }));
    channel.offer(tracker.make({ streamIndex: 0, isKeyframe: true }));

    gated.release();
    await flush();
    gated.release();
    await flush();

    await channel.close();
    expect(tracker.live).toBe(0);
  });
});
