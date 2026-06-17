/**
 * FFmpeg Sink Recording
 *
 * Opens an RTSP source through a relay and pipes it into an FfmpegSink that remuxes
 * the stream into a container file. Streams are copied, not re-encoded, so recording
 * stays cheap and lossless.
 *
 * Usage: tsx examples/ffmpeg-sink.ts <rtsp_url> [output] [format]
 *
 * Options:
 *   <rtsp_url>  RTSP input URL to record (default: rtsp://localhost:8554/stream)
 *   [output]    Destination file path (default: out.ts)
 *   [format]    Container/muxer format (default: mpegts)
 *
 * Examples:
 *   tsx examples/ffmpeg-sink.ts rtsp://camera/live
 *   tsx examples/ffmpeg-sink.ts rtsp://camera/live recording.mp4 mp4
 */

import { Relay } from '../src/index.js';
import { AvSource } from '../src/sources/index.js';
import { FfmpegSink } from '../src/sinks/index.js';

const url = process.argv[2] ?? 'rtsp://localhost:8554/stream';
const output = process.argv[3] ?? 'out.ts';
const format = process.argv[4] ?? 'mpegts';

// Force TCP transport so the recording is not corrupted by UDP packet loss.
const source = new AvSource(url, { transport: 'tcp' });
const relay = new Relay({ source });

// Remux (copy) the relayed tracks into the chosen container; format is explicit
// rather than inferred so the same code works for extension-less outputs too.
const sink = new FfmpegSink({ output, format });
relay.pipe(sink);

// EOF/disconnect: the relay flushes sinks (writing the container trailer) on its own.
relay.on('end', () => console.log('Upstream ended; recording finalized.'));
relay.on('error', (error) => console.error('Relay error:', error));

// SIGINT must await stop() so the muxer writes its trailer and the file stays playable.
process.on('SIGINT', () => {
  console.log('\nStopping...');
  void relay.stop().then(() => process.exit(0));
});

await relay.start();
console.log(`Recording ${url} -> ${output} (${format}). Press Ctrl+C to stop.`);
