import { describe, expect, it } from 'vitest';

import { Relay } from '../relay.js';
import { CallbackSink } from '../sinks/callback.js';
import { FakeSource, flush, PacketTracker } from './helpers/fake-source.js';

import type { MediaPacket, StreamInfo } from '../types.js';

const AV_INFO: StreamInfo = {
  tracks: [
    { index: 0, kind: 'video', codec: 'h264' },
    { index: 1, kind: 'audio', codec: 'aac' },
  ],
};

const AUDIO_ONLY: StreamInfo = {
  tracks: [{ index: 0, kind: 'audio', codec: 'aac' }],
};

function collector() {
  const packets: MediaPacket[] = [];
  let inited: StreamInfo | undefined;
  let closed = false;
  const sink = new CallbackSink({
    onInit: (info) => {
      inited = info;
    },
    onPacket: (p) => {
      packets.push(p);
    },
    onClose: () => {
      closed = true;
    },
  });
  return {
    sink,
    packets,
    get inited() {
      return inited;
    },
    get closed() {
      return closed;
    },
  };
}

describe('Relay lifecycle', () => {
  it('lazily opens the source on the first sink and closes when the last leaves', async () => {
    const source = new FakeSource(AV_INFO);
    const relay = new Relay({ source });

    expect(relay.status).toBe('idle');
    expect(source.openCount).toBe(0);

    const c = collector();
    relay.pipe(c.sink);
    await flush();

    expect(source.openCount).toBe(1);
    expect(relay.status).toBe('running');
    expect(c.inited).toEqual(AV_INFO);

    await relay.unpipe(c.sink);
    await flush();

    expect(source.closeCount).toBe(1);
    expect(relay.status).toBe('idle');
    expect(c.closed).toBe(true);
  });

  it('keeps a single upstream connection for many sinks', async () => {
    const source = new FakeSource(AV_INFO);
    const relay = new Relay({ source });

    const a = collector();
    const b = collector();
    const cc = collector();
    relay.pipe(a.sink);
    relay.pipe(b.sink);
    relay.pipe(cc.sink);
    await flush();

    expect(source.openCount).toBe(1);
    expect(relay.sinkCount).toBe(3);
  });

  it('respects idleTimeout before tearing down', async () => {
    const source = new FakeSource(AV_INFO);
    const relay = new Relay({ source, idleTimeout: 50 });

    const c = collector();
    relay.pipe(c.sink);
    await flush();
    await relay.unpipe(c.sink);

    // Still alive immediately after the last sink leaves.
    expect(relay.status).toBe('running');

    await flush(80);
    expect(relay.status).toBe('idle');
    expect(source.closeCount).toBe(1);
  });
});

describe('Relay keyframe gating', () => {
  it('mutes a video sink until the next keyframe', async () => {
    const source = new FakeSource(AV_INFO);
    const tracker = new PacketTracker();
    const relay = new Relay({ source });

    const c = collector();
    relay.pipe(c.sink);
    await flush();

    // Pre-roll: delta video + audio before any keyframe — all dropped.
    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    source.push(tracker.make({ streamIndex: 1, isKeyframe: true }));
    await flush();
    expect(c.packets.length).toBe(0);

    // Keyframe opens the gate; subsequent packets flow.
    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    source.push(tracker.make({ streamIndex: 1, isKeyframe: true }));
    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();

    expect(c.packets.map((p) => [p.streamIndex, p.isKeyframe])).toEqual([
      [0, true],
      [1, true],
      [0, false],
    ]);
  });

  it('delivers immediately for audio-only sources (no keyframe gate)', async () => {
    const source = new FakeSource(AUDIO_ONLY);
    const tracker = new PacketTracker();
    const relay = new Relay({ source });

    const c = collector();
    relay.pipe(c.sink);
    await flush();

    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();

    expect(c.packets.length).toBe(2);
  });

  it('gates a late joiner independently of established sinks', async () => {
    const source = new FakeSource(AV_INFO);
    const tracker = new PacketTracker();
    const relay = new Relay({ source });

    const early = collector();
    relay.pipe(early.sink);
    await flush();

    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();
    expect(early.packets.length).toBe(2);

    // Late joiner mid-GOP — must wait for the next keyframe.
    const late = collector();
    relay.pipe(late.sink);
    await flush();

    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();
    expect(late.packets.length).toBe(0);
    expect(early.packets.length).toBe(3);

    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    await flush();
    expect(late.packets.length).toBe(1);
    expect(early.packets.length).toBe(4);
  });
});

describe('Relay packet ownership', () => {
  it('frees every packet it clones and drops (no leaks)', async () => {
    const source = new FakeSource(AV_INFO);
    const tracker = new PacketTracker();
    const relay = new Relay({ source });

    const a = collector();
    const b = collector();
    relay.pipe(a.sink);
    relay.pipe(b.sink);
    await flush();

    for (let i = 0; i < 10; i++) {
      source.push(tracker.make({ streamIndex: 0, isKeyframe: i === 0, pts: i }));
    }
    await flush();

    await relay.stop();
    await flush();

    expect(tracker.live).toBe(0);
    expect(tracker.totalCreated).toBeGreaterThan(0);
  });
});

describe('Relay error handling', () => {
  it('emits error and stays idle when the source fails to open', async () => {
    const source = new FakeSource(AV_INFO, { failOpen: new Error('boom') });
    const relay = new Relay({ source });
    const errors: unknown[] = [];
    relay.on('error', (e) => errors.push(e));

    const c = collector();
    relay.pipe(c.sink);
    await flush();

    expect(relay.status).toBe('idle');
    expect(errors).toHaveLength(1);
  });
});
