import {
  AV_HWDEVICE_TYPE_CUDA,
  AV_HWDEVICE_TYPE_MEDIACODEC,
  AV_HWDEVICE_TYPE_VAAPI,
  AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
  AV_NOPTS_VALUE,
  AV_PIX_FMT_NV12,
  AV_PIX_FMT_P010LE,
  AV_PIX_FMT_YUVJ420P,
  FF_THREAD_FRAME,
  FF_THREAD_SLICE,
} from 'node-av/constants';
import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';

import { liveThreading, measureFps, outputSize, videoGraph } from '../video-transcoder.js';

import type { HardwareContext } from 'node-av/api';
import type { CodecContext } from 'node-av/lib';
import type { GraphInput, GraphTarget } from '../video-transcoder.js';

// the graph builder only reads the device type, no device has to exist
const vt = { deviceType: AV_HWDEVICE_TYPE_VIDEOTOOLBOX, deviceTypeName: 'videotoolbox' } as HardwareContext;
const vaapi = { deviceType: AV_HWDEVICE_TYPE_VAAPI, deviceTypeName: 'vaapi' } as HardwareContext;
const cuda = { deviceType: AV_HWDEVICE_TYPE_CUDA, deviceTypeName: 'cuda' } as HardwareContext;
const mediacodec = { deviceType: AV_HWDEVICE_TYPE_MEDIACODEC, deviceTypeName: 'mediacodec' } as HardwareContext;

const sw = (format = AV_PIX_FMT_YUVJ420P): GraphInput => ({ hw: false, format, width: 640, height: 480 });
const gpu = (format = AV_PIX_FMT_NV12): GraphInput => ({ hw: true, format, width: 640, height: 480 });
const target = (overrides: Partial<GraphTarget> = {}): GraphTarget => ({ width: 640, height: 480, hwEncoder: true, hwFilter: true, ...overrides });

describe('outputSize', () => {
  it('keeps the source size without options', () => {
    expect(outputSize(1920, 1080, {})).toEqual({ width: 1920, height: 1080 });
  });

  it('follows the aspect ratio when one side is given, rounded to even', () => {
    expect(outputSize(1920, 1080, { height: 720 })).toEqual({ width: 1280, height: 720 });
    expect(outputSize(1920, 1080, { width: 640 })).toEqual({ width: 640, height: 360 });
    expect(outputSize(640, 480, { height: 101 })).toEqual({ width: 134, height: 102 });
  });

  it('takes both sides as given, rounded to even', () => {
    expect(outputSize(1920, 1080, { width: 641, height: 479 })).toEqual({ width: 642, height: 480 });
  });

  it('cannot derive a side from an unknown source size', () => {
    expect(outputSize(0, 0, { height: 720 })).toEqual({ width: 0, height: 0 });
  });
});

describe('videoGraph', () => {
  it('needs nothing for device frames an encoder on the same device takes as they are', () => {
    expect(videoGraph(gpu(), target(), vt)).toBeUndefined();
  });

  it('scales and converts on the device', () => {
    expect(videoGraph(gpu(), target({ width: 320, height: 240 }), vt)).toBe('scale_vt=320:240');
    expect(videoGraph(gpu(), target({ width: 320, height: 240 }), vaapi)).toBe('scale_vaapi=320:240');
    expect(videoGraph(gpu(AV_PIX_FMT_P010LE), target(), cuda)).toBe('scale_cuda=format=nv12');
  });

  it('refuses device scaling on a device without a scaler', () => {
    expect(() => videoGraph(gpu(), target({ width: 320, height: 240 }), mediacodec)).toThrow(/cannot scale/);
  });

  it('round-trips device frames through software filters when device filters are off', () => {
    expect(videoGraph(gpu(), target({ hwFilter: false }), vt)).toBeUndefined();
    expect(videoGraph(gpu(), target({ width: 320, height: 240, hwFilter: false }), vt)).toBe('hwdownload,format=nv12,scale=320:240,format=nv12,hwupload');
  });

  it('downloads device frames for a software encoder', () => {
    expect(videoGraph(gpu(), target({ hwEncoder: false }), vt)).toBe('hwdownload,format=nv12,format=yuv420p');
    expect(videoGraph(gpu(), target({ width: 320, height: 240, hwEncoder: false }), vt)).toBe('hwdownload,format=nv12,scale=320:240,format=yuv420p');
  });

  it('uploads software frames for a hardware encoder and scales after the upload', () => {
    expect(videoGraph(sw(), target(), vt)).toBe('format=nv12,hwupload');
    expect(videoGraph(sw(), target({ width: 320, height: 240 }), vt)).toBe('format=nv12,hwupload,scale_vt=320:240');
    expect(videoGraph(sw(), target(), cuda)).toBe('format=nv12,hwupload_cuda');
  });

  it('scales before the upload when device filters are off', () => {
    expect(videoGraph(sw(), target({ width: 320, height: 240, hwFilter: false }), vt)).toBe('scale=320:240,format=nv12,hwupload');
  });

  it('stays in 4:2:0 software without a device', () => {
    expect(videoGraph(sw(), target({ hwEncoder: false }), undefined)).toBe('format=yuv420p');
    expect(videoGraph(sw(), target({ width: 320, height: 240, hwEncoder: false, hwFilter: false }), undefined)).toBe('scale=320:240,format=yuv420p');
  });
});

