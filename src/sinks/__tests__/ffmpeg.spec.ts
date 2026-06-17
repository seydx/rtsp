import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Demuxer, ffmpegPath, isFfmpegAvailable } from 'node-av';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Relay } from '../../relay.js';
import { AvSource } from '../../sources/av.js';
import { FfmpegSink } from '../ffmpeg.js';

const execFileAsync = promisify(execFile);
const suite = isFfmpegAvailable() ? describe : describe.skip;

suite('FfmpegSink (integration)', () => {
  let dir: string;
  let sample: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rtsp-ff-'));
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
      sample,
    ]);
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('remuxes the relayed stream into a new container', async () => {
    const out = join(dir, 'remuxed.ts');
    const relay = new Relay({ source: new AvSource(sample) });

    await new Promise<void>((resolve, reject) => {
      // 'stop' fires after sinks have drained their backlog and the muxer
      // trailer is written.
      relay.on('stop', resolve);
      relay.on('error', reject);
      relay.pipe(new FfmpegSink({ output: out, format: 'mpegts' }));
    });

    expect((await stat(out)).size).toBeGreaterThan(0);
    const demuxer = await Demuxer.open(out);
    const kinds = demuxer.streams.length;
    await demuxer.close();
    expect(kinds).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
