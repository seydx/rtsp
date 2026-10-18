# @seydx/rtsp

[![npm version](https://img.shields.io/npm/v/@seydx/rtsp.svg)](https://www.npmjs.com/package/@seydx/rtsp)
[![npm downloads](https://img.shields.io/npm/dt/@seydx/rtsp.svg)](https://www.npmjs.com/package/@seydx/rtsp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

A small media relay for Node.js. It connects to **one** upstream source and fans it out to **many** consumers, so a camera only ever holds a single connection, however many viewers, recorders and analyzers use the stream.

```
Source ──▶ Relay ──▶ Sinks
                     ├─ RtspServerSink  many rtsp:// viewers, optional re-encoding and talkback
                     ├─ FfmpegSink      recording and remuxing
                     ├─ CallbackSink    raw packets in your code
                     └─ TranscodeSink   re-encoding in front of any of them
```

Demuxing, decoding, encoding and muxing are done by [node-av](https://github.com/seydx/node-av), which ships prebuilt FFmpeg binaries with hardware acceleration. This package adds the orchestration and a lean multi-client RTSP server.

**[Documentation](https://seydx.github.io/rtsp)**

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Sources](#sources)
- [Sinks](#sinks)
- [RTSP Server](#rtsp-server)
- [Transcoding](#transcoding)
- [Two-Way Audio](#two-way-audio)
- [Raw Audio Frames](#raw-audio-frames)
- [Snapshots](#snapshots)
- [Lifecycle](#lifecycle)
- [Examples](#examples)
- [License](#license)

## Installation

```bash
npm install @seydx/rtsp node-av
```

Requires Node.js 24 or newer. node-av brings its own FFmpeg, no separate install is needed.

## Quick Start

```typescript
import { AvSource, CallbackSink, FfmpegSink, Relay, RtspServerSink } from '@seydx/rtsp';

const relay = new Relay({
  source: new AvSource('rtsp://user:pass@camera.local/stream', { transport: 'tcp', reconnect: true }),
  // close the camera connection 5s after the last consumer left
  idleTimeout: 5000,
});

// many viewers, one camera connection
const server = await new RtspServerSink(relay, { port: 8554, path: 'live' }).listen();
console.log(server.url); // rtsp://127.0.0.1:8554/live

// record and inspect the same stream
relay.pipe(new FfmpegSink({ output: 'recording.ts', format: 'mpegts' }));
relay.pipe(new CallbackSink({ onPacket: (packet) => console.log(packet.streamIndex, packet.isKeyframe) }));
```

The upstream is lazy. It opens when the first sink is piped and closes after `idleTimeout` once the last one left. Every sink starts at a video keyframe, and a slow sink skips ahead instead of holding up the others.

## Sources

A source is one upstream connection. Two are built in.

**`AvSource`** demuxes anything FFmpeg can open: RTSP, HTTP, files, a `Buffer` or a `Readable`. It can pace files at their natural rate, loop them, reconnect with backoff, stamp packets with their arrival time for inputs without usable timestamps, and request the ONVIF backchannel.

```typescript
import { AvSource } from '@seydx/rtsp';

const camera = new AvSource('rtsp://camera.local/stream', {
  transport: 'tcp',
  timeout: 10_000,
  reconnect: { delay: 1000, maxDelay: 30_000 },
});
```

**`MultiSource`** merges several inputs into one source, for devices that deliver video and audio as separate raw streams.

```typescript
import { MultiSource } from '@seydx/rtsp';

const source = new MultiSource([
  { input: videoStream, format: 'h264', options: { framerate: 15 } },
  { input: audioStream, format: 'aac' },
]);
```

If one input fails, the whole source fails, unless that input reconnects on its own. Only the reconnecting input is reopened, the others keep delivering, and its timeline skips the time it was gone. A `timeout` makes a stalled input fail instead of hanging, and an `optional` input that cannot be opened is left out instead of keeping the others from starting:

```typescript
const source = new MultiSource([
  { input: 'http://camera.local/video.mjpg', format: 'mpjpeg', wallclock: true },
  // missing audio does not hold the video back, a dropped one comes back by itself
  { input: 'http://camera.local/audio.wav', wallclock: true, timeout: 5000, reconnect: true, optional: true },
]);
```

Implement the `Source` interface to bring your own.

## Sinks

A sink consumes the relayed stream. Four are built in.

- **`RtspServerSink`** serves the relay to many RTSP viewers, see below.
- **`FfmpegSink`** muxes the stream into a file, a `Writable` or custom I/O callbacks, without re-encoding.
- **`CallbackSink`** hands every packet to your callback.
- **`TranscodeSink`** re-encodes tracks on their way into another sink, see [Transcoding](#transcoding).

Implement the `Sink` interface to bring your own. A packet belongs to the relay and is freed once `write()` settled, so clone it to keep it longer.

## RTSP Server

`RtspServerSink` is a multi-client RTSP server over TCP-interleaved transport. It attaches to the relay when the first viewer asks for the stream and detaches a few seconds after the last one left. Every track is packetized once, whatever the number of viewers.

```typescript
import { RtspAuth, RtspServerSink } from '@seydx/rtsp';

const server = await new RtspServerSink(relay, {
  host: '0.0.0.0',
  port: 8554,
  path: 'camera',
  auth: new RtspAuth({ username: 'viewer', password: 'secret' }),
}).listen();

server.on('viewer:added', (count) => console.log(`${count} watching`));
```

Tracks can be re-encoded on the way, once for all viewers, with the options described under [Transcoding](#transcoding). A typical case is an MJPEG camera served as H.264:

```typescript
const relay = new Relay({ source: new AvSource('http://camera.local/video.mjpg', { format: 'mpjpeg', wallclock: true, reconnect: true }) });

const server = await new RtspServerSink(relay, {
  transcode: { video: { codec: 'h264', bitRate: 2_000_000 } },
}).listen();
```

## Transcoding

`TranscodeSink` wraps any sink and re-encodes tracks before they reach it. Video becomes H.264 or HEVC, audio any format FFmpeg can encode. A track that already has the requested format is copied instead, so only the tracks that need it pay for re-encoding.

```typescript
import { FfmpegSink, TranscodeSink } from '@seydx/rtsp';

// record a camera as 720p H.264 with AAC audio
relay.pipe(
  new TranscodeSink(new FfmpegSink({ output: 'camera.mp4', format: 'mp4' }), {
    video: { codec: 'h264', height: 720, bitRate: 2_000_000 },
    audio: { codec: 'aac' },
  }),
);
```

Video runs on one hardware device from start to end. Decoding, scaling and encoding stay on the GPU where it can handle them, and each stage falls back to software on its own, for example when the GPU cannot decode the camera's codec. By default the best device is detected once and shared by every transcoder of the process. `hardware: false` stays in software, `HardwareOptions` open a dedicated device and a `HardwareContext` from node-av is used as given:

```typescript
import { AV_HWDEVICE_TYPE_VAAPI } from 'node-av/constants';

new TranscodeSink(sink, { hardware: { prefer: AV_HWDEVICE_TYPE_VAAPI, device: '/dev/dri/renderD129' }, video: { codec: 'hevc' } });
```

Options can be decided per track, and `force` re-encodes a track even when it already matches:

```typescript
new TranscodeSink(sink, {
  // only the main stream, a second video track passes through
  video: (track) => (track.index === 0 ? { codec: 'h264', width: 1280 } : undefined),
  audio: { codec: 'aac', sampleRate: 16000, channels: 1, force: true },
});
```

Width or height alone keeps the aspect ratio. The wrapped sink is initialized once every re-encoded track produced its first packet, so it sees the final codec parameters; a track that stays silent for `timeout` (10 seconds by default) is left out. Video from sources that report no frame rate, such as MJPEG over HTTP, starts half a second to two seconds late, because the encoder needs the measured rate for its level, rate control and keyframe interval.

## Two-Way Audio

Viewers can send talkback audio back to the camera over the ONVIF backchannel. Request it on the source and enable it on the server:

```typescript
const relay = new Relay({ source: new AvSource('rtsp://camera.local/stream', { transport: 'tcp', backchannel: true }) });

// advertise the camera's own talkback format, viewer audio is forwarded unchanged
await new RtspServerSink(relay, { backchannel: true }).listen();
```

Advertise a different format to viewers and the server converts it to the camera's codec:

```typescript
await new RtspServerSink(relay, {
  backchannel: { advertise: { codec: 'pcm_alaw', payloadType: 8, clockRate: 8000, channels: 1 } },
}).listen();
```

The server emits every talkback packet as `backchannel` and the bursts as `backchannel:start` and `backchannel:stop`, so devices with proprietary talkback can be fed with a `BackchannelTranscoder`. One viewer talks at a time: the first one to send keeps the backchannel until it stays silent for `idleTimeout` or leaves, talkback of other viewers is dropped meanwhile.

## Raw Audio Frames

Some devices deliver bare audio frames without any container, for example raw AAC-ELD. `RawAudioTranscoder` turns them into an ADTS stream that a source can demux:

```typescript
import { buildAacEldConfig, MultiSource, RawAudioTranscoder } from '@seydx/rtsp';

const audio = new RawAudioTranscoder({
  from: { codec: 'aac', decoder: 'libfdk_aac', sampleRate: 16000, channels: 1, samplesPerFrame: 480, config: buildAacEldConfig(16000, 1, 480) },
});
audio.start();
device.on('audio', (frame: Buffer) => audio.push(frame));

const source = new MultiSource([
  { input: videoStream, format: 'h264' },
  { input: audio.stream, format: 'aac' },
]);
```

## Snapshots

`grabFrame` takes the next frame of a relay's video track from the shared upstream, so a camera that accepts a single client serves snapshots and viewers over one connection. The frame comes as the source encoded it: for an MJPEG camera a complete JPEG, without decoding or re-encoding.

```typescript
import { AvSource, grabFrame, Relay } from '@seydx/rtsp';

// keep the camera open for 10s, so snapshots in a row reuse the connection
const relay = new Relay({ source: new AvSource('http://camera.local/video.mjpg', { format: 'mpjpeg', wallclock: true }), idleTimeout: 10_000 });

const jpeg = await grabFrame(relay, { timeout: 5000 });
```

## Lifecycle

The relay is an event emitter:

```typescript
relay.on('start', (info) => console.log(`upstream open with ${info.tracks.length} tracks`));
relay.on('end', () => console.log('upstream ended'));
relay.on('error', (error) => console.error(error));
relay.on('sink:error', (sink, error) => console.error('a sink failed', error));

await relay.stop();
```

Set `stallTimeout` to fail a stream whose upstream stays connected but stops sending. Route FFmpeg's own log output into your logger with `installNativeLogging(logger)`.

## Examples

Runnable examples live in [`examples/`](https://github.com/seydx/rtsp/tree/main/examples):

```bash
tsx examples/basic-relay.ts rtsp://user:pass@camera.local/stream
tsx examples/mjpeg-to-h264.ts http://camera.local/video.mjpg
tsx examples/snapshot.ts http://camera.local/video.mjpg snapshot.jpg
tsx examples/transcode-sink.ts rtsp://user:pass@camera.local/stream camera.mp4
```

## License

MIT