describe('measureFps', () => {
  const clock = { num: 1, den: 90_000 };
  // timestamps of a camera sending every `step` ticks
  const live = (from: number, step: number, count: number): bigint[] => Array.from({ length: count }, (_, i) => BigInt(from + i * step));

  it('waits for half a second of four intervals or a second of two', () => {
    expect(measureFps([], clock)).toBeUndefined();
    expect(measureFps(live(0, 9000, 5), clock)).toBeUndefined();
    expect(measureFps(live(0, 9000, 6), clock)).toBe(10);
    expect(measureFps(live(0, 90_000, 2), clock)).toBeUndefined();
    expect(measureFps(live(0, 90_000, 3), clock)).toBe(1);
  });

  it('measures whole frames per second from jittery arrival times', () => {
    expect(measureFps([0n, 8100n, 18_900n, 26_100n, 36_000n, 45_900n], clock)).toBe(10);
    expect(measureFps(live(0, 1001, 17), { num: 1, den: 30_000 })).toBe(30);
  });

  it('skips the frames a live input buffered while it was probed', () => {
    // six frames read at once after the open, then 15 fps
    const burst = live(0, 90, 6);
    expect(measureFps([...burst, ...live(6000, 6000, 7)], clock)).toBeUndefined();
    expect(measureFps([...burst, ...live(6000, 6000, 8)], clock)).toBe(15);
  });

  it('skips buffered frames that were read slowly', () => {
    // read behind a busy event loop, 1 to 15 ms apart, as seen with software decoding
    const burst = [4254n, 4381n, 4970n, 6087n, 6421n];
    expect(measureFps([...burst, ...live(10_150, 6000, 7)], clock)).toBeUndefined();
    expect(measureFps([...burst, ...live(10_150, 6000, 9)], clock)).toBe(15);
    // a burst read at a steady 20 ms still differs too much from the camera's pace
    expect(measureFps([...live(0, 1800, 6), ...live(15_000, 6000, 7)], clock)).toBeUndefined();
    expect(measureFps([...live(0, 1800, 6), ...live(15_000, 6000, 9)], clock)).toBe(15);
  });

  it('keeps the rate across a single stall', () => {
    expect(measureFps([...live(0, 6000, 5), ...live(60_000, 6000, 5)], clock)).toBe(15);
  });

  it('sorts b-frames into presentation order', () => {
    expect(measureFps([0n, 18_000n, 6000n, 12_000n, 36_000n, 24_000n, 30_000n, 54_000n, 42_000n, 48_000n], clock)).toBe(15);
  });

  it('counts whole groups of a source that never arrives steadily', () => {
    // frames that arrive `size` at a time, 1 ms apart, a group every `every` ticks
    const grouped = (size: number, every: number, count: number, from = 0): bigint[] =>
      Array.from({ length: count }, (_, i) => BigInt(from + Math.floor(i / size) * every + (i % size) * 90));
    // pairs at 8 fps: a second of groups after the start settled, at 1.5 s
    expect(measureFps(grouped(2, 22_500, 12), clock)).toBeUndefined();
    expect(measureFps(grouped(2, 22_500, 13), clock)).toBe(8);
    // pairs at 4 fps, also at 1.5 s and far before a transcoder times out
    expect(measureFps(grouped(2, 45_000, 6), clock)).toBeUndefined();
    expect(measureFps(grouped(2, 45_000, 7), clock)).toBe(4);
    expect(measureFps(grouped(3, 45_000, 10), clock)).toBe(6);
    // after frames that piled up at the start
    expect(measureFps([...live(0, 90, 6), ...grouped(2, 22_500, 13, 22_500)], clock)).toBe(8);
  });

  it('falls back to 25 when the timestamps cannot tell', () => {
    expect(measureFps(Array<bigint>(59).fill(0n), clock)).toBeUndefined();
    expect(measureFps(Array<bigint>(60).fill(0n), clock)).toBe(25);
    expect(measureFps([0n, AV_NOPTS_VALUE], clock)).toBe(25);
  });
});

describe('liveThreading', () => {
  // only the fields the function touches
  const context = (device: boolean): CodecContext => ({ hwDeviceCtx: device ? {} : null, threadCount: 0, threadType: FF_THREAD_FRAME }) as unknown as CodecContext;

  it('slices on the device', () => {
    const device = context(true);
    liveThreading(device);
    expect(device.threadType).toBe(FF_THREAD_SLICE);
    expect(device.threadCount).toBe(0);
  });

  it('caps the frame threads of a software decoder', () => {
    const software = context(false);
    liveThreading(software);
    expect(software.threadType).toBe(FF_THREAD_FRAME);
    expect(software.threadCount).toBe(availableParallelism() > 1 ? Math.min(availableParallelism() + 1, 4) : 1);
  });
});
