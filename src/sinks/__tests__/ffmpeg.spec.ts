import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Fixtures, hasFfmpeg, probe } from '../../__tests__/helpers/media.js';
import { Relay } from '../../relay.js';
import { AvSource } from '../../sources/av.js';
import { FfmpegSink } from '../ffmpeg.js';

import type { Sink } from '../../types.js';

const suite = hasFfmpeg ? describe : describe.skip;

// 'stop' fires once the sinks drained their queues and wrote their trailers
function relayInto(file: string, sink: Sink): Promise<void> {
  const relay = new Relay({ source: new AvSource(file) });
  return new Promise<void>((resolve, reject) => {
    relay.on('stop', resolve);
    relay.on('error', reject);
    relay.on('sink:error', (_sink, error) => reject(error));
    relay.pipe(sink);
  });
}

suite('FfmpegSink', () => {
  let fixtures: Fixtures;
  let av: string;

  beforeAll(async () => {
    fixtures = await Fixtures.create();
    av = await fixtures.clip('av', 1);
  }, 30_000);

  afterAll(async () => {
    await fixtures?.dispose();
  });

  it('remuxes the relayed stream into a file', async () => {
    const out = fixtures.path('remuxed.ts');
    await relayInto(av, new FfmpegSink({ output: out, format: 'mpegts' }));
    expect((await probe(out)).map((stream) => stream.codec)).toEqual(['h264', 'aac']);
  });

  it('remuxes mp4 into matroska despite its codec tags', async () => {
    // mp4's avc1 and mp4a are invalid in matroska, the muxer has to pick its own
    const out = fixtures.path('remuxed.mkv');
    await relayInto(av, new FfmpegSink({ output: out, format: 'matroska' }));
    expect((await probe(out)).map((stream) => stream.codec)).toEqual(['h264', 'aac']);
  });

  it('writes into a Writable', async () => {
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    await relayInto(av, new FfmpegSink({ output, format: 'mpegts' }));
    const bytes = Buffer.concat(chunks);
    // mpegts is a sequence of 188-byte packets starting with the 0x47 sync byte
    expect(bytes.length).toBeGreaterThan(188 * 10);
    expect(bytes.length % 188).toBe(0);
    expect(bytes[0]).toBe(0x47);
  });

  it('passes muxer options through', async () => {
    const out = fixtures.path('fragmented.mp4');
    await relayInto(av, new FfmpegSink({ output: out, format: 'mp4', options: { movflags: 'frag_keyframe+empty_moov' } }));
    expect((await probe(out)).length).toBe(2);
  });

  it('can be closed without init and twice', async () => {
    const sink = new FfmpegSink({ output: fixtures.path('never.ts'), format: 'mpegts' });
    await sink.close();
    await sink.close();
  });
});
