import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { grabFrame } from '../grab-frame.js';
import { Relay } from '../relay.js';
import { CallbackSink } from '../sinks/callback.js';
import { AvSource } from '../sources/av.js';
import { FakeSource, flush, PacketTracker } from './helpers/fake-source.js';
import { Fixtures, hasFfmpeg, until } from './helpers/media.js';

import type { StreamInfo } from '../types.js';

const VIDEO_INFO: StreamInfo = { tracks: [{ index: 0, kind: 'video', codec: 'mjpeg' }] };
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

describe('grabFrame', () => {
  it('gives up after the timeout and detaches', async () => {
    const relay = createRelay({ source: new FakeSource(VIDEO_INFO) });
    await expect(grabFrame(relay, { timeout: 50 })).rejects.toThrow('no frame within 50ms');
    await flush(10);
    expect(relay.status).toBe('idle');
  });

  it('reports why the upstream failed to open', async () => {
    const relay = createRelay({ source: new FakeSource(VIDEO_INFO, { failOpen: new Error('camera unreachable') }) });
    await expect(grabFrame(relay)).rejects.toThrow('camera unreachable');
  });

  it('needs a video track or an existing track index', async () => {
    await expect(grabFrame(createRelay({ source: new FakeSource(AUDIO_ONLY) }))).rejects.toThrow('no video track');
    await expect(grabFrame(createRelay({ source: new FakeSource(VIDEO_INFO) }), { track: 3 })).rejects.toThrow('no track 3');
  });

  it('rejects a frame without data and leaves no packet behind', async () => {
    const tracker = new PacketTracker();
    const source = new FakeSource(VIDEO_INFO);
    const relay = createRelay({ source });
    const grab = grabFrame(relay);
    await flush(10);
    source.push(tracker.make({ streamIndex: 0, isKeyframe: true }));
    await expect(grab).rejects.toThrow('carries no data');
    await flush(10);
    expect(tracker.live).toBe(0);
  });
});

const suite = hasFfmpeg ? describe : describe.skip;

suite('grabFrame from a real source', () => {
  let fixtures: Fixtures;
  let mjpeg: string;

  beforeAll(async () => {
    fixtures = await Fixtures.create();
    mjpeg = await fixtures.clip('mjpeg', 1);
  }, 30_000);

  afterAll(async () => {
    await fixtures?.dispose();
  });

  it('returns a complete JPEG of an MJPEG source and closes the upstream again', async () => {
    const relay = createRelay({ source: new AvSource(mjpeg, { format: 'mpjpeg' }) });
    const jpeg = await grabFrame(relay);
    // start and end of image markers
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    await until(() => relay.status === 'idle', 2000, 'the upstream to close');
  });

  it('shares the running upstream with other sinks', async () => {
    const relay = createRelay({ source: new AvSource(mjpeg, { format: 'mpjpeg', readrate: 1, loop: true }) });
    let starts = 0;
    let watched = 0;
    relay.on('start', () => starts++);
    relay.pipe(
      new CallbackSink({
        onPacket: () => {
          watched++;
        },
      }),
    );
    await until(() => watched > 0, 5000, 'the first packet');

    const frames = [await grabFrame(relay), await grabFrame(relay)];
    expect(frames.every((frame) => frame[0] === 0xff && frame[1] === 0xd8)).toBe(true);
    const before = watched;
    await until(() => watched > before + 2, 2000, 'the viewer to keep receiving');
    expect(starts).toBe(1);
    expect(relay.status).toBe('running');
  });
});
