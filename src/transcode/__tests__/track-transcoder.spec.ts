import {
  AV_CODEC_ID_AAC,
  AV_CODEC_ID_H264,
  AV_CODEC_ID_HEVC,
  AV_CODEC_ID_MJPEG,
  AV_CODEC_ID_OPUS,
  AV_CODEC_ID_PCM_MULAW,
  AV_PIX_FMT_NONE,
  AV_PIX_FMT_P010LE,
  AV_PIX_FMT_YUV420P,
  AV_PIX_FMT_YUV420P10LE,
  AV_PIX_FMT_YUV422P,
  AV_PIX_FMT_YUVJ420P,
  AV_PROFILE_AAC_ELD,
  AV_PROFILE_AAC_LOW,
} from 'node-av/constants';
import { describe, expect, it } from 'vitest';

import { audioMatches, planTranscode, videoMatches } from '../track-transcoder.js';

import type { AVCodecID, AVPixelFormat } from 'node-av/constants';
import type { Stream } from 'node-av/lib';
import type { TrackInfo } from '../../types.js';

function videoStream(codecId: AVCodecID, width = 1280, height = 720, format: AVPixelFormat = AV_PIX_FMT_YUV420P): Stream {
  return { codecpar: { codecId, width, height, format } } as unknown as Stream;
}

function audioStream(codecId: AVCodecID, sampleRate = 48000, channels = 2, profile = AV_PROFILE_AAC_LOW): Stream {
  return { codecpar: { codecId, sampleRate, channelLayout: { nbChannels: channels }, profile } } as unknown as Stream;
}

function track(index: number, kind: TrackInfo['kind'], native?: Stream): TrackInfo {
  return { index, kind, codec: 'test', native };
}

describe('videoMatches', () => {
  it('matches the requested codec in a playable 4:2:0 format', () => {
    expect(videoMatches(videoStream(AV_CODEC_ID_H264), {})).toBe(true);
    expect(videoMatches(videoStream(AV_CODEC_ID_H264, 1280, 720, AV_PIX_FMT_YUVJ420P), { codec: 'h264' })).toBe(true);
    expect(videoMatches(videoStream(AV_CODEC_ID_HEVC), { codec: 'hevc' })).toBe(true);
    expect(videoMatches(videoStream(AV_CODEC_ID_H264), { codec: 'hevc' })).toBe(false);
    expect(videoMatches(videoStream(AV_CODEC_ID_MJPEG, 1280, 720, AV_PIX_FMT_YUVJ420P), { codec: 'h264' })).toBe(false);
  });

  it('accepts 10 bit for HEVC only', () => {
    expect(videoMatches(videoStream(AV_CODEC_ID_HEVC, 1280, 720, AV_PIX_FMT_YUV420P10LE), { codec: 'hevc' })).toBe(true);
    expect(videoMatches(videoStream(AV_CODEC_ID_HEVC, 1280, 720, AV_PIX_FMT_P010LE), { codec: 'hevc' })).toBe(true);
    expect(videoMatches(videoStream(AV_CODEC_ID_H264, 1280, 720, AV_PIX_FMT_YUV420P10LE), { codec: 'h264' })).toBe(false);
    expect(videoMatches(videoStream(AV_CODEC_ID_H264, 1280, 720, AV_PIX_FMT_YUV422P), { codec: 'h264' })).toBe(false);
  });

  it('trusts the codec of a stream whose format is not probed', () => {
    expect(videoMatches(videoStream(AV_CODEC_ID_H264, 1280, 720, AV_PIX_FMT_NONE), {})).toBe(true);
  });

  it('compares the size, one side keeping the aspect ratio', () => {
    expect(videoMatches(videoStream(AV_CODEC_ID_H264), { height: 720 })).toBe(true);
    expect(videoMatches(videoStream(AV_CODEC_ID_H264), { width: 1280, height: 720 })).toBe(true);
    expect(videoMatches(videoStream(AV_CODEC_ID_H264), { height: 480 })).toBe(false);
    expect(videoMatches(videoStream(AV_CODEC_ID_H264, 0, 0), { height: 720 })).toBe(false);
  });
});

describe('audioMatches', () => {
  it('matches the codec of the requested encoder', () => {
    expect(audioMatches(audioStream(AV_CODEC_ID_AAC), {})).toBe(true);
    expect(audioMatches(audioStream(AV_CODEC_ID_OPUS), { codec: 'libopus' })).toBe(true);
    expect(audioMatches(audioStream(AV_CODEC_ID_PCM_MULAW, 8000, 1), { codec: 'pcm_mulaw' })).toBe(true);
    expect(audioMatches(audioStream(AV_CODEC_ID_PCM_MULAW, 8000, 1), { codec: 'aac' })).toBe(false);
    expect(audioMatches(audioStream(AV_CODEC_ID_AAC), { codec: 'no_such_encoder' })).toBe(false);
  });

  it('compares sample rate and channels only when requested', () => {
    expect(audioMatches(audioStream(AV_CODEC_ID_AAC, 16000, 1), { sampleRate: 16000, channels: 1 })).toBe(true);
    expect(audioMatches(audioStream(AV_CODEC_ID_AAC, 48000, 2), { sampleRate: 16000 })).toBe(false);
    expect(audioMatches(audioStream(AV_CODEC_ID_AAC, 48000, 2), { channels: 1 })).toBe(false);
  });

  it('never copies low delay AAC', () => {
    expect(audioMatches(audioStream(AV_CODEC_ID_AAC, 16000, 1, AV_PROFILE_AAC_ELD), { codec: 'aac' })).toBe(false);
  });
});

describe('planTranscode', () => {
  it('copies matching tracks unless forced', () => {
    const h264 = track(0, 'video', videoStream(AV_CODEC_ID_H264));
    expect(planTranscode(h264, { video: { codec: 'h264' } })).toBeUndefined();
    expect(planTranscode(h264, { video: { codec: 'h264', force: true } })?.kind).toBe('video');
    expect(planTranscode(track(1, 'audio', audioStream(AV_CODEC_ID_AAC)), { audio: { force: true } })?.kind).toBe('audio');
  });

  it('plans only configured kinds with a native stream', () => {
    const mjpeg = videoStream(AV_CODEC_ID_MJPEG, 640, 480, AV_PIX_FMT_YUVJ420P);
    expect(planTranscode(track(0, 'video', mjpeg), { video: {} })).toEqual({ kind: 'video', stream: mjpeg, options: {} });
    expect(planTranscode(track(0, 'video', mjpeg), { audio: {} })).toBeUndefined();
    expect(planTranscode(track(0, 'video'), { video: {} })).toBeUndefined();
    expect(planTranscode(track(2, 'data', mjpeg), { video: {}, audio: {} })).toBeUndefined();
  });

  it('asks a function per track', () => {
    const seen: number[] = [];
    const options = {
      video: (info: TrackInfo) => {
        seen.push(info.index);
        return info.index === 0 ? { codec: 'h264' as const } : undefined;
      },
    };
    const mjpeg = videoStream(AV_CODEC_ID_MJPEG, 640, 480, AV_PIX_FMT_YUVJ420P);
    expect(planTranscode(track(0, 'video', mjpeg), options)?.options).toEqual({ codec: 'h264' });
    expect(planTranscode(track(1, 'video', mjpeg), options)).toBeUndefined();
    expect(seen).toEqual([0, 1]);
  });
});
