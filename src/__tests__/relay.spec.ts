import { afterEach, describe, expect, it } from 'vitest';

import { Relay } from '../relay.js';
import { CallbackSink } from '../sinks/callback.js';
import { FakeSource, flush, PacketTracker } from './helpers/fake-source.js';

import type { MediaPacket, Sink, StreamInfo } from '../types.js';

const AV_INFO: StreamInfo = {
  tracks: [
    { index: 0, kind: 'video', codec: 'h264' },
    { index: 1, kind: 'audio', codec: 'aac' },
  ],
};

const AUDIO_ONLY: StreamInfo = { tracks: [{ index: 0, kind: 'audio', codec: 'aac' }] };

const relays: Relay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
});

function createRelay(...args: ConstructorParameters<typeof Relay>): Relay {
  const relay = new Relay(...args);
  relays.push(relay);
  return relay;
}

function collector(options: { slow?: number } = {}) {
  const packets: MediaPacket[] = [];
  const state = { info: undefined as StreamInfo | undefined, closed: false, inits: 0 };
  const sink = new CallbackSink({
    onInit: (info) => {
      state.info = info;
      state.inits++;
    },
    onPacket: async (packet) => {
      packets.push(packet);
      if (options.slow) await flush(options.slow);
    },
    onClose: () => {
      state.closed = true;
    },
  });
  return { sink, packets, state };
}

describe('Relay lifecycle', () => {
  it('opens the source for the first sink and closes it after the last one left', async () => {
    const source = new FakeSource(AV_INFO);
    const relay = createRelay({ source });
    expect(relay.status).toBe('idle');

    const c = collector();
    relay.pipe(c.sink);
    await flush();
    expect(source.openCount).toBe(1);
    expect(relay.status).toBe('running');
    expect(relay.info).toEqual(AV_INFO);
    expect(c.state.info).toEqual(AV_INFO);

    await relay.unpipe(c.sink);
    await flush();
    expect(source.closeCount).toBe(1);
    expect(relay.status).toBe('idle');
    expect(relay.info).toBeUndefined();
    expect(c.state.closed).toBe(true);
  });

  it('holds one upstream connection for many sinks', async () => {
    const source = new FakeSource(AV_INFO);
    const relay = createRelay({ source });
    for (let i = 0; i < 3; i++) relay.pipe(collector().sink);
    await flush();
    expect(source.openCount).toBe(1);
    expect(relay.sinkCount).toBe(3);
  });

  it('keeps the upstream open for idleTimeout after the last sink left', async () => {
    const source = new FakeSource(AV_INFO);
    const relay = createRelay({ source, idleTimeout: 50 });
    const c = collector();
    relay.pipe(c.sink);
    await flush();
    await relay.unpipe(c.sink);
    expect(relay.status).toBe('running');

    await flush(80);
    expect(relay.status).toBe('idle');
    expect(source.closeCount).toBe(1);
  });

  it('reuses the running upstream when a sink returns within idleTimeout', async () => {
    const source = new FakeSource(AV_INFO);
    const relay = createRelay({ source, idleTimeout: 50 });
    const first = collector();
    relay.pipe(first.sink);
    await flush();
    await relay.unpipe(first.sink);

    relay.pipe(collector().sink);
    await flush(80);
    expect(relay.status).toBe('running');
    expect(source.openCount).toBe(1);
  });

  it('opens right away with autoStart and stays up without sinks', async () => {
    const source = new FakeSource(AV_INFO);
    const relay = createRelay({ source, autoStart: true });
    await flush(20);
    expect(relay.status).toBe('running');
    expect(source.openCount).toBe(1);
  });

  it('emits sink:added and sink:removed', async () => {
    const relay = createRelay({ source: new FakeSource(AV_INFO) });
    const events: string[] = [];
    relay.on('sink:added', () => events.push('added'));
    relay.on('sink:removed', () => events.push('removed'));
    const c = collector();
    relay.pipe(c.sink);
    await flush();
    await relay.unpipe(c.sink);
    expect(events).toEqual(['added', 'removed']);
  });

  it('ignores unpipe of an unknown sink', async () => {
    const relay = createRelay({ source: new FakeSource(AV_INFO) });
    await expect(relay.unpipe(collector().sink)).resolves.toBeUndefined();
  });
});

