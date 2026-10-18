import { AVMEDIA_TYPE_AUDIO, AVMEDIA_TYPE_VIDEO } from 'node-av/constants';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Fixtures, hasFfmpeg, probe, RtspTestClient, runFfmpeg, until } from '../../../__tests__/helpers/media.js';
import { Relay } from '../../../relay.js';
import { AvSource } from '../../../sources/av.js';
import { MultiSource } from '../../../sources/multi.js';
import { TranscodeSink } from '../../../transcode/transcode-sink.js';
import { RtspAuth } from '../auth.js';
import { RtspServerSink } from '../rtsp-server-sink.js';

import type { MediaPacket, Sink, StreamInfo } from '../../../types.js';
import type { RtspServerSinkOptions } from '../rtsp-server-sink.js';

const suite = hasFfmpeg ? describe : describe.skip;

function pull(url: string, out: string, seconds = 1): Promise<void> {
  return runFfmpeg(['-rtsp_transport', 'tcp', '-i', url, '-t', String(seconds), '-c', 'copy', out]);
}

function portOf(server: RtspServerSink): number {
  return Number(/:(\d+)\//.exec(server.url)![1]);
}

suite('RtspServerSink serving', () => {
  let fixtures: Fixtures;
  let av: string;

  // looped and paced, so the file behaves like a live camera
  async function serve(options: RtspServerSinkOptions = {}, source = new AvSource(av, { readrate: 1, loop: true })): Promise<{ relay: Relay; server: RtspServerSink }> {
    const relay = new Relay({ source });
    const server = await new RtspServerSink(relay, options).listen();
    return { relay, server };
  }

  async function shutdown({ relay, server }: { relay: Relay; server: RtspServerSink }): Promise<void> {
    await server.shutdown();
    await relay.stop();
  }

  beforeAll(async () => {
    fixtures = await Fixtures.create();
    av = await fixtures.clip('av');
  }, 30_000);

  afterAll(async () => {
    await fixtures?.dispose();
  });

  it('serves one upstream to a pulling ffmpeg client', async () => {
    const served = await serve();
    expect(served.server.url).toMatch(/^rtsp:\/\/127\.0\.0\.1:\d+\/live$/);
    try {
      const out = fixtures.path('pulled.mp4');
      await pull(served.server.url, out);
      expect((await probe(out)).map((stream) => stream.codec)).toEqual(['h264', 'aac']);
    } finally {
      await shutdown(served);
    }
  }, 30_000);

  it('opens the upstream once for concurrent viewers and counts them', async () => {
    const served = await serve();
    let starts = 0;
    let peak = 0;
    served.relay.on('start', () => starts++);
    served.server.on('viewer:added', (count) => (peak = Math.max(peak, count)));
    const removed: number[] = [];
    served.server.on('viewer:removed', (count) => removed.push(count));
    try {
      await Promise.all([pull(served.server.url, fixtures.path('a.mp4')), pull(served.server.url, fixtures.path('b.mp4'))]);
      expect(starts).toBe(1);
      expect(peak).toBe(2);
      await until(() => removed.length === 2, 5000, 'both viewers to leave');
      expect(served.server.viewers).toBe(0);
    } finally {
      await shutdown(served);
    }
  }, 40_000);

  it('answers 404 for another path and does not touch the upstream', async () => {
    const served = await serve();
    const client = await RtspTestClient.connect(portOf(served.server));
    try {
      const response = await client.request('DESCRIBE', `rtsp://127.0.0.1:${portOf(served.server)}/other`);
      expect(response.status).toBe(404);
      expect(served.relay.status).toBe('idle');
    } finally {
      client.close();
      await shutdown(served);
    }
  });

  it('sends a real RTP-Info on PLAY and streams interleaved media', async () => {
    const served = await serve();
    const base = `rtsp://127.0.0.1:${portOf(served.server)}/live`;
    const client = await RtspTestClient.connect(portOf(served.server));
    try {
      const describe = await client.request('DESCRIBE', base);
      expect(describe.status).toBe(200);
      expect(describe.body).toContain('a=control:streamid=0');
      expect(describe.body).toContain('a=control:streamid=1');

      const setup = await client.request('SETUP', `${base}/streamid=0`, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
      const session = setup.headers.session.split(';')[0];
      await client.request('SETUP', `${base}/streamid=1`, { Transport: 'RTP/AVP/TCP;unicast;interleaved=2-3', Session: session });
      const play = await client.request('PLAY', base, { Session: session });

      expect(play.status).toBe(200);
      expect(play.headers['rtp-info']).toMatch(new RegExp(`^url=${base}/streamid=0;seq=\\d+;rtptime=\\d+,url=${base}/streamid=1;seq=\\d+;rtptime=\\d+$`));
      await until(() => client.frames > 10, 5000, 'interleaved media');
    } finally {
      client.close();
      await shutdown(served);
    }
  }, 15_000);

  it('disconnects its viewers when the upstream ends', async () => {
    const served = await serve({}, new AvSource(av, { readrate: 1 }));
    const base = `rtsp://127.0.0.1:${portOf(served.server)}/live`;
    const client = await RtspTestClient.connect(portOf(served.server));
    try {
      await client.request('DESCRIBE', base);
      await client.request('SETUP', `${base}/streamid=0`, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
      await client.request('PLAY', base);
      await client.waitClosed();
      expect(served.relay.status).not.toBe('running');
    } finally {
      client.close();
      await shutdown(served);
    }
  }, 15_000);

  it('requires credentials when auth is set', async () => {
    const served = await serve({ auth: new RtspAuth({ username: 'viewer', password: 'secret' }) });
    expect(served.server.url).toMatch(/^rtsp:\/\/viewer:\*\*\*@127\.0\.0\.1:\d+\/live$/);
    const url = `rtsp://127.0.0.1:${portOf(served.server)}/live`;
    try {
      await expect(pull(url, fixtures.path('denied.mp4'))).rejects.toThrow(/401|Unauthorized/);
      const out = fixtures.path('authorized.mp4');
      await pull(url.replace('rtsp://', 'rtsp://viewer:secret@'), out);
      expect((await probe(out)).length).toBe(2);
    } finally {
      await shutdown(served);
    }
  }, 40_000);

  it('re-encodes audio across a loop boundary', async () => {
    // the transcoder emits its first packet late, the SDP must wait for it, and a pull longer than
    // the 2s clip crosses a loop boundary where timestamps must stay monotonic
    const served = await serve({ transcode: { audio: { codec: 'aac', sampleRate: 16000, channels: 1, bitRate: 32_000 } } });
    try {
      const out = fixtures.path('transcoded-audio.mp4');
      await pull(served.server.url, out, 3);
      const streams = await probe(out);
      expect(streams.map((stream) => stream.codec)).toEqual(['h264', 'aac']);
    } finally {
      await shutdown(served);
    }
  }, 45_000);
});

suite('RtspServerSink MJPEG to H.264', () => {
  let fixtures: Fixtures;
  let mjpeg: string;

  beforeAll(async () => {
    fixtures = await Fixtures.create();
    mjpeg = await fixtures.clip('mjpeg');
  }, 30_000);

  afterAll(async () => {
    await fixtures?.dispose();
  });

  async function pullTranscoded(hardware: boolean): Promise<{ codec: string | null; type: number }[]> {
    const relay = new Relay({ source: new AvSource(mjpeg, { format: 'mpjpeg', readrate: 1, loop: true }) });
    const server = await new RtspServerSink(relay, { transcode: { hardware, video: { codec: 'h264', bitRate: 500_000 } } }).listen();
    try {
      const out = fixtures.path(`mjpeg-${hardware ? 'hw' : 'sw'}.mp4`);
      await pull(server.url, out);
      return await probe(out);
    } finally {
      await server.shutdown();
      await relay.stop();
    }
  }

  it('serves a software encoded H.264 stream', async () => {
    expect(await pullTranscoded(false)).toEqual([{ type: AVMEDIA_TYPE_VIDEO, codec: 'h264' }]);
  }, 30_000);

  it('serves H.264 with hardware encoding, falling back to software', async () => {
    expect(await pullTranscoded(true)).toEqual([{ type: AVMEDIA_TYPE_VIDEO, codec: 'h264' }]);
  }, 30_000);

  it('serves live MJPEG with the audio of a second input', async () => {
    // an mjpeg camera sends audio on a connection of its own, both arrive untimed
    const [video, audio] = await Promise.all([readFile(await fixtures.clip('mjpeg', 4)), readFile(await fixtures.clip('mulaw', 4))]);
    const feeds = [
      { feed: new PassThrough(), data: video },
      { feed: new PassThrough(), data: audio },
    ];
    const source = new MultiSource([
      { input: feeds[0].feed, format: 'mpjpeg', wallclock: true },
      { input: feeds[1].feed, format: 'wav', wallclock: true },
    ]);
    const relay = new Relay({ source });
    // mpjpeg reports the end of the feed as invalid data
    relay.on('error', () => undefined);
    const server = await new RtspServerSink(relay, { transcode: { hardware: false, video: { codec: 'h264' }, audio: { codec: 'aac' } } }).listen();
    try {
      const out = fixtures.path('mjpeg-audio.mp4');
      const pulled = pull(server.url, out, 2);
      // four seconds of both, at the pace a camera sends them
      const chunks = 80;
      for (let i = 0; i < chunks; i++) {
        for (const { feed, data } of feeds) {
          const size = Math.ceil(data.length / chunks);
          feed.write(data.subarray(i * size, (i + 1) * size));
        }
        await delay(50);
      }
      await pulled;
      expect(await probe(out)).toEqual([
        { type: AVMEDIA_TYPE_VIDEO, codec: 'h264' },
        { type: AVMEDIA_TYPE_AUDIO, codec: 'aac' },
      ]);
    } finally {
      for (const { feed } of feeds) feed.end();
      await server.shutdown();
      await relay.stop();
    }
  }, 30_000);
});

suite('RtspServerSink stream lifecycle', () => {
  let fixtures: Fixtures;
  let av: string;
  let info: StreamInfo;
  let source: AvSource;
  let packets: MediaPacket[];

  beforeAll(async () => {
    fixtures = await Fixtures.create();
    av = await fixtures.clip('av', 1);
    source = new AvSource(av);
    info = await source.open();
    packets = [];
    for await (const packet of source.packets(new AbortController().signal)) packets.push(packet);
  }, 30_000);

  afterAll(async () => {
    for (const packet of packets ?? []) packet.free();
    await source?.close();
    await fixtures?.dispose();
  });

  function feed(sink: RtspServerSink, filter: (packet: MediaPacket) => boolean = () => true): void {
    for (const packet of packets) {
      if (!filter(packet)) continue;
      const copy = packet.clone();
      try {
        sink.write(copy);
      } finally {
        copy.free();
      }
    }
  }

  // the sink only uses pipe and unpipe of its relay here, there is no TCP and no pump
  function fakeRelay(hooks: { pipe?: (sink: Sink) => void; unpipe?: (sink: Sink) => Promise<void> } = {}): Relay {
    return { pipe: hooks.pipe ?? (() => undefined), unpipe: hooks.unpipe ?? (() => Promise.resolve()), source } as unknown as Relay;
  }

  it('leaves a track out that produces no data within sdpTimeout', async () => {
    const sink = new RtspServerSink(fakeRelay(), { sdpTimeout: 300 });
    try {
      sink.init(info);
      const sdp = sink.describe({} as never);
      const video = info.tracks.find((track) => track.kind === 'video')!;
      feed(sink, (packet) => packet.streamIndex === video.index);

      const text = await sdp;
      expect(text).toContain('m=video');
      expect(text).not.toContain('m=audio');
      // the remaining track keeps its id, viewers may have cached it
      expect(text).toContain(`a=control:streamid=${info.tracks.indexOf(video)}`);
      expect(sink.trackKind(info.tracks.findIndex((track) => track.kind === 'audio'))).toBeUndefined();
    } finally {
      sink.close();
    }
  });

  it('rejects DESCRIBE when no track produces data within sdpTimeout', async () => {
    const sink = new RtspServerSink(fakeRelay(), { sdpTimeout: 200 });
    try {
      sink.init(info);
      await expect(sink.describe({} as never)).rejects.toThrow(/no track produced data/i);
    } finally {
      sink.close();
    }
  });

  it('rejects a waiting DESCRIBE when the stream closes', async () => {
    const sink = new RtspServerSink(fakeRelay(), { sdpTimeout: 0 });
    sink.init(info);
    const sdp = sink.describe({} as never);
    sink.close();
    await expect(sdp).rejects.toThrow(/closed before its SDP/);
  });

  it('detaches only after the grace period and stays when a viewer returns', async () => {
    const calls = { pipe: 0, unpipe: 0 };
    const sink: RtspServerSink = new RtspServerSink(
      fakeRelay({
        pipe: () => {
          calls.pipe++;
          sink.init(info);
        },
        unpipe: () => {
          calls.unpipe++;
          sink.close();
          return Promise.resolve();
        },
      }),
      { detachDelay: 150, sdpTimeout: 0 },
    );
    try {
      void sink.describe({} as never).catch(() => undefined);
      sink.sessionClosed({} as never);
      expect(calls.unpipe).toBe(0);

      // a DESCRIBE inside the window keeps the warm stream
      await delay(50);
      void sink.describe({} as never).catch(() => undefined);
      await delay(250);
      expect(calls.unpipe).toBe(0);
      expect(calls.pipe).toBe(1);

      sink.sessionClosed({} as never);
      await delay(250);
      expect(calls.unpipe).toBe(1);
    } finally {
      sink.close();
    }
  });

  it('re-attaches a DESCRIBE that races the detach of the last viewer', async () => {
    let pipes = 0;
    let release!: () => void;
    const sink: RtspServerSink = new RtspServerSink(
      fakeRelay({
        pipe: () => {
          pipes++;
          sink.init(info);
        },
        // a slow unpipe, the next DESCRIBE has to wait it out
        unpipe: async () => {
          await new Promise<void>((resolve) => (release = resolve));
          sink.close();
        },
      }),
      { detachDelay: 0, sdpTimeout: 0 },
    );
    try {
      const first = sink.describe({} as never);
      feed(sink);
      expect(await first).toContain('m=video');

      sink.sessionClosed({} as never);
      const second = sink.describe({} as never);
      await delay(20);
      expect(pipes).toBe(1);
      release();
      await vi.waitFor(() => expect(pipes).toBe(2));
      feed(sink);
      expect(await second).toContain('m=video');
    } finally {
      sink.close();
    }
  });

  it('advertises the talkback track after the media tracks', async () => {
    const sink = new RtspServerSink(fakeRelay(), {
      sdpTimeout: 0,
      backchannel: { advertise: { codec: 'pcm_alaw', payloadType: 8, clockRate: 8000, channels: 1 } },
    });
    try {
      sink.init(info);
      const sdp = sink.describe({} as never);
      feed(sink);
      const text = await sdp;
      expect(text.endsWith('m=audio 0 RTP/AVP 8\r\na=rtpmap:8 PCMA/8000\r\na=sendonly\r\na=control:streamid=2\r\n')).toBe(true);
      expect(sink.backchannelTrack).toBe(2);
      expect(sink.trackKind(2)).toBe('audio');
      expect(sink.backchannelFormat).toEqual({ codec: 'pcm_alaw', payloadType: 8, clockRate: 8000, channels: 1, fmtp: undefined });
    } finally {
      sink.close();
    }
  });

  it('refuses a stream without servable tracks', () => {
    const sink = new RtspServerSink(fakeRelay());
    expect(() => sink.init({ tracks: [{ index: 0, kind: 'data', codec: 'bin_data' }] })).toThrow(/no servable/);
    expect(() => sink.init({ tracks: [{ index: 0, kind: 'audio', codec: 'aac' }] })).toThrow(/no servable/);
    sink.close();
  });

  it('attaches through a transcoder when re-encoding is configured', async () => {
    const piped: Sink[] = [];
    const unpiped: Sink[] = [];
    const relay = fakeRelay({
      pipe: (sink) => piped.push(sink),
      unpipe: (sink) => {
        unpiped.push(sink);
        return Promise.resolve();
      },
    });
    const sink = new RtspServerSink(relay, { sdpTimeout: 0, detachDelay: 0, transcode: { hardware: false, video: { codec: 'h264' } } });
    const describing = sink.describe({} as never).catch(() => undefined);
    expect(piped[0]).toBeInstanceOf(TranscodeSink);
    expect((piped[0] as TranscodeSink).sink).toBe(sink);
    sink.sessionClosed({} as never);
    await until(() => unpiped.length > 0, 1000, 'detach');
    expect(unpiped[0]).toBe(piped[0]);
    sink.close();
    await describing;
  });

  it('stops listening on shutdown and can listen again', async () => {
    const relay = new Relay({ source: new AvSource(av) });
    const server = new RtspServerSink(relay);
    await server.listen();
    expect(await server.listen()).toBe(server);
    const port = portOf(server);
    await server.shutdown();
    await expect(RtspTestClient.connect(port)).rejects.toThrow();
    await server.listen();
    await server.shutdown();
  });

  it('reports a port that is already taken', async () => {
    const relay = new Relay({ source: new AvSource(av) });
    const first = await new RtspServerSink(relay).listen();
    const second = new RtspServerSink(relay, { port: portOf(first) });
    try {
      await expect(second.listen()).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await first.shutdown();
    }
  });
});
