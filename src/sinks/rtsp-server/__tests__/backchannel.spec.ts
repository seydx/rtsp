import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ffmpegPath, isFfmpegAvailable } from 'node-av';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Relay } from '../../../relay.js';
import { AvSource } from '../../../sources/av.js';

const execFileAsync = promisify(execFile);
const suite = isFfmpegAvailable() ? describe : describe.skip;

function buildRtp(pt: number, seq: number, ts: number, ssrc: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = pt & 0x7f;
  header.writeUInt16BE(seq, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite('RtspServerSink backchannel (loopback)', () => {
  let dir: string;
  let sample: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rtsp-bc-'));
    sample = join(dir, 'sample.mp4');
    await execFileAsync(ffmpegPath(), [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=15',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-g',
      '15',
      '-pix_fmt',
      'yuv420p',
      sample,
    ]);
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('advertises talkback, and a node-av client can read + send it', async () => {
    const serverRelay = new Relay({ source: new AvSource(sample, { readrate: 1, loop: true }) });
    const server = await serverRelay.serveRtsp({
      backchannel: { codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 },
    });

    const received: Buffer[] = [];
    server.on('backchannel', (rtp) => received.push(rtp));

    const client = new AvSource(server.url, { transport: 'tcp', backchannel: true });
    try {
      const info = await client.open();
      // The client sees our advertised sendonly talkback stream.
      expect(info.backchannel).toBeDefined();
      expect(info.backchannel?.codec).toBe('pcm_mulaw');

      // Send a few talkback RTP packets upstream.
      const silence = Buffer.alloc(160, 0xff);
      for (let i = 0; i < 5; i++) {
        client.sendBackchannel(buildRtp(0, 1000 + i, 8000 * i, 0x1234abcd, silence));
        await sleep(20);
      }
      await sleep(200);

      expect(received.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.shutdown();
      await serverRelay.stop();
    }
  }, 30_000);
});
