import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRtp, Fixtures, hasFfmpeg, until } from '../../../__tests__/helpers/media.js';
import { Relay } from '../../../relay.js';
import { AvSource } from '../../../sources/av.js';
import { isRtcp } from '../../../util/rtp.js';
import { RtspServerSink } from '../rtsp-server-sink.js';

import type { BackchannelInfo, MediaPacket, StreamInfo } from '../../../types.js';
import type { RtspServerSinkOptions } from '../rtsp-server-sink.js';
import type { RtspSession } from '../session.js';

const suite = hasFfmpeg ? describe : describe.skip;

const MULAW_SILENCE = Buffer.alloc(160, 0xff);
const ALAW_SILENCE = Buffer.alloc(160, 0xd5);

suite('RtspServerSink talkback over RTSP', () => {
  let fixtures: Fixtures;
  let video: string;

  beforeAll(async () => {
    fixtures = await Fixtures.create();
    video = await fixtures.clip('video');
  }, 30_000);

  afterAll(async () => {
    await fixtures?.dispose();
  });

  it('advertises talkback that a node-av client can send', async () => {
    const relay = new Relay({ source: new AvSource(video, { readrate: 1, loop: true }) });
    const server = await new RtspServerSink(relay, {
      backchannel: { advertise: { codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 }, idleTimeout: 300 },
    }).listen();

    const received: Buffer[] = [];
    const events: string[] = [];
    server.on('backchannel', (rtp) => received.push(rtp));
    server.on('backchannel:start', () => events.push('start'));
    server.on('backchannel:stop', () => events.push('stop'));

    const client = new AvSource(server.url, { transport: 'tcp', backchannel: true });
    try {
      const info = await client.open();
      expect(info.backchannel).toMatchObject({ codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 });

      for (let i = 0; i < 5; i++) {
        client.sendBackchannel(buildRtp(0, 1000 + i, 160 * i, MULAW_SILENCE));
        await delay(20);
      }
      await until(() => received.length === 5, 3000, 'talkback packets');
      expect(received[0].subarray(12)).toEqual(MULAW_SILENCE);
      expect(events).toEqual(['start']);
      await until(() => events.length === 2, 3000, 'talkback idle stop');
      expect(events).toEqual(['start', 'stop']);
    } finally {
      await client.close();
      await server.shutdown();
      await relay.stop();
    }
  }, 30_000);

  it('lets a second viewer talk only once the first one went quiet', async () => {
    const relay = new Relay({ source: new AvSource(video, { readrate: 1, loop: true }) });
    const server = await new RtspServerSink(relay, {
      backchannel: { advertise: { codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 }, idleTimeout: 300 },
    }).listen();
    const received: number[] = [];
    server.on('backchannel', (rtp) => received.push(rtp[12]));

    const first = new AvSource(server.url, { transport: 'tcp', backchannel: true });
    const second = new AvSource(server.url, { transport: 'tcp', backchannel: true });
    // the payload byte tells the talkers apart
    const talk = (client: AvSource, value: number, seq: number): void => client.sendBackchannel(buildRtp(0, seq, seq * 160, Buffer.alloc(160, value)));
    try {
      await Promise.all([first.open(), second.open()]);
      for (let i = 0; i < 5; i++) {
        talk(first, 0x11, i);
        talk(second, 0x22, i);
        await delay(20);
      }
      await until(() => received.length >= 5, 3000, 'the first talker');
      await delay(100);
      expect(new Set(received)).toEqual(new Set([0x11]));

      await delay(400);
      talk(second, 0x22, 10);
      await until(() => received.includes(0x22), 3000, 'the second talker');
    } finally {
      await Promise.all([first.close(), second.close()]);
      await server.shutdown();
      await relay.stop();
    }
  }, 30_000);
});

