import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ffmpegPath, isFfmpegAvailable } from 'node-av';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Relay } from '../../relay.js';
import { CallbackSink } from '../../sinks/callback.js';
import { AvSource } from '../av.js';

const execFileAsync = promisify(execFile);

// Integration: exercises the real node-av demuxer against a synthesized clip.
// Skipped automatically where the bundled ffmpeg binary is unavailable.
const suite = isFfmpegAvailable() ? describe : describe.skip;

suite('AvSource (integration)', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rtsp-av-'));
    file = join(dir, 'sample.mp4');
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
      '1',
      '-c:v',
      'libx264',
      '-g',
      '15',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      file,
    ]);
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('demuxes video + audio tracks with codec names', async () => {
    const source = new AvSource(file);
    const info = await source.open();
    await source.close();

    const kinds = info.tracks.map((t) => t.kind).sort();
    expect(kinds).toEqual(['audio', 'video']);

    const video = info.tracks.find((t) => t.kind === 'video');
    const audio = info.tracks.find((t) => t.kind === 'audio');
    expect(video?.codec).toBe('h264');
    expect(audio?.codec).toBe('aac');
    expect(video?.native).toBeDefined();
    expect(video?.timeBase?.den).toBeGreaterThan(0);
  });

  it('relays demuxed packets, starting at a keyframe, with native handles', async () => {
    const source = new AvSource(file);
    const relay = new Relay({ source });

    const seen: { index: number; keyframe: boolean; hasAv: boolean }[] = [];
    await new Promise<void>((resolve, reject) => {
      relay.on('end', resolve);
      relay.on('error', reject);
      relay.pipe(
        new CallbackSink({
          onPacket: (p) => {
            seen.push({ index: p.streamIndex, keyframe: p.isKeyframe, hasAv: p.av != null });
          },
        }),
      );
    });
    await relay.stop();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.hasAv)).toBe(true);
    // The first delivered packet must be a video keyframe (gate opener).
    const firstVideo = seen.find((p) => p.index === relay.info?.tracks.find((t) => t.kind === 'video')?.index);
    expect(firstVideo?.keyframe).toBe(true);
  });
});
