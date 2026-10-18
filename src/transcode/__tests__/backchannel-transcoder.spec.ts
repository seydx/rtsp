import { Demuxer } from 'node-av/api';
import { AV_CODEC_ID_PCM_ALAW } from 'node-av/constants';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRtp, Fixtures, hasFfmpeg, toRtp } from '../../__tests__/helpers/media.js';
import { isRtcp } from '../../util/rtp.js';
import { BackchannelTranscoder } from '../backchannel-transcoder.js';

import type { BackchannelTranscoderOptions } from '../backchannel-transcoder.js';

const suite = hasFfmpeg ? describe : describe.skip;

const MULAW = { codec: 'pcm_mulaw', payloadType: 0, clockRate: 8000, channels: 1 };

function run(options: Omit<BackchannelTranscoderOptions, 'output'>, inbound: Buffer[]): Buffer[] {
  const out: Buffer[] = [];
  const transcoder = new BackchannelTranscoder({ ...options, output: (chunk) => out.push(chunk) });
  transcoder.start();
  try {
    for (const rtp of inbound) transcoder.push(rtp);
  } finally {
    transcoder.close();
  }
  return out;
}

suite('BackchannelTranscoder', () => {
  let fixtures: Fixtures;
  let mulaw: Buffer[];

  beforeAll(async () => {
    fixtures = await Fixtures.create();
    mulaw = await toRtp(await fixtures.clip('mulaw', 1), 0);
  }, 30_000);

  afterAll(async () => {
    await fixtures?.dispose();
  });

  it('converts mu-law RTP to a-law RTP selected by codec id', () => {
    const out = run({ from: MULAW, to: { codecId: AV_CODEC_ID_PCM_ALAW, sampleRate: 8000, channels: 1 } }, mulaw);
    expect(out.length).toBeGreaterThan(10);
    expect(out.every((rtp) => (rtp[1] & 0x7f) === 8)).toBe(true);
  });

  it('converts by codec name and stamps the requested payload type', () => {
    const out = run({ from: MULAW, to: { codec: 'pcm_alaw', sampleRate: 8000, channels: 1, payloadType: 110 } }, mulaw);
    expect(out.length).toBeGreaterThan(10);
    expect(out.every((rtp) => (rtp[1] & 0x7f) === 110)).toBe(true);
  });

  it('never forwards the RTCP reports of its muxer', () => {
    // a muxer writes a sender report before its first media packet
    const out = run({ from: MULAW, to: { codec: 'pcm_alaw', sampleRate: 8000, channels: 1 } }, mulaw);
    expect(out.some((chunk) => isRtcp(chunk))).toBe(false);
  });

  it('writes raw container bytes for non-RTP talkback', () => {
    const out = run({ from: MULAW, to: { codec: 'pcm_s16le', sampleRate: 8000, channels: 1, format: 's16le' } }, mulaw);
    // one second of 8 kHz mono s16
    expect(Buffer.concat(out).length).toBe(16_000);
  });

  it('encodes AAC as ADTS with resampling', () => {
    const bytes = Buffer.concat(run({ from: MULAW, to: { codec: 'aac', sampleRate: 16000, channels: 2, format: 'adts' } }, mulaw));
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1] & 0xf0).toBe(0xf0);
  });

  it('decodes AAC talkback described by its fmtp config', async () => {
    const file = await fixtures.clip('aac', 1);
    const demuxer = await Demuxer.open(file);
    const config = demuxer.streams[0].codecpar.extradata!.toString('hex');
    await demuxer.close();
    const inbound = await toRtp(file, 96);

    const fmtp = `streamtype=5;profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=${config}`;
    const out = run({ from: { codec: 'aac', payloadType: 96, clockRate: 16000, channels: 1, fmtp }, to: { codec: 'pcm_mulaw', sampleRate: 8000, channels: 1 } }, inbound);
    const payload = out.reduce((sum, rtp) => sum + rtp.length - 12, 0);
    // a second of 8 kHz, minus the encoder delay at the start
    expect(payload).toBeGreaterThan(6000);
    expect(out.every((rtp) => (rtp[1] & 0x7f) === 0)).toBe(true);
  });

  it('downmixes and resamples opus talkback', async () => {
    const inbound = await toRtp(await fixtures.clip('opus', 1), 111);
    const out = run({ from: { codec: 'opus', payloadType: 111, clockRate: 48000, channels: 2 }, to: { codec: 'pcm_alaw', sampleRate: 8000, channels: 1 } }, inbound);
    const payload = out.reduce((sum, rtp) => sum + rtp.length - 12, 0);
    expect(payload).toBeGreaterThan(6000);
  });

  it('ignores foreign payload types, empty payloads and input before start', () => {
    const out: Buffer[] = [];
    const transcoder = new BackchannelTranscoder({ from: MULAW, to: { codec: 'pcm_alaw', sampleRate: 8000, channels: 1 }, output: (chunk) => out.push(chunk) });
    transcoder.push(mulaw[0]);
    expect(transcoder.active).toBe(false);

    transcoder.start();
    transcoder.start();
    expect(transcoder.active).toBe(true);
    transcoder.push(buildRtp(8, 1, 0, Buffer.alloc(160)));
    transcoder.push(buildRtp(0, 1, 0, Buffer.alloc(0)));
    transcoder.push(Buffer.from([1, 2, 3]));
    expect(out).toHaveLength(0);

    transcoder.close();
    transcoder.close();
    expect(transcoder.active).toBe(false);
  });

  it('refuses to start without a target codec or an AAC config', () => {
    expect(() => new BackchannelTranscoder({ from: MULAW, to: { sampleRate: 8000, channels: 1 }, output: () => undefined }).start()).toThrow(/codec/);
    const aac = { codec: 'aac', payloadType: 96, clockRate: 16000, channels: 1, fmtp: 'mode=AAC-hbr' };
    expect(() => new BackchannelTranscoder({ from: aac, to: { codec: 'pcm_alaw', sampleRate: 8000, channels: 1 }, output: () => undefined }).start()).toThrow(/config/);
  });

  it('reports a failing output and shuts down', () => {
    const errors: unknown[] = [];
    const transcoder = new BackchannelTranscoder({
      from: MULAW,
      to: { codec: 'pcm_alaw', sampleRate: 8000, channels: 1 },
      output: () => {
        throw new Error('socket gone');
      },
      onError: (error) => errors.push(error),
    });
    transcoder.start();
    for (const rtp of mulaw.slice(0, 5)) transcoder.push(rtp);
    expect(errors).toEqual([new Error('socket gone')]);
    expect(transcoder.active).toBe(false);
  });
});
