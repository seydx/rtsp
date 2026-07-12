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

  it('tears down with an error when the running upstream goes silent past stallTimeout', async () => {
    const source = new FakeSource(AUDIO_ONLY);
    const tracker = new PacketTracker();
    const relay = new Relay({ source, stallTimeout: 120 });
    const errors: unknown[] = [];
    let stopped = false;
    relay.on('error', (e) => errors.push(e));
    relay.on('stop', () => (stopped = true));

    const c = collector();
    relay.pipe(c.sink);
    await flush();

    // A couple of packets flow, then the source wedges: no more packets, no end,
    // no error — the exact "session started but frames stopped" failure.
    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush(30);
    expect(relay.status).toBe('running');
    expect(errors).toHaveLength(0);

    // Within the stall window the watchdog aborts the pump, surfaces an error and stops.
    await flush(250);
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toMatch(/stalled/i);
    expect(stopped).toBe(true);
    expect(relay.status).toBe('idle');
    expect(source.closed).toBe(true);
    expect(tracker.live).toBe(0);
  });

  it('does not trip the stall watchdog while packets keep flowing', async () => {
    const source = new FakeSource(AUDIO_ONLY);
    const tracker = new PacketTracker();
    const relay = new Relay({ source, stallTimeout: 120 });
    const errors: unknown[] = [];
    relay.on('error', (e) => errors.push(e));

    const c = collector();
    relay.pipe(c.sink);
    await flush();

    // Deliver a packet every 40ms for ~300ms — comfortably under the 120ms
    // timeout each time, so the watchdog must never fire.
    for (let i = 0; i < 8; i++) {
      source.push(tracker.make({ streamIndex: 0, isKeyframe: i === 0 }));
      await flush(40);
    }

    expect(errors).toHaveLength(0);
    expect(relay.status).toBe('running');

    await relay.stop();
    expect(tracker.live).toBe(0);
  });

  it('does not crash the process when the source fails and no error listener exists', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const source = new FakeSource(AV_INFO, { failOpen: new Error('boom') });
      // No 'error' listener on purpose — must neither throw nor reject unhandled.
      const relay = new Relay({ source });
      const c = collector();
      relay.pipe(c.sink);
      await flush(20);

      expect(relay.status).toBe('idle');
      expect(c.closed).toBe(true);
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('does not leave an unhandled rejection behind on autoStart failure', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const source = new FakeSource(AV_INFO, { failOpen: new Error('boom') });
      const relay = new Relay({ source, autoStart: true });
      await flush(20);

      expect(relay.status).toBe('idle');
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('emits sink:error and isolates the sink when a write fails', async () => {
    const source = new FakeSource(AV_INFO);
    const tracker = new PacketTracker();
    const relay = new Relay({ source });
    const sinkErrors: { sink: unknown; error: unknown }[] = [];
    relay.on('sink:error', (sink, error) => sinkErrors.push({ sink, error }));

    const healthy = collector();
    const broken = new CallbackSink({
      onPacket: () => {
        throw new Error('write blew up');
      },
    });
    relay.pipe(healthy.sink);
    relay.pipe(broken);
    await flush();

    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();

    expect(sinkErrors).toHaveLength(1);
    expect(sinkErrors[0].sink).toBe(broken);
    expect(relay.sinkCount).toBe(1);
    // The healthy sink keeps receiving despite its broken sibling.
    expect(healthy.packets.length).toBe(2);
    expect(relay.status).toBe('running');
  });

  it('emits sink:error when a late-piped sink fails to init', async () => {
    const source = new FakeSource(AV_INFO);
    const relay = new Relay({ source });
    const sinkErrors: unknown[] = [];
    relay.on('sink:error', (_sink, error) => sinkErrors.push(error));

    const healthy = collector();
    relay.pipe(healthy.sink);
    await flush();
    expect(relay.status).toBe('running');

    const removed: unknown[] = [];
    relay.on('sink:removed', (sink) => removed.push(sink));
    const broken = new CallbackSink({
      onInit: () => {
        throw new Error('init blew up');
      },
    });
    relay.pipe(broken);
    await flush();

    expect(sinkErrors).toHaveLength(1);
    expect(removed).toContain(broken);
    expect(relay.status).toBe('running');
  });

  it('returns to idle when the only sink dies during startup init', async () => {
    const source = new FakeSource(AV_INFO);
    const relay = new Relay({ source });

    const broken = new CallbackSink({
      onInit: () => {
        throw new Error('init blew up');
      },
    });
    relay.pipe(broken);
    await flush(20);

    // The relay must not keep pumping a source nobody consumes.
    expect(relay.sinkCount).toBe(0);
    expect(relay.status).toBe('idle');
    expect(source.closeCount).toBe(1);
  });
});

describe('Relay stop/start races', () => {
  it('stop() during a pending start never lets the relay go running', async () => {
    const source = new FakeSource(AV_INFO, { openDelay: 20 });
    const relay = new Relay({ source });
    const errors: unknown[] = [];
    relay.on('error', (e) => errors.push(e));

    const started = relay.start();
    expect(relay.status).toBe('starting');
    await relay.stop();

    expect(relay.status).toBe('idle');
    // Let the delayed open() resolve — the relay must stay idle regardless.
    await flush(50);
    expect(relay.status).toBe('idle');

    // A deliberate stop is not an error, and the start promise must settle.
    await started.catch(() => undefined);
    expect(errors).toHaveLength(0);
  });

  it('can start again after a stop that interrupted a pending start', async () => {
    const source = new FakeSource(AV_INFO, { openDelay: 10 });
    const relay = new Relay({ source });

    void relay.start().catch(() => undefined);
    await relay.stop();
    await flush(30);

    const c = collector();
    relay.pipe(c.sink);
    await flush(30);

    expect(relay.status).toBe('running');
    expect(c.inited).toEqual(AV_INFO);
    await relay.stop();
  });
});