describe('Relay start and stop races', () => {
  it('restarts for a sink piped while the previous cycle is stopping', async () => {
    const source = new FakeSource(AV_INFO, { closeDelay: 30 });
    const tracker = new PacketTracker();
    const relay = createRelay({ source });

    const first = collector();
    relay.pipe(first.sink);
    await flush();
    relay.unpipe(first.sink);
    await flush(5);
    expect(relay.status).toBe('stopping');

    const second = collector();
    relay.pipe(second.sink);
    await flush(60);
    expect(relay.status).toBe('running');
    expect(source.openCount).toBe(2);
    expect(second.state.inits).toBe(1);

    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    await flush();
    expect(second.packets).toHaveLength(1);
  });

  it('shares one teardown between concurrent stop calls', async () => {
    const source = new FakeSource(AV_INFO, { closeDelay: 20 });
    const relay = createRelay({ source });
    let stops = 0;
    relay.on('stop', () => stops++);
    relay.pipe(collector().sink);
    await flush();

    const first = relay.stop();
    const second = relay.stop();
    await second;
    expect(relay.status).toBe('idle');
    await first;
    expect(stops).toBe(1);
    expect(source.closeCount).toBe(1);
  });

  it('never goes running after a stop during a pending start', async () => {
    const source = new FakeSource(AV_INFO, { openDelay: 20 });
    const relay = createRelay({ source });
    const errors: unknown[] = [];
    relay.on('error', (error) => errors.push(error));

    const started = relay.start();
    expect(relay.status).toBe('starting');
    await relay.stop();
    expect(relay.status).toBe('idle');

    await flush(50);
    expect(relay.status).toBe('idle');
    await started;
    expect(errors).toHaveLength(0);
    // the open finished after the teardown, the relay closes it again
    expect(source.opened).toBe(false);
  });

  it('starts again after a stop that interrupted a start', async () => {
    const source = new FakeSource(AV_INFO, { openDelay: 10 });
    const relay = createRelay({ source });
    relay.start();
    await relay.stop();
    await flush(30);

    const c = collector();
    relay.pipe(c.sink);
    await flush(30);
    expect(relay.status).toBe('running');
    expect(c.state.info).toEqual(AV_INFO);
  });

  it('shares one start between concurrent start calls', async () => {
    const source = new FakeSource(AV_INFO, { openDelay: 10 });
    const relay = createRelay({ source });
    await Promise.all([relay.start(), relay.start(), relay.start()]);
    expect(source.openCount).toBe(1);
    expect(relay.status).toBe('running');
  });
});

describe('Relay upstream end', () => {
  it('writes the backlog of every sink, then emits end and stop', async () => {
    const source = new FakeSource(AUDIO_ONLY);
    const tracker = new PacketTracker();
    const relay = createRelay({ source });
    const events: string[] = [];
    relay.on('end', () => events.push('end'));
    relay.on('stop', () => events.push('stop'));

    const slow = collector({ slow: 5 });
    relay.pipe(slow.sink);
    await flush();
    for (let i = 0; i < 5; i++) source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    source.end();
    await flush(80);

    expect(slow.packets).toHaveLength(5);
    expect(slow.state.closed).toBe(true);
    expect(events).toEqual(['end', 'stop']);
    expect(relay.status).toBe('idle');
    expect(tracker.live).toBe(0);
  });

  it('emits error and stops when the running upstream fails', async () => {
    const source = new FakeSource(AUDIO_ONLY);
    const relay = createRelay({ source });
    const errors: unknown[] = [];
    relay.on('error', (error) => errors.push(error));
    relay.pipe(collector().sink);
    await flush();

    source.fail(new Error('connection reset'));
    await flush(20);
    expect(errors).toHaveLength(1);
    expect(relay.status).toBe('idle');
    expect(source.closed).toBe(true);
  });
});

