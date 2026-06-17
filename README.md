# @seydx/rtsp

[![npm version](https://img.shields.io/npm/v/@seydx/rtsp.svg)](https://www.npmjs.com/package/@seydx/rtsp)
[![npm downloads](https://img.shields.io/npm/dt/@seydx/rtsp.svg)](https://www.npmjs.com/package/@seydx/rtsp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

A small, modern media relay: connect **one** upstream source and fan it out to **many** consumers — the source only ever holds a single connection.

```
Source ──▶ Relay (fan-out hub) ──▶ Sink…
                                 ├─ RTSP server  (many rtsp:// pullers)
                                 ├─ FFmpeg        (transcode / remux)
                                 └─ Callback      (raw packets)
```

All codec and protocol heavy-lifting is delegated to [`node-av`](https://github.com/seydx/node-av); this package is the orchestration layer plus a lean multi-client RTSP server.

**[Documentation](https://seydx.github.io/rtsp)**

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Sources](#sources)
- [Sinks](#sinks)
- [Two-Way Audio](#two-way-audio)
- [Lifecycle](#lifecycle)
- [Examples](#examples)
- [License](#license)

## Installation

```bash
npm install @seydx/rtsp
```

`node-av` is pulled in automatically and ships the prebuilt FFmpeg binaries, so no separate FFmpeg install is needed. Requires Node.js 22+.

## Quick Start

```typescript
import { Relay, CallbackSink, FfmpegSink } from '@seydx/rtsp';
import { AvSource } from '@seydx/rtsp/sources';

const relay = new Relay({
  source: new AvSource('rtsp://user:pass@cam/stream', { transport: 'tcp' }),
  idleTimeout: 5_000, // tear down the upstream when the last sink leaves
});

// Fan out to many RTSP pullers from a single upstream connection.
const server = await relay.serveRtsp({ path: 'live' });
console.log(server.url); // rtsp://127.0.0.1:<port>/live

// …or pipe to ffmpeg / a raw callback.
relay.pipe(new FfmpegSink({ output: 'out.ts', format: 'mpegts' }));
relay.pipe(new CallbackSink({ onPacket: (packet) => {/* raw packets */} }));
```

The upstream is lazy: it opens on the first sink and, after `idleTimeout`, closes once the last sink leaves.

## Sources

A source is a single-connection upstream. Two are built in (importable from `@seydx/rtsp/sources`):

- **`AvSource`** — a node-av-backed demuxer for RTSP, files, and byte streams. Supports transport selection, read-rate pacing, looping, and the ONVIF backchannel.
- **`MultiSource`** — merges several inputs (e.g. a camera that exposes audio and video as separate streams) into one flattened multi-track source.

```typescript
import { MultiSource } from '@seydx/rtsp/sources';

const source = new MultiSource([
  { input: 'rtsp://cam/video' },
  { input: 'rtsp://cam/audio' },
]);
```

Implement the `Source` contract to add your own.

## Sinks

A sink consumes the relayed stream. Three are built in (importable from `@seydx/rtsp/sinks`):

- **`RtspServerSink`** — re-serves the relay as a multi-client `rtsp://` endpoint. Created via `relay.serveRtsp()`.
- **`FfmpegSink`** — remuxes the stream into another container, in-process, via a node-av muxer (stream copy, no child process).
- **`CallbackSink`** — delivers raw packets to your own callback.

Implement the `Sink` contract to add your own.

## Two-Way Audio

Talkback (ONVIF backchannel) sends audio from a viewer back to the camera. The source must request the backchannel:

```typescript
const relay = new Relay({
  source: new AvSource('rtsp://cam/stream', { transport: 'tcp', backchannel: true }),
});

// Pass-through: advertise the camera's own talkback codec; forward viewer RTP as-is.
await relay.serveRtsp({ path: 'live', backchannel: true });

// …or transcode: advertise a different codec to viewers; the relay converts it
// to the camera's codec in-process.
await relay.serveRtsp({
  path: 'live',
  backchannel: { codec: 'opus', payloadType: 97, clockRate: 48000, channels: 2 },
});
```

## Lifecycle

The relay is an event emitter. A newly attached sink is held until the next keyframe so it starts on a clean GOP, and a slow sink is isolated from the rest.

```typescript
relay.on('start', (info) => console.log('upstream live:', info.tracks.length, 'tracks'));
relay.on('sink:added', () => {});
relay.on('sink:removed', () => {});
relay.on('end', () => {}); // upstream ended on its own
relay.on('error', (err) => console.error(err));

await relay.stop(); // tear down the upstream and every sink
```

## Examples

Runnable examples live in [`examples/`](https://github.com/seydx/rtsp/tree/main/examples). Run any with `tsx`:

```bash
tsx examples/basic-relay.ts rtsp://user:pass@cam/stream
```

## License

MIT
