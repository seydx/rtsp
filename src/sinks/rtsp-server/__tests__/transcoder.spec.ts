import { AV_CODEC_ID_PCM_ALAW, AV_CODEC_ID_PCM_S16LE, Demuxer, ffmpegPath, isFfmpegAvailable, Muxer } from 'node-av';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BackchannelTranscoder } from '../backchannel-transcoder.js';

const execFileAsync = promisify(execFile);
const suite = isFfmpegAvailable() ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Packetize an audio file into RTP buffers (RTCP filtered out). */
async function toRtp(file: string): Promise<Buffer[]> {
  const demuxer = await Demuxer.open(file);
  const rtp: Buffer[] = [];
  const muxer = await Muxer.open(
    {
      write: (buffer: Buffer) => {
        const pt = buffer[1] & 0x7f;
        if (pt < 72 || pt > 76) rtp.push(Buffer.from(buffer)); // skip RTCP
        return buffer.length;
      },
    },
    { format: 'rtp', maxPacketSize: 1200 } as never,
  );
  muxer.addStream(demuxer.streams[0]);
  for await (const packet of demuxer.packets()) {
    if (!packet) continue;
    await muxer.writePacket(packet, 0);
    packet.free();
  }
  await muxer.close();
  await demuxer.close();
  return rtp;
}

suite('BackchannelTranscoder', () => {
  let dir: string;
  let wav: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rtsp-tc-'));
    wav = join(dir, 'mulaw.wav');
    await execFileAsync(ffmpegPath(), ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=1', '-ac', '1', '-c:a', 'pcm_mulaw', wav]);
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('transcodes inbound pcm_mulaw RTP to the camera codec (pcm_alaw)', async () => {
    const inbound = await toRtp(wav);
    expect(inbound.length).toBeGreaterThan(0);

    const out: Buffer[] = [];
    const transcoder = new BackchannelTranscoder({
      from: { codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 },
      to: { codecId: AV_CODEC_ID_PCM_ALAW, sampleRate: 8000, channels: 1, format: 'rtp' },
      output: (rtp) => out.push(rtp),
    });

    try {
      await transcoder.start();
      for (const rtp of inbound) {
        transcoder.push(rtp);
        await sleep(5);
      }
      await sleep(500);

      expect(out.length).toBeGreaterThan(0);
      // Output must be RTP (not RTCP) — PCMA payload type 8.
      const media = out.filter((b) => {
        const pt = b[1] & 0x7f;
        return pt < 72 || pt > 76;
      });
      expect(media.length).toBeGreaterThan(0);
      expect(media[0][1] & 0x7f).toBe(8);
    } finally {
      await transcoder.close();
    }
  }, 30_000);

  it('selects the target encoder by codec name (no numeric codecId needed)', async () => {
    const inbound = await toRtp(wav);

    const out: Buffer[] = [];
    const transcoder = new BackchannelTranscoder({
      from: { codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 },
      to: { codec: 'pcm_alaw', sampleRate: 8000, channels: 1, format: 'rtp' },
      output: (rtp) => out.push(rtp),
    });

    try {
      await transcoder.start();
      for (const rtp of inbound) {
        transcoder.push(rtp);
        await sleep(5);
      }
      await sleep(500);

      const media = out.filter((b) => {
        const pt = b[1] & 0x7f;
        return pt < 72 || pt > 76;
      });
      expect(media.length).toBeGreaterThan(0);
      expect(media[0][1] & 0x7f).toBe(8); // PCMA payload type
    } finally {
      await transcoder.close();
    }
  }, 30_000);

  it('transcodes to raw container bytes (non-RTP) for a writable talkback', async () => {
    // Proves the codec-generic, non-RTP output path used for proprietary
    // talkback sinks (e.g. a Node writable). PCM is used for a deterministic
    // assertion; any encoder/format works the same way.
    const inbound = await toRtp(wav);

    const chunks: Buffer[] = [];
    const transcoder = new BackchannelTranscoder({
      from: { codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 },
      to: { codecId: AV_CODEC_ID_PCM_S16LE, sampleRate: 8000, channels: 1, format: 's16le' },
      output: (buf) => chunks.push(buf),
    });

    try {
      await transcoder.start();
      for (const rtp of inbound) {
        transcoder.push(rtp);
        await sleep(5);
      }
      await sleep(400);

      // ~1s of 8 kHz mono s16 → raw PCM bytes (not RTP-framed).
      expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
    } finally {
      await transcoder.close();
    }
  }, 30_000);

  it('transcodes pcm_mulaw RTP to AAC (resamples s16 -> fltp)', async () => {
    const inbound = await toRtp(wav);

    const out: Buffer[] = [];
    const transcoder = new BackchannelTranscoder({
      from: { codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 },
      to: { codec: 'aac', sampleRate: 16000, channels: 2, format: 'adts' },
      output: (buf) => out.push(buf),
    });

    try {
      await transcoder.start();
      for (const rtp of inbound) {
        transcoder.push(rtp);
        await sleep(5);
      }
      await sleep(500);

      // Encoded ADTS AAC bytes must be produced — every frame starts 0xFFFx.
      const bytes = Buffer.concat(out);
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1] & 0xf0).toBe(0xf0);
    } finally {
      await transcoder.close();
    }
  }, 30_000);
});