describe('Relay keyframe gating', () => {
  it('holds a video sink back until the next keyframe', async () => {
    const source = new FakeSource(AV_INFO);
    const tracker = new PacketTracker();
    const relay = createRelay({ source });
    const c = collector();
    relay.pipe(c.sink);
    await flush();

    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    source.push(tracker.make({ streamIndex: 1, isKeyframe: true }));
    await flush();
    expect(c.packets).toHaveLength(0);

    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    source.push(tracker.make({ streamIndex: 1, isKeyframe: true }));
    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();
    expect(c.packets.map((packet) => [packet.streamIndex, packet.isKeyframe])).toEqual([
      [0, true],
      [1, true],
      [0, false],
    ]);
  });

  it('does not gate audio-only sources', async () => {
    const source = new FakeSource(AUDIO_ONLY);
    const tracker = new PacketTracker();
    const relay = createRelay({ source });
    const c = collector();
    relay.pipe(c.sink);
    await flush();

    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();
    expect(c.packets).toHaveLength(2);
  });

  it('gates a late sink independently of the established ones', async () => {
    const source = new FakeSource(AV_INFO);
    const tracker = new PacketTracker();
    const relay = createRelay({ source });
    const early = collector();
    relay.pipe(early.sink);
    await flush();
    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();

    const late = collector();
    relay.pipe(late.sink);
    await flush();
    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();
    expect(late.packets).toHaveLength(0);
    expect(early.packets).toHaveLength(3);

    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    await flush();
    expect(late.packets).toHaveLength(1);
    expect(early.packets).toHaveLength(4);
  });
});

describe('Relay packet ownership', () => {
  it('hands the original packet to a single sink without cloning', async () => {
    const source = new FakeSource(AV_INFO);
    const tracker = new PacketTracker();
    const relay = createRelay({ source });
    const c = collector();
    relay.pipe(c.sink);
    await flush();

    const packet = tracker.make({ streamIndex: 0, isKeyframe: true });
    source.push(packet);
    await flush();
    expect(c.packets[0]).toBe(packet);
    expect(tracker.created).toBe(1);
  });

  it('clones only for sinks that accept the packet', async () => {
    const source = new FakeSource(AV_INFO);
    const tracker = new PacketTracker();
    const relay = createRelay({ source });
    const a = collector();
    relay.pipe(a.sink);
    await flush();
    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    await flush();

    // b waits for a keyframe, so the delta frames cost no clone
    const b = collector();
    relay.pipe(b.sink);
    await flush();
    for (let i = 0; i < 3; i++) source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();
    expect(tracker.created).toBe(4);

    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    await flush();
    expect(tracker.created).toBe(6);
    expect(b.packets).toHaveLength(1);
  });

  it('frees every packet it cloned or dropped', async () => {
    const source = new FakeSource(AV_INFO);
    const tracker = new PacketTracker();
    const relay = createRelay({ source });
    relay.pipe(collector().sink);
    relay.pipe(collector().sink);
    await flush();

    for (let i = 0; i < 10; i++) source.push(tracker.make({ streamIndex: 0, isKeyframe: i === 0, pts: i }));
    await flush();
    await relay.stop();
    expect(tracker.live).toBe(0);
    expect(tracker.created).toBeGreaterThan(10);
  });
});

