import { HardwareContext } from 'node-av/api';
import { AV_CODEC_ID_H264, AV_HWDEVICE_TYPE_MEDIACODEC, AV_LOG_FATAL, AV_LOG_WARNING } from 'node-av/constants';
import { Codec, Log, Packet } from 'node-av/lib';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Fixtures, hasFfmpeg } from '../../__tests__/helpers/media.js';
import { wrapAvPacket } from '../../av-packet.js';
import { Relay } from '../../relay.js';
import { CallbackSink } from '../../sinks/callback.js';
import { FfmpegSink } from '../../sinks/ffmpeg.js';
import { AvSource } from '../../sources/av.js';
import { TranscodeSink } from '../transcode-sink.js';

import type { Stream } from 'node-av/lib';
import type { MediaPacket, Sink, Source, StreamInfo } from '../../types.js';
import type { TranscodeSinkOptions } from '../transcode-sink.js';

const suite = hasFfmpeg ? describe : describe.skip;

const detected = HardwareContext.auto();
const hasDevice = detected !== null;
const decodesH264 = !!detected?.getDecoderCodec(AV_CODEC_ID_H264);
detected?.dispose();

/**
 * What the wrapped sink saw. Streams are read at init, synthetic ones are freed on close.
 */
interface Seen {
  inits: { index: number; codec: string; native?: Stream; width: number; height: number; extradata: number; sampleRate: number; channels: number }[][];
  packets: { index: number; keyframe: boolean }[];
  closes: number;
}

function recorder(): { sink: CallbackSink; seen: Seen } {
  const seen: Seen = { inits: [], packets: [], closes: 0 };
  const sink = new CallbackSink({
    onInit: (info: StreamInfo) => {
      seen.inits.push(
        info.tracks.map((track) => {
          const par = track.native?.codecpar;
          return {
            index: track.index,
            codec: track.codec,
            native: track.native,
            width: par?.width ?? 0,
            height: par?.height ?? 0,
            extradata: par?.extradataSize ?? 0,
            sampleRate: par?.sampleRate ?? 0,
            channels: par?.channelLayout.nbChannels ?? 0,
          };
        }),
      );
    },
    onPacket: (packet) => {
      seen.packets.push({ index: packet.streamIndex, keyframe: packet.isKeyframe });
    },
    onClose: () => {
      seen.closes++;
    },
  });
  return { sink, seen };
}

async function run(source: Source, sink: Sink): Promise<void> {
  const relay = new Relay({ source });
  await new Promise<void>((resolve, reject) => {
    relay.on('stop', resolve);
    relay.on('error', reject);
    relay.pipe(sink);
  });
}

function count(seen: Seen, index: number): number {
  return seen.packets.filter((packet) => packet.index === index).length;
}

// level_idc from avcC or annex-b extradata
function h264Level(extradata: Buffer | null): number {
  if (!extradata) return -1;
  if (extradata[0] === 1) return extradata[3];
  for (let i = 0; i + 6 < extradata.length; i++) {
    if (extradata[i] === 0 && extradata[i + 1] === 0 && extradata[i + 2] === 1 && (extradata[i + 3] & 0x1f) === 7) return extradata[i + 6];
  }
  return -1;
}

// bytes no h264 decoder makes a frame of
function garbage(keyframe: boolean): MediaPacket {
  const packet = new Packet();
  packet.alloc();
  packet.data = Buffer.alloc(64, 0x55);
  packet.streamIndex = 0;
  packet.isKeyframe = keyframe;
  return wrapAvPacket(packet);
}

// a packet that reaches a lane without anything to decode
function empty(streamIndex: number): MediaPacket {
  const packet: MediaPacket = { streamIndex, isKeyframe: true, clone: () => packet, free: () => undefined };
  return packet;
}

