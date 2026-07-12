import { AV_CHANNEL_LAYOUT_MONO, AV_SAMPLE_FMT_S16, Codec, Demuxer, Encoder, Frame, Rational } from 'node-av';
import { describe, expect, it } from 'vitest';

import { buildAacEldConfig, RawAudioTranscoder } from '../raw-audio-transcoder.js';

import type { FFEncoderCodec } from 'node-av';

const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 480;

const hasFdk = Codec.findDecoderByName('libfdk_aac' as never) !== null && Codec.findEncoderByName('libfdk_aac' as never) !== null;

/** Synthesize s16 mono sine PCM frames as node-av Frames. */
async function *sineFrames(count: number, samplesPerFrame: number, sampleRate: number): AsyncGenerator<Frame | null> {
  for (let i = 0; i < count; i++) {
    const buf = Buffer.alloc(samplesPerFrame * 2);
    for (let s = 0; s < samplesPerFrame; s++) {
      const t = (i * samplesPerFrame + s) / sampleRate;
      buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * t) * 8000), s * 2);
    }
    yield Frame.fromAudioBuffer(buf, {
      nbSamples: samplesPerFrame,
      format: AV_SAMPLE_FMT_S16,
      sampleRate,
      channelLayout: AV_CHANNEL_LAYOUT_MONO,
      timeBase: { num: 1, den: sampleRate },
      pts: BigInt(i * samplesPerFrame),
    });
  }
  yield null;
}

/** Encode sine PCM to raw AAC-ELD frames via libfdk — the shape a device emitting raw ELD delivers. */
async function makeEldFrames(count: number): Promise<Buffer[]> {
  const encoder = await Encoder.create('libfdk_aac' as FFEncoderCodec, {
    context: { timeBase: new Rational(1, SAMPLE_RATE) },
    // global_header switches fdk to raw transport — ELD cannot be wrapped in
    // ADTS, which is the very property this transcoder exists to work around.
    options: { sample_rate: SAMPLE_RATE, channels: 1, profile: 'aac_eld', frame_length: FRAME_LENGTH, flags: '+global_header' },
  });
  const frames: Buffer[] = [];
  try {
    for await (using packet of encoder.packets(sineFrames(count, FRAME_LENGTH, SAMPLE_RATE))) {
      if (packet?.data) frames.push(Buffer.from(packet.data));
    }
  } finally {
    encoder.close();
  }
  return frames;
}

/** Feed frames through a transcoder and collect the produced output bytes. */
async function transcode(transcoder: RawAudioTranscoder, frames: Buffer[], settleMs = 1500): Promise<Buffer> {
  const chunks: Buffer[] = [];
  transcoder.stream.on('data', (c: Buffer) => chunks.push(c));
  await transcoder.start();
  for (const frame of frames) transcoder.push(frame);
  await new Promise((r) => setTimeout(r, settleMs));
  await transcoder.close();
  return Buffer.concat(chunks);
}

describe('buildAacEldConfig', () => {
  it('builds the canonical 16kHz mono configs', () => {
    expect(buildAacEldConfig(16000, 1, 480)).toBe('f8f03000');
    expect(buildAacEldConfig(16000, 1, 512)).toBe('f8f02000');
  });

  it('rejects non-standard sample rates', () => {
    expect(() => buildAacEldConfig(12345, 1, 480)).toThrow(/sample rate/i);
  });
});

describe('RawAudioTranscoder', () => {
  it.skipIf(!hasFdk)('normalizes raw AAC-ELD frames to demuxable ADTS AAC-LC', async () => {
    // 100 frames × 480 samples @16kHz = 3s of real ELD — bare frames with no
    // container, exactly the shape a raw-ELD source delivers (undecodable as ADTS).
    const eldFrames = await makeEldFrames(100);
    expect(eldFrames.length).toBeGreaterThan(90);

    const transcoder = new RawAudioTranscoder({
      from: {
        codec: 'aac',
        decoder: 'libfdk_aac',
        sampleRate: SAMPLE_RATE,
        channels: 1,
        samplesPerFrame: FRAME_LENGTH,
        config: buildAacEldConfig(SAMPLE_RATE, 1, FRAME_LENGTH),
      },
      to: { bitRate: 32000 },
    });
    const adts = await transcode(transcoder, eldFrames);
    expect(adts.length).toBeGreaterThan(0);
    // ADTS syncword on the very first frame — the output is self-describing.
    expect(adts[0]).toBe(0xff);
    expect(adts[1] & 0xf0).toBe(0xf0);

    // The output must probe as plain AAC 16kHz mono with no side information.
    const demuxer = await Demuxer.open(adts, { format: 'aac' } as never);
    try {
      const audio = demuxer.audio();
      expect(audio).toBeTruthy();
      expect(audio!.codecpar.sampleRate).toBe(SAMPLE_RATE);
      let packets = 0;
      for await (using packet of demuxer.packets()) {
        void packet;
        packets++;
      }
      // ~3s at 1024 samples per AAC-LC frame ≈ 46 packets; require most of it
      // so a silently-dropping pipeline fails the test.
      expect(packets).toBeGreaterThan(35);
    } finally {
      await demuxer.close();
    }
  }, 30_000);

  it('transcodes raw G.711 frames through the default decoder path', async () => {
    // 50 × 160-sample µ-law frames (20ms @8kHz) — the non-AAC RTP wrap and
    // default decoder resolution, no codec config needed.
    const mulawFrames = Array.from({ length: 50 }, () => Buffer.alloc(160, 0xff));
    const transcoder = new RawAudioTranscoder({
      from: { codec: 'pcm_mulaw', sampleRate: 8000, channels: 1, samplesPerFrame: 160 },
      to: { bitRate: 24000 },
    });
    const adts = await transcode(transcoder, mulawFrames);
    expect(adts.length).toBeGreaterThan(0);
    expect(adts[0]).toBe(0xff);
    expect(adts[1] & 0xf0).toBe(0xf0);
  }, 30_000);

  it('is safe to close without ever starting', async () => {
    const transcoder = new RawAudioTranscoder({
      from: { codec: 'pcm_mulaw', sampleRate: 8000, channels: 1, samplesPerFrame: 160 },
    });
    transcoder.push(Buffer.alloc(160)); // no-op before start
    await transcoder.close();
  });
});
