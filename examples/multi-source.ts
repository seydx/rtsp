/**
 * Multi-Source Relay
 *
 * Merges separate video and audio inputs into one relay with a MultiSource and
 * serves them as a single RTSP stream. This fits cameras that deliver raw
 * elementary streams which cannot be opened as one input.
 *
 * Usage: tsx examples/multi-source.ts <video_url> [audio_url]
 *
 * Examples:
 *   tsx examples/multi-source.ts rtsp://camera/video rtsp://camera/audio
 *   tsx examples/multi-source.ts rtsp://camera/video
 */

import { MultiSource, Relay, RtspServerSink } from '../src/index.js';

import type { MultiSourceInput } from '../src/index.js';

const videoUrl = process.argv[2] ?? 'rtsp://127.0.0.1:8554/video';
const audioUrl = process.argv[3];

// raw elementary streams need a format, there is no container to probe
const inputs: MultiSourceInput[] = [{ input: videoUrl, format: 'h264', options: { rtsp_transport: 'tcp' } }];
if (audioUrl) inputs.push({ input: audioUrl, format: 'aac', options: { rtsp_transport: 'tcp' } });

const relay = new Relay({ source: new MultiSource(inputs, { logger: console }), logger: console });

relay.on('start', (info) => {
  for (const track of info.tracks) console.log(`track #${track.index} ${track.kind} ${track.codec}`);
});

const server = await new RtspServerSink(relay, { host: '0.0.0.0', port: 8554, path: 'live' }).listen();
console.log(`serving ${inputs.length} merged input(s) at ${server.url}`);

process.on('SIGINT', () => {
  void server
    .shutdown()
    .then(() => relay.stop())
    .then(() => process.exit(0));
});
