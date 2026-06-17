import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ffmpegPath, isFfmpegAvailable } from 'node-av';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Relay } from '../../relay.js';
import { CallbackSink } from '../../sinks/callback.js';
import { MultiSource } from '../multi.js';

const execFileAsync = promisify(execFile);
const suite = isFfmpegAvailable() ? describe : describe.skip;

suite('MultiSource (integration)', () => {
  let dir: string;
  let h264: string;
  let aac: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rtsp-multi-'));
    h264 = join(dir, 'video.h264');
    aac = join(dir, 'audio.aac');
    await execFileAsync(ffmpegPath(), [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=15',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-g',
      '15',
      '-pix_fmt',
      'yuv420p',
      '-bsf:v',
      'h264_mp4toannexb',
      '-f',
      'h264',
      h264,
    ]);
    await execFileAsync(ffmpegPath(), ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:a', 'aac', '-f', 'adts', aac]);
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('merges separate raw h264 + aac inputs into one multi-track source', async () => {
    const source = new MultiSource([
      { input: createReadStream(h264), format: 'h264' },
      { input: createReadStream(aac), format: 'aac' },
    ]);
    const relay = new Relay({ source });

    const indices = new Set<number>();
    let firstVideoKeyframe = false;
    let videoIndex = -1;

    await new Promise<void>((resolve, reject) => {
      relay.on('error', reject);
      relay.on('stop', resolve);
      relay.on('start', (info) => {
        videoIndex = info.tracks.find((t) => t.kind === 'video')?.index ?? -1;
        expect(info.tracks.map((t) => t.kind).sort()).toEqual(['audio', 'video']);
        expect(info.tracks.map((t) => t.codec).sort()).toEqual(['aac', 'h264']);
      });
      relay.pipe(
        new CallbackSink({
          onPacket: (p) => {
            indices.add(p.streamIndex);
            if (p.streamIndex === videoIndex && p.isKeyframe && indices.size === 1) firstVideoKeyframe = true;
          },
        }),
      );
    });

    // Packets arrived from both merged inputs, gated to start at a keyframe.
    expect(indices.size).toBe(2);
    expect(firstVideoKeyframe).toBe(true);
  }, 30_000);
});