suite('RtspServerSink talkback forwarding', () => {
  let fixtures: Fixtures;
  let info: StreamInfo;
  let source: AvSource;
  let packets: MediaPacket[];

  beforeAll(async () => {
    fixtures = await Fixtures.create();
    source = new AvSource(await fixtures.clip('video', 1));
    info = await source.open();
    packets = [];
    for await (const packet of source.packets(new AbortController().signal)) packets.push(packet);
  }, 30_000);

  afterAll(async () => {
    for (const packet of packets ?? []) packet.free();
    await source?.close();
    await fixtures?.dispose();
  });

  // a camera source that records what reaches it
  function camera(backchannel: BackchannelInfo | undefined): { sent: Buffer[]; relay: Relay } {
    const sent: Buffer[] = [];
    const fake = {
      backchannel,
      sendBackchannel: (rtp: Buffer) => sent.push(rtp),
      open: () => Promise.resolve(info),
      packets: source.packets.bind(source),
      close: () => Promise.resolve(),
    };
    return { sent, relay: { source: fake, pipe: () => undefined, unpipe: () => Promise.resolve() } as unknown as Relay };
  }

  function sink(relay: Relay, backchannel: RtspServerSinkOptions['backchannel']): RtspServerSink {
    const server = new RtspServerSink(relay, { sdpTimeout: 0, backchannel });
    server.init(info);
    return server;
  }

  const MULAW_CAMERA: BackchannelInfo = { streamIndex: 2, codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 };
  // the server only compares sessions, it never calls into them here
  const viewer = {} as RtspSession;
  const other = {} as RtspSession;

  it('passes matching talkback through unchanged', () => {
    const { sent, relay } = camera(MULAW_CAMERA);
    const server = sink(relay, { advertise: { codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 } });
    try {
      const rtp = buildRtp(0, 1, 0, MULAW_SILENCE);
      server.backchannelRtp(viewer, rtp);
      expect(sent).toEqual([rtp]);
      expect(sent[0]).toBe(rtp);
    } finally {
      server.close();
    }
  });

  it('rewrites the payload type when only that differs', () => {
    const { sent, relay } = camera({ ...MULAW_CAMERA, payloadType: 110 });
    const server = sink(relay, { advertise: { codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 } });
    try {
      const rtp = buildRtp(0, 1, 0, MULAW_SILENCE);
      rtp[1] |= 0x80;
      server.backchannelRtp(viewer, rtp);
      // marker bit kept, payload untouched, original left alone
      expect(sent[0][1]).toBe(0x80 | 110);
      expect(sent[0].subarray(2)).toEqual(rtp.subarray(2));
      expect(rtp[1]).toBe(0x80);
    } finally {
      server.close();
    }
  });

  it('advertises the camera format by default', () => {
    const { relay } = camera(MULAW_CAMERA);
    const server = new RtspServerSink(relay, { sdpTimeout: 0, backchannel: true });
    try {
      server.init({ ...info, backchannel: MULAW_CAMERA });
      expect(server.backchannelFormat).toEqual({ codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1, fmtp: undefined });
    } finally {
      server.close();
    }
  });

  it('advertises nothing without a format to offer', () => {
    const warnings: unknown[] = [];
    const { relay } = camera(undefined);
    const server = new RtspServerSink(relay, { sdpTimeout: 0, backchannel: true, logger: { warn: (...args: unknown[]) => warnings.push(args) } });
    try {
      server.init(info);
      expect(server.backchannelFormat).toBeUndefined();
      expect(server.backchannelTrack).toBeUndefined();
      expect(warnings).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('transcodes talkback to the camera codec and closes the transcoder when idle', async () => {
    const { sent, relay } = camera(MULAW_CAMERA);
    const server = sink(relay, { advertise: { codec: 'pcm_alaw', payloadType: 8, clockRate: 8000, channels: 1 }, idleTimeout: 200 });
    const events: string[] = [];
    server.on('backchannel:start', () => events.push('start'));
    server.on('backchannel:stop', () => events.push('stop'));
    try {
      for (let i = 0; i < 10; i++) server.backchannelRtp(viewer, buildRtp(8, i, i * 160, ALAW_SILENCE));
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((rtp) => !isRtcp(rtp) && (rtp[1] & 0x7f) === 0)).toBe(true);
      // alaw silence is the smallest positive step, mu-law codes it at the top of its range
      expect(sent[0].subarray(12).every((byte) => byte >= 0xfe)).toBe(true);

      await until(() => events.length === 2, 2000, 'talkback idle stop');
      expect(events).toEqual(['start', 'stop']);

      // a new burst starts a fresh transcoder
      const before = sent.length;
      server.backchannelRtp(viewer, buildRtp(8, 100, 16000, ALAW_SILENCE));
      expect(sent.length).toBeGreaterThan(before);
    } finally {
      server.close();
    }
    expect(events).toEqual(['start', 'stop', 'start', 'stop']);
  });

  it('lets one viewer talk at a time', () => {
    const { sent, relay } = camera(MULAW_CAMERA);
    const server = sink(relay, { advertise: { codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 } });
    const received: Buffer[] = [];
    const events: string[] = [];
    server.on('backchannel', (rtp) => received.push(rtp));
    server.on('backchannel:start', () => events.push('start'));
    server.on('backchannel:stop', () => events.push('stop'));
    try {
      const first = buildRtp(0, 1, 0, MULAW_SILENCE);
      server.backchannelRtp(viewer, first);
      server.backchannelRtp(other, buildRtp(0, 500, 8000, MULAW_SILENCE));
      expect(received).toEqual([first]);
      expect(sent).toEqual([first]);

      // the speaker leaving ends the burst at once, the next viewer may talk
      server.sessionClosed(viewer);
      expect(events).toEqual(['start', 'stop']);
      const next = buildRtp(0, 501, 8160, MULAW_SILENCE);
      server.backchannelRtp(other, next);
      expect(received).toEqual([first, next]);
      expect(events).toEqual(['start', 'stop', 'start']);
    } finally {
      server.close();
    }
    expect(events).toEqual(['start', 'stop', 'start', 'stop']);
  });

  it('ignores talkback when none is advertised', () => {
    const { sent, relay } = camera(MULAW_CAMERA);
    const server = sink(relay, false);
    const received: Buffer[] = [];
    server.on('backchannel', (rtp) => received.push(rtp));
    try {
      server.backchannelRtp(viewer, buildRtp(0, 1, 0, MULAW_SILENCE));
      expect(received).toHaveLength(0);
      expect(sent).toHaveLength(0);
    } finally {
      server.close();
    }
  });
});
