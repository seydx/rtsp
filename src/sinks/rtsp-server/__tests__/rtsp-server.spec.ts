import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Demuxer } from 'node-av';
import { ffmpegPath, isFfmpegAvailable } from 'node-av';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Relay } from '../../../relay.js';
import { AvSource } from '../../../sources/av.js';
import { RtspServerSink } from '../rtsp-server-sink.js';

const execFileAsync = promisify(execFile);
const suite = isFfmpegAvailable() ? describe : describe.skip;

suite('RtspServerSink (integration)', () => {
  let dir: string;
  let sample: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rtsp-srv-'));
    sample = join(dir, 'sample.mp4');
    await execFileAsync(ffmpegPath(), [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=15',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-g',
      '15',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      sample,
    ]);
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('serves a single upstream to a pulling ffmpeg client', async () => {
    // Looped + paced so the source behaves like a live feed and the client
    // reliably catches a keyframe after PLAY.
    const relay = new Relay({ source: new AvSource(sample, { readrate: 1, loop: true }) });
    const server = await relay.serveRtsp({ path: 'live' });

    expect(server.url).toMatch(/^rtsp:\/\/127\.0\.0\.1:\d+\/live$/);

    const out = join(dir, 'pulled.mp4');
    try {
      await execFileAsync(ffmpegPath(), ['-y', '-rtsp_transport', 'tcp', '-i', server.url, '-t', '1', '-c', 'copy', out], { timeout: 25_000 });

      // The pulled file must be a real A/V recording.
      expect((await stat(out)).size).toBeGreaterThan(0);
      const demuxer = await Demuxer.open(out);
      const codecs = demuxer.streams.map((s) => s.codecpar.codecId);
      await demuxer.close();
      expect(codecs.length).toBeGreaterThanOrEqual(2);
    } finally {
      await server.shutdown();
      await relay.stop();
    }
  }, 30_000);

  it('keeps one upstream connection across two concurrent pullers', async () => {
    const source = new AvSource(sample, { readrate: 1, loop: true });
    const relay = new Relay({ source });
    let opens = 0;
    relay.on('start', () => opens++);

    const server = await relay.serveRtsp({ path: 'live' });
    const out1 = join(dir, 'a.mp4');
    const out2 = join(dir, 'b.mp4');

    try {
      await Promise.all([
        execFileAsync(ffmpegPath(), ['-y', '-rtsp_transport', 'tcp', '-i', server.url, '-t', '1', '-c', 'copy', out1], { timeout: 25_000 }),
        execFileAsync(ffmpegPath(), ['-y', '-rtsp_transport', 'tcp', '-i', server.url, '-t', '1', '-c', 'copy', out2], { timeout: 25_000 }),
      ]);

      expect((await stat(out1)).size).toBeGreaterThan(0);
      expect((await stat(out2)).size).toBeGreaterThan(0);
      // Both clients were served from a single upstream open.
      expect(opens).toBe(1);
    } finally {
      await server.shutdown();
      await relay.stop();
    }
  }, 40_000);

  it('serves transcoded audio across a loop boundary: the SDP waits for the re-encoded track header', async () => {
    // Regression 1: the transcode path buffers before it muxes its first packet.
    // The SDP must not be generated until that header exists, or the audio
    // media section carries unresolved codec parameters and clients fail SETUP.
    // Regression 2: pulling for longer than the 2s sample forces the client
    // across a loop boundary — without timestamp rebasing the stream turns
    // non-monotonic there and the pull never completes.
    // Server-side diagnostics go to the test output: on slow CI runners this
    // test is the first to surface timing bugs, and without the sink/session
    // logs a failure here is undiagnosable.
    const logger = {
      warn: (...args: unknown[]) => console.warn('[server]', ...args),
      error: (...args: unknown[]) => console.error('[server]', ...args),
    };
    const relay = new Relay({ source: new AvSource(sample, { readrate: 1, loop: true, logger }), logger });
    const server = await relay.serveRtsp({ path: 'live', audioTranscode: { codec: 'aac', bitRate: 32_000 } });

    const out = join(dir, 'transcoded.mp4');
    try {
      // The exec timeout must stay well below the test timeout: when vitest
      // hard-kills the worker mid-teardown, in-flight native calls abort the
      // whole process (SIGABRT) and swallow the diagnostics of the actual
      // failure. This way ffmpeg is reaped first and teardown runs inside the
      // test's lifetime.
      await execFileAsync(ffmpegPath(), ['-y', '-rtsp_transport', 'tcp', '-i', server.url, '-t', '3', '-c', 'copy', out], { timeout: 20_000 });

      const demuxer = await Demuxer.open(out);
      const kinds = demuxer.streams.map((s) => s.codecpar.codecType);
      await demuxer.close();
      // Both the passthrough video and the re-encoded audio arrived intact.
      expect(kinds.length).toBeGreaterThanOrEqual(2);
    } finally {
      await server.shutdown();
      await relay.stop();
    }
  }, 45_000);

  it('excludes a track that produces no RTP header within sdpTimeout', async () => {
    const source = new AvSource(sample);
    const info = await source.open();
    // Drive the sink directly (no relay pump, no TCP) so we control exactly
    // which tracks receive packets.
    const fakeRelay = { pipe: () => undefined } as unknown as Relay;
    const sink = new RtspServerSink(fakeRelay, { sdpTimeout: 300 });

    try {
      await sink.init(info);
      const sdpPromise = sink.activate();

      // Feed only video — the audio track never muxes and must be excluded.
      const videoIndex = info.tracks.find((t) => t.kind === 'video')!.index;
      const controller = new AbortController();
      const feeding = (async () => {
        for await (const packet of source.packets(controller.signal)) {
          if (packet.streamIndex === videoIndex) await sink.write(packet);
          packet.free();
        }
      })();

      const sdp = await sdpPromise;
      controller.abort();
      await feeding;

      expect(sdp).toContain('m=video');
      expect(sdp).not.toContain('m=audio');
      // The surviving track keeps its original streamid (its position in the
      // servable track list), even though the audio section was removed.
      const expectedId = info.tracks.findIndex((t) => t.kind === 'video');
      expect(sdp).toContain(`a=control:streamid=${expectedId}`);
    } finally {
      await sink.close();
      await source.close();
    }
  }, 15_000);

  it('rejects pending DESCRIBEs when no track produces a header within sdpTimeout', async () => {
    const source = new AvSource(sample);
    const info = await source.open();
    const fakeRelay = { pipe: () => undefined } as unknown as Relay;
    const sink = new RtspServerSink(fakeRelay, { sdpTimeout: 200 });

    try {
      await sink.init(info);
      // No packets are ever written — the SDP must fail instead of hanging.
      await expect(sink.activate()).rejects.toThrow(/no track produced an rtp header/i);
    } finally {
      await sink.close();
      await source.close();
    }
  }, 15_000);
});