suite('TranscodeSink', () => {
  let fixtures: Fixtures;
  let mjpeg: string;
  let av: string;
  let mulaw: string;

  beforeAll(async () => {
    fixtures = await Fixtures.create();
    [mjpeg, av, mulaw] = await Promise.all([fixtures.clip('mjpegmkv'), fixtures.clip('av'), fixtures.clip('mulaw')]);
  }, 30_000);

  afterAll(async () => {
    await fixtures?.dispose();
  });

  it.each([
    ['software', false],
    ['the default hardware', true],
  ])(
    're-encodes MJPEG to H.264 in %s and drains every frame',
    async (_name, hardware) => {
      const { sink, seen } = recorder();
      await run(new AvSource(mjpeg), new TranscodeSink(sink, { hardware, video: { codec: 'h264', bitRate: 500_000 } }));

      expect(seen.inits).toHaveLength(1);
      const [video] = seen.inits[0];
      expect(video).toMatchObject({ index: 0, codec: 'h264', width: 320, height: 240 });
      // global headers, so rtsp and mp4 find the parameter sets
      expect(video.extradata).toBeGreaterThan(0);
      expect(seen.packets[0].keyframe).toBe(true);
      // 2s at 15 fps, the encoder delay is drained on close
      expect(count(seen, 0)).toBe(30);
      expect(seen.closes).toBe(1);
    },
    20_000,
  );

  it.each([
    ['software', false],
    ['the default hardware', true],
  ])(
    'scales to one side keeping the aspect ratio in %s',
    async (_name, hardware) => {
      const { sink, seen } = recorder();
      await run(new AvSource(mjpeg), new TranscodeSink(sink, { hardware, video: { height: 120 } }));
      expect(seen.inits[0][0]).toMatchObject({ codec: 'h264', width: 160, height: 120 });
      expect(count(seen, 0)).toBe(30);
    },
    20_000,
  );

  it.each([
    ['software', false],
    ['the default hardware', true],
  ])(
    'measures the frame rate of live MJPEG for a playable H.264 level in %s',
    async (_name, hardware) => {
      const data = await readFile(await fixtures.clip('mjpeg', 2));
      const feed = new PassThrough();
      const levels: number[] = [];
      const rates: number[] = [];
      const seen = { frames: 0, keyframes: 0 };
      const sink = new CallbackSink({
        onInit: (info) => {
          const { codecpar, avgFrameRate } = info.tracks[0].native!;
          levels.push(h264Level(codecpar.extradata));
          rates.push(avgFrameRate.num / avgFrameRate.den);
        },
        onPacket: (packet) => {
          seen.frames++;
          if (packet.isKeyframe) seen.keyframes++;
        },
      });
      const relay = new Relay({ source: new AvSource(feed, { format: 'mpjpeg', wallclock: true }) });
      const stopped = new Promise<void>((resolve) => relay.on('stop', () => resolve()));
      // mpjpeg reports the end of the feed as invalid data
      relay.on('error', () => undefined);
      relay.pipe(new TranscodeSink(sink, { hardware, video: {} }));

      // 30 frames over two seconds, as a 15 fps camera delivers them; the first
      // half second piles up while the input is probed and arrives at once
      const chunks = 40;
      const size = Math.ceil(data.length / chunks);
      for (let i = 0; i < chunks; i++) {
        feed.write(data.subarray(i * size, (i + 1) * size));
        if (i >= 10) await delay(50);
      }
      feed.end();
      await stopped;

      // a 90 kHz clock taken as the frame rate made x264 pick level 6.2,
      // the burst taken as the rate made it 240 fps with a keyframe every 16 s
      expect(rates[0]).toBeGreaterThanOrEqual(13);
      expect(rates[0]).toBeLessThanOrEqual(17);
      expect(levels[0]).toBeGreaterThan(0);
      expect(levels[0]).toBeLessThan(30);
      expect(seen.frames).toBeGreaterThan(20);
      // one keyframe per measured second
      expect(seen.keyframes).toBeGreaterThanOrEqual(2);
    },
    20_000,
  );

  it('measures a live MJPEG camera that sends its frames in pairs', async () => {
    const data = await readFile(await fixtures.clip('mjpeg', 3));
    const frames: Buffer[] = [];
    for (let at = data.indexOf('--ffmpeg'), next; at >= 0; at = next) {
      next = data.indexOf('--ffmpeg', at + 1);
      frames.push(data.subarray(at, next < 0 ? data.length : next));
    }
    const feed = new PassThrough();
    const rates: number[] = [];
    let count = 0;
    const sink = new CallbackSink({
      onInit: (info) => {
        const { avgFrameRate } = info.tracks[0].native!;
        rates.push(avgFrameRate.num / avgFrameRate.den);
      },
      onPacket: () => {
        count++;
      },
    });
    const relay = new Relay({ source: new AvSource(feed, { format: 'mpjpeg', wallclock: true }) });
    const stopped = new Promise<void>((resolve) => relay.on('stop', () => resolve()));
    relay.on('error', () => undefined);
    relay.pipe(new TranscodeSink(sink, { hardware: false, video: {} }));

    // 15 fps that never arrive steadily: two frames at once, then a pause of two intervals
    for (let i = 0; i < frames.length; i += 2) {
      feed.write(Buffer.concat(frames.slice(i, i + 2)));
      await delay(2000 / 15);
    }
    feed.end();
    await stopped;

    expect(rates[0]).toBeGreaterThanOrEqual(13);
    expect(rates[0]).toBeLessThanOrEqual(17);
    expect(count).toBeGreaterThan(30);
  }, 20_000);

  it('copies tracks that already match and passes everything through', async () => {
    const direct = recorder();
    await run(new AvSource(av), direct.sink);

    const source = new AvSource(av);
    const { sink, seen } = recorder();
    let natives: (Stream | undefined)[] = [];
    source.open = ((open) => async () => {
      const info = await open();
      natives = info.tracks.map((track) => track.native);
      return info;
    })(source.open.bind(source));
    await run(source, new TranscodeSink(sink, { video: { codec: 'h264' }, audio: { codec: 'aac' } }));

    expect(seen.inits[0].map((track) => track.native)).toEqual(natives);
    expect(seen.inits[0][0].native).toBe(natives[0]);
    expect(seen.packets).toEqual(direct.seen.packets);
  });

  it('re-encodes a matching track when forced', async () => {
    const { sink, seen } = recorder();
    await run(new AvSource(av), new TranscodeSink(sink, { hardware: false, video: { codec: 'h264', force: true, gopSize: 5 } }));
    const [video, audio] = seen.inits[0];
    expect(video.codec).toBe('h264');
    expect(audio.codec).toBe('aac');
    expect(count(seen, 0)).toBe(30);
    expect(seen.packets.filter((packet) => packet.index === 0 && packet.keyframe).length).toBe(6);
  });

  it('re-encodes audio to another rate and layout', async () => {
    const { sink, seen } = recorder();
    await run(new AvSource(av), new TranscodeSink(sink, { audio: { codec: 'aac', sampleRate: 16000, channels: 1 } }));
    const [video, audio] = seen.inits[0];
    expect(video.codec).toBe('h264');
    expect(audio).toMatchObject({ codec: 'aac', sampleRate: 16000, channels: 1 });
    expect(audio.extradata).toBeGreaterThan(0);
    expect(count(seen, 1)).toBeGreaterThan(20);
  });

  it('decides per track with a function', async () => {
    const asked: string[] = [];
    const { sink, seen } = recorder();
    await run(
      new AvSource(av),
      new TranscodeSink(sink, {
        video: (track) => {
          asked.push(`video ${track.codec}`);
          return undefined;
        },
        audio: (track) => {
          asked.push(`audio ${track.codec}`);
          return { codec: 'libopus' };
        },
      }),
    );
    expect(asked).toEqual(['video h264', 'audio aac']);
    expect(seen.inits[0].map((track) => track.codec)).toEqual(['h264', 'opus']);
  });

  it('turns mu-law into AAC for a recording', async () => {
    const out = fixtures.path('mulaw.m4a');
    const sink = new TranscodeSink(new FfmpegSink({ output: out, format: 'mp4' }), { audio: { codec: 'aac' } });
    await run(new AvSource(mulaw), sink);
    const probe = new AvSource(out);
    const info = await probe.open();
    await probe.close();
    expect(info.tracks.map((track) => track.codec)).toEqual(['aac']);
  });

  it('records MJPEG as H.264 into a container', async () => {
    const out = fixtures.path('mjpeg.mp4');
    await run(new AvSource(mjpeg), new TranscodeSink(new FfmpegSink({ output: out, format: 'mp4' }), { video: { codec: 'h264' } }));
    const { sink, seen } = recorder();
    await run(new AvSource(out), sink);
    expect(seen.inits[0][0]).toMatchObject({ codec: 'h264', width: 320, height: 240 });
    expect(count(seen, 0)).toBe(30);
  }, 20_000);

  it('leaves a silent track out after the timeout', async () => {
    const source = new AvSource(av);
    const info = await source.open();
    const warnings: string[] = [];
    const { sink, seen } = recorder();
    const transcoder = new TranscodeSink(sink, {
      hardware: false,
      video: { codec: 'h264', force: true },
      timeout: 100,
      logger: { warn: (message: unknown) => warnings.push(String(message)) },
    });
    try {
      await transcoder.init(info);
      const controller = new AbortController();
      for await (const packet of source.packets(controller.signal)) {
        // the video lane never gets anything to decode
        await transcoder.write(packet.streamIndex === 0 ? empty(0) : packet);
        packet.free();
        if (seen.inits.length > 0) break;
        await delay(5);
      }
      controller.abort();
      expect(seen.inits[0].map((track) => track.codec)).toEqual(['aac']);
      expect(seen.packets.length).toBeGreaterThan(0);
      expect(seen.packets.every((packet) => packet.index === 1)).toBe(true);
      expect(warnings.some((warning) => warning.includes('leaving video track #0 out'))).toBe(true);
    } finally {
      await transcoder.close();
      await source.close();
    }
  });

  it('fails when no track produced output in time', async () => {
    // the native streams belong to the source, it stays open while they are in use
    const source = new AvSource(av);
    const info = await source.open();
    const { sink, seen } = recorder();
    const transcoder = new TranscodeSink(sink, { hardware: false, video: { codec: 'h264', force: true }, audio: { force: true }, timeout: 50 });
    try {
      await transcoder.init(info);
      await transcoder.write(empty(0));
      await delay(80);
      await expect(transcoder.write(empty(0))).rejects.toThrow(/no track produced output within 50ms/);
      await transcoder.close();
      expect(seen.inits).toHaveLength(0);
      expect(seen.closes).toBe(1);
    } finally {
      await source.close();
    }
  });

  it('closes the wrapped sink even without a stream', async () => {
    const { sink, seen } = recorder();
    await new TranscodeSink(sink, { video: {} }).close();
    expect(seen.closes).toBe(1);
  });

  it('passes a failing init on and releases what it created', async () => {
    const source = new AvSource(av);
    const info = await source.open();
    const { sink, seen } = recorder();
    // the video transcoder is created before the audio one fails
    const transcoder = new TranscodeSink(sink, { hardware: false, video: { force: true }, audio: { codec: 'no_such_encoder' } });
    try {
      await expect(transcoder.init(info)).rejects.toThrow(/Unsupported audio encoder/);
      await transcoder.close();
      expect(seen.inits).toHaveLength(0);
      expect(seen.packets).toHaveLength(0);
    } finally {
      await source.close();
    }
  });

  it('can be used for another stream after close', async () => {
    const { sink, seen } = recorder();
    const transcoder = new TranscodeSink(sink, { hardware: false, video: { codec: 'h264' } });
    await run(new AvSource(mjpeg), transcoder);
    await run(new AvSource(mjpeg), transcoder);
    expect(seen.inits).toHaveLength(2);
    expect(seen.closes).toBe(2);
    expect(count(seen, 0)).toBe(60);
  }, 20_000);

  describe.skipIf(!hasDevice)('on a hardware device', () => {
    // the real device with one capability hidden or broken
    function device(overrides: Record<string, unknown>): HardwareContext {
      const real = HardwareContext.auto()!;
      return new Proxy(real, {
        get: (target, key) => {
          if (key in overrides) return overrides[key as string];
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    }

    function options(hardware: HardwareContext, lines: string[], extra: Partial<TranscodeSinkOptions> = {}): TranscodeSinkOptions {
      const log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
      return { hardware, video: { codec: 'h264', force: true, height: 120 }, logger: { debug: log, warn: log }, ...extra };
    }

    it('downloads device frames for a software encoder', async () => {
      const hardware = device({ getEncoderCodec: () => null });
      const lines: string[] = [];
      const { sink, seen } = recorder();
      try {
        await run(new AvSource(av), new TranscodeSink(sink, options(hardware, lines)));
      } finally {
        hardware.dispose();
      }
      expect(seen.inits[0][0]).toMatchObject({ codec: 'h264', width: 160, height: 120 });
      expect(count(seen, 0)).toBe(30);
      expect(lines.join('\n')).toContain('encoding video with libx264');
    }, 20_000);

    it('filters in software when the device cannot', async () => {
      // a device type without a scaler
      const hardware = device({ deviceType: AV_HWDEVICE_TYPE_MEDIACODEC });
      const lines: string[] = [];
      const { sink, seen } = recorder();
      try {
        await run(new AvSource(mjpeg), new TranscodeSink(sink, options(hardware, lines)));
      } finally {
        hardware.dispose();
      }
      expect(seen.inits[0][0]).toMatchObject({ codec: 'h264', width: 160, height: 120 });
      expect(count(seen, 0)).toBe(30);
      expect(lines.join('\n')).toContain('filtering in software');
    }, 20_000);

    it('decodes in software when the device decoder cannot be opened', async () => {
      // an h264 decoder for an mjpeg stream refuses to open
      const hardware = device({ getDecoderCodec: () => Codec.findDecoder(AV_CODEC_ID_H264) });
      const lines: string[] = [];
      const { sink, seen } = recorder();
      try {
        await run(new AvSource(mjpeg), new TranscodeSink(sink, options(hardware, lines)));
      } finally {
        hardware.dispose();
      }
      expect(count(seen, 0)).toBe(30);
      expect(lines.join('\n')).toContain('hardware decoder unavailable');
    }, 20_000);

    it.skipIf(!decodesH264)(
      'moves to a software decoder when the device decoder produces nothing',
      async () => {
        const source = new AvSource(av);
        const info = await source.open();
        const lines: string[] = [];
        const { sink, seen } = recorder();
        const log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
        const transcoder = new TranscodeSink(sink, { video: { codec: 'h264', force: true }, logger: { warn: log } });
        try {
          await transcoder.init(info);
          // garbage the device decoder swallows without a frame, until it is given up
          Log.setLevel(AV_LOG_FATAL);
          for (let i = 0; i < 16; i++) {
            const media = garbage(false);
            await transcoder.write(media);
            media.free();
          }
          Log.setLevel(AV_LOG_WARNING);
          const controller = new AbortController();
          for await (const packet of source.packets(controller.signal)) {
            await transcoder.write(packet);
            packet.free();
          }
        } finally {
          Log.setLevel(AV_LOG_WARNING);
          await transcoder.close();
          await source.close();
        }
        expect(lines.join('\n')).toMatch(/hardware decoder \S+ failed \(\d+ decode errors\), decoding in software/);
        expect(count(seen, 0)).toBe(30);
      },
      20_000,
    );

    it.skipIf(!decodesH264)(
      'moves a running device decoder to software when it gets stuck',
      async () => {
        const source = new AvSource(av, { loop: true });
        const info = await source.open();
        const lines: string[] = [];
        const { sink, seen } = recorder();
        const log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
        const transcoder = new TranscodeSink(sink, { video: { codec: 'h264', force: true }, logger: { warn: log } });
        try {
          await transcoder.init(info);
          let video = 0;
          const controller = new AbortController();
          for await (const packet of source.packets(controller.signal)) {
            // after one healthy pass the device decoder only gets keyframes it cannot decode
            if (packet.streamIndex === 0 && ++video === 31) {
              Log.setLevel(AV_LOG_FATAL);
              for (let i = 0; i < 16; i++) {
                const media = garbage(true);
                await transcoder.write(media);
                media.free();
              }
              Log.setLevel(AV_LOG_WARNING);
            }
            await transcoder.write(packet);
            packet.free();
            if (video >= 60) break;
          }
          controller.abort();
        } finally {
          Log.setLevel(AV_LOG_WARNING);
          await transcoder.close();
          await source.close();
        }
        expect(lines.join('\n')).toMatch(/hardware decoder \S+ failed \(\d+ decode errors\), decoding in software/);
        // the second pass decodes in software from its keyframe on
        expect(count(seen, 0)).toBeGreaterThan(50);
      },
      20_000,
    );

    it('keeps a given device open for its owner', async () => {
      const hardware = HardwareContext.auto()!;
      const { sink } = recorder();
      await run(new AvSource(mjpeg), new TranscodeSink(sink, { hardware, video: {} }));
      expect(hardware.isDisposed).toBe(false);
      hardware.dispose();
    }, 20_000);
  });
});
