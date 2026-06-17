/**
 * Multi-Source Relay
 *
 * Combines several upstream inputs into one relay using {@link MultiSource}, which opens each
 * input as its own demuxer and flattens their streams into a single multi-track source. This is
 * the pattern for cameras that expose video and audio as separate raw elementary streams that
 * cannot be opened as one libav input. The merged stream is re-served over RTSP.
 *
 * Usage: tsx examples/multi-source.ts <video_url> [audio_url]
 *
 * Examples:
 *   tsx examples/multi-source.ts rtsp://camera/video rtsp://camera/audio
 *   tsx examples/multi-source.ts rtsp://camera/video
 */

import { Relay } from '../src/index.js';
import { MultiSource } from '../src/sources/index.js';

import type { MultiSourceInput } from '../src/sources/index.js';

const videoUrl = process.argv[2] ?? 'rtsp://127.0.0.1:8554/video';
const audioUrl = process.argv[3];

// Each entry becomes its own demuxer; a `format` hint is required for raw elementary streams
// (e.g. an h264/aac sub-stream) because there is no container for libav to probe.
const inputs: MultiSourceInput[] = [{ input: videoUrl, format: 'h264', options: { rtsp_transport: 'tcp' } }];
if (audioUrl) inputs.push({ input: audioUrl, format: 'aac', options: { rtsp_transport: 'tcp' } });

// MultiSource interleaves packets from every input and rewrites stream indices into one global
// track space, so downstream sinks see a single source even though there are multiple upstreams.
const source = new MultiSource(inputs, { logger: console });

const relay = new Relay({ source, logger: console });

// Re-serve the merged tracks as one RTSP endpoint; the source opens lazily on the first viewer.
const server = await relay.serveRtsp({ host: '0.0.0.0', port: 8554, path: 'live' });
console.log(`Serving ${inputs.length} merged input(s) at ${server.url}`);

relay.on('start', (info) => {
  // After open(), tracks from all inputs share one flattened index space.
  for (const track of info.tracks) console.log(`  track #${track.index} ${track.kind} ${track.codec}`);
});

// Drain and stop the relay (and every input demuxer) on Ctrl+C so the process exits cleanly.
process.on('SIGINT', () => {
  relay.stop().then(() => process.exit(0));
});
