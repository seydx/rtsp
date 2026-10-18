import { Demuxer, Encoder } from 'node-av/api';
import { AV_CHANNEL_LAYOUT_MONO, AV_SAMPLE_FMT_S16 } from 'node-av/constants';
import { Codec, Frame, Rational } from 'node-av/lib';
import { describe, expect, it } from 'vitest';

import { buildAacEldConfig, RawAudioTranscoder } from '../raw-audio-transcoder.js';

import type { FFEncoderCodec } from 'node-av/constants';

const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 480;

const hasFdk = Codec.findDecoderByName('libfdk_aac' as never) !== null && Codec.findEncoderByName('libfdk_aac' as never) !== null;

function sineFrames(count: number, samplesPerFrame: number, sampleRate: number): Frame[] {
  const frames: Frame[] = [];
  for (let i = 0; i < count; i++) {
    const buffer = Buffer.alloc(samplesPerFrame * 2);
    for (let s = 0; s < samplesPerFrame; s++) {
      const t = (i * samplesPerFrame + s) / sampleRate;
      buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * t) * 8000), s * 2);
    }
    frames.push(
      Frame.fromAudioBuffer(buffer, {
        nbSamples: samplesPerFrame,
        format: AV_SAMPLE_FMT_S16,
        sampleRate,
        channelLayout: AV_CHANNEL_LAYOUT_MONO,
        timeBase: { num: 1, den: sampleRate },
        pts: BigInt(i * samplesPerFrame),
      }),
    );
  }
  return frames;
}

// bare AAC-ELD frames without container, the shape a raw-ELD device delivers
function makeEldFrames(count: number): Buffer[] {
  const encoder = Encoder.createSync('libfdk_aac' as FFEncoderCodec, {
    context: { timeBase: new Rational(1, SAMPLE_RATE) },
    // global_header switches fdk to raw transport, ELD cannot be wrapped in ADTS
    options: { sample_rate: SAMPLE_RATE, channels: 1, profile: 'aac_eld', frame_length: FRAME_LENGTH, flags: '+global_header' },
  });
  const frames: Buffer[] = [];
  const collect = (packets: { data: Buffer | null; free(): void }[]): void => {
    for (const packet of packets) {
      if (packet.data) frames.push(Buffer.from(packet.data));
      packet.free();
    }
  };
  try {
    for (const frame of sineFrames(count, FRAME_LENGTH, SAMPLE_RATE)) {
      collect(encoder.encodeAllSync(frame));
      frame.free();
    }
    collect(encoder.encodeAllSync(null));
  } finally {
    encoder.close();
  }
  return frames;
}

async function transcode(transcoder: RawAudioTranscoder, frames: Buffer[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  transcoder.stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((resolve) => transcoder.stream.once('end', resolve));
  transcoder.start();
  for (const frame of frames) transcoder.push(frame);
  transcoder.close();
  await ended;
  return Buffer.concat(chunks);
}

async function countAdtsPackets(adts: Buffer): Promise<{ sampleRate: number; packets: number }> {
  const demuxer = await Demuxer.open(adts, { format: 'aac' });
  try {
    let packets = 0;
    for await (const packet of demuxer.packets()) {
      if (!packet) continue;
      packets++;
      packet.free();
    }
    return { sampleRate: demuxer.streams[0].codecpar.sampleRate, packets };
  } finally {
    await demuxer.close();
  }
}

describe('buildAacEldConfig', () => {
  it('builds the canonical 16 kHz mono configs', () => {
    expect(buildAacEldConfig(16000, 1, 480)).toBe('f8f03000');
    expect(buildAacEldConfig(16000, 1, 512)).toBe('f8f02000');
  });

  it('encodes sample rate and channels', () => {
    // object type 39, frequency index 3, two channels, 480-sample frames
    expect(buildAacEldConfig(48000, 2, 480)).toBe('f8e65000');
  });

  it('rejects non-standard sample rates and frame lengths', () => {
    expect(() => buildAacEldConfig(12345, 1, 480)).toThrow(/sample rate/i);
    expect(() => buildAacEldConfig(16000, 1, 1024 as never)).toThrow(/frame length/i);
  });
});

describe('RawAudioTranscoder', () => {
  it.skipIf(!hasFdk)(
    'turns raw AAC-ELD frames into demuxable ADTS AAC-LC',
    async () => {
      // 100 frames of 480 samples at 16 kHz are 3s of audio
      const eldFrames = makeEldFrames(100);
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
      expect(adts[0]).toBe(0xff);
      expect(adts[1] & 0xf0).toBe(0xf0);

      const { sampleRate, packets } = await countAdtsPackets(adts);
      expect(sampleRate).toBe(SAMPLE_RATE);
      // 3s at 1024 samples per frame are about 47 frames, a pipeline that drops audio falls short
      expect(packets).toBeGreaterThan(44);
    },
    30_000,
  );

  it('transcodes raw G.711 frames including the tail', async () => {
    // 50 frames of 20ms are one second, 8000 samples resampled to 1024-sample AAC frames
    const transcoder = new RawAudioTranscoder({
      from: { codec: 'pcm_mulaw', sampleRate: 8000, channels: 1, samplesPerFrame: 160 },
      to: { bitRate: 24000 },
    });
    const adts = await transcode(
      transcoder,
      Array.from({ length: 50 }, () => Buffer.alloc(160, 0xff)),
    );
    expect(adts[0]).toBe(0xff);
    const { packets } = await countAdtsPackets(adts);
    // without the flush on close the last frames stay in the encoder
    expect(packets).toBeGreaterThanOrEqual(8);
  });

  it('honours the target format', async () => {
    const transcoder = new RawAudioTranscoder({
      from: { codec: 'pcm_mulaw', sampleRate: 8000, channels: 1, samplesPerFrame: 160 },
      to: { codec: 'pcm_s16le', format: 's16le', sampleRate: 16000 },
    });
    const pcm = await transcode(
      transcoder,
      Array.from({ length: 50 }, () => Buffer.alloc(160, 0xff)),
    );
    // one second at 16 kHz mono s16, give or take the resampler delay
    expect(pcm.length).toBeGreaterThan(31_000);
    expect(pcm.length).toBeLessThanOrEqual(32_000);
  });

  it('ignores input before start and empty frames', async () => {
    const transcoder = new RawAudioTranscoder({ from: { codec: 'pcm_mulaw', sampleRate: 8000, channels: 1, samplesPerFrame: 160 } });
    transcoder.push(Buffer.alloc(160));
    const ended = new Promise((resolve) => transcoder.stream.once('end', resolve));
    transcoder.stream.resume();
    transcoder.close();
    transcoder.close();
    await ended;
  });

  it('cannot start again once closed', () => {
    const transcoder = new RawAudioTranscoder({ from: { codec: 'pcm_mulaw', sampleRate: 8000, channels: 1, samplesPerFrame: 160 } });
    transcoder.start();
    transcoder.start();
    transcoder.close();
    expect(() => transcoder.start()).toThrow(/closed/);
  });

  it('rejects unknown codecs', () => {
    const transcoder = new RawAudioTranscoder({ from: { codec: 'not-a-codec', sampleRate: 8000, channels: 1, samplesPerFrame: 160 } });
    expect(() => transcoder.start()).toThrow(/Unsupported audio decoder/);
    const encoder = new RawAudioTranscoder({ from: { codec: 'pcm_mulaw', sampleRate: 8000, channels: 1, samplesPerFrame: 160 }, to: { codec: 'not-a-codec' } });
    expect(() => encoder.start()).toThrow(/Unsupported audio encoder/);
  });
});