describe('Relay error handling', () => {
  it('emits error and stays idle when the source fails to open', async () => {
    const relay = createRelay({ source: new FakeSource(AV_INFO, { failOpen: new Error('boom') }) });
    const errors: unknown[] = [];
    relay.on('error', (error) => errors.push(error));
    const c = collector();
    relay.pipe(c.sink);
    await flush();
    expect(relay.status).toBe('idle');
    expect(errors).toHaveLength(1);
    expect(c.state.closed).toBe(true);
  });

  it('rejects start() when the source fails to open', async () => {
    const relay = createRelay({ source: new FakeSource(AV_INFO, { failOpen: new Error('boom') }) });
    await expect(relay.start()).rejects.toThrow('boom');
  });

  it('stops with an error when the upstream stalls past stallTimeout', async () => {
    const source = new FakeSource(AUDIO_ONLY);
    const tracker = new PacketTracker();
    const relay = createRelay({ source, stallTimeout: 120 });
    const errors: unknown[] = [];
    let stopped = false;
    relay.on('error', (error) => errors.push(error));
    relay.on('stop', () => (stopped = true));
    relay.pipe(collector().sink);
    await flush();

    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    await flush(30);
    expect(relay.status).toBe('running');

    await flush(300);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toMatch(/stalled/);
    expect(stopped).toBe(true);
    expect(relay.status).toBe('idle');
    expect(tracker.live).toBe(0);
  });

  it('keeps running while packets arrive within stallTimeout', async () => {
    const source = new FakeSource(AUDIO_ONLY);
    const tracker = new PacketTracker();
    const relay = createRelay({ source, stallTimeout: 120 });
    const errors: unknown[] = [];
    relay.on('error', (error) => errors.push(error));
    relay.pipe(collector().sink);
    await flush();

    for (let i = 0; i < 8; i++) {
      source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
      await flush(40);
    }
    expect(errors).toHaveLength(0);
    expect(relay.status).toBe('running');
  });

  it('leaves no unhandled rejection without an error listener', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      createRelay({ source: new FakeSource(AV_INFO, { failOpen: new Error('boom') }) }).pipe(collector().sink);
      createRelay({ source: new FakeSource(AV_INFO, { failOpen: new Error('boom') }), autoStart: true });
      await flush(20);
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('isolates a sink whose write fails', async () => {
    const source = new FakeSource(AV_INFO);
    const tracker = new PacketTracker();
    const relay = createRelay({ source });
    const failures: Sink[] = [];
    relay.on('sink:error', (sink) => failures.push(sink));

    const healthy = collector();
    const broken = new CallbackSink({
      onPacket: () => {
        throw new Error('write failed');
      },
    });
    relay.pipe(healthy.sink);
    relay.pipe(broken);
    await flush();

    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    source.push(tracker.make({ streamIndex: 0, isKeyframe: false }));
    await flush();
    expect(failures).toEqual([broken]);
    expect(relay.sinkCount).toBe(1);
    expect(healthy.packets).toHaveLength(2);
    expect(relay.status).toBe('running');
  });

  it('detaches a late sink whose init fails', async () => {
    const relay = createRelay({ source: new FakeSource(AV_INFO) });
    const failures: unknown[] = [];
    const removed: Sink[] = [];
    relay.on('sink:error', (_sink, error) => failures.push(error));
    relay.on('sink:removed', (sink) => removed.push(sink));
    relay.pipe(collector().sink);
    await flush();

    const broken = new CallbackSink({
      onInit: () => {
        throw new Error('init failed');
      },
    });
    relay.pipe(broken);
    await flush();
    expect(failures).toHaveLength(1);
    expect(removed).toContain(broken);
    expect(relay.status).toBe('running');
  });

  it('returns to idle when every sink fails during the start', async () => {
    const source = new FakeSource(AV_INFO);
    const relay = createRelay({ source });
    relay.pipe(
      new CallbackSink({
        onInit: () => {
          throw new Error('init failed');
        },
      }),
    );
    await flush(20);
    expect(relay.sinkCount).toBe(0);
    expect(relay.status).toBe('idle');
    expect(source.closeCount).toBe(1);
  });

  it('returns to idle when the only sink leaves during the start', async () => {
    const source = new FakeSource(AV_INFO, { openDelay: 10 });
    const relay = createRelay({ source });
    const c = collector();
    relay.pipe(c.sink);
    await relay.unpipe(c.sink);
    await flush(30);
    expect(relay.status).toBe('idle');
  });
});
