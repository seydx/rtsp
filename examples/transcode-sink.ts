/**
 * Transcoding Recorder
 *
 * Records a camera as H.264 with AAC audio, scaled to a given height. The
 * TranscodeSink in front of the FfmpegSink re-encodes only what does not match
 * already, and runs decoding, scaling and encoding on the GPU when the machine
 * has one. Pass --software to compare against the CPU path.
 *
 * Usage: tsx examples/transcode-sink.ts <input_url> [output] [height] [--software]
 *
 * Options:
 *   <input_url>   Camera or file to record (default: rtsp://localhost:8554/stream)
 *   [output]      Destination mp4 file (default: transcoded.mp4)
 *   [height]      Output height in pixels, the width follows the aspect ratio (default: 720)
 *   --software    Stay on the CPU
 *
 * Examples:
 *   tsx examples/transcode-sink.ts rtsp://camera/live
 *   tsx examples/transcode-sink.ts http://camera/video.mjpg garden.mp4 480
 *   tsx examples/transcode-sink.ts rtsp://camera/live cpu.mp4 720 --software
 */

import { AvSource, FfmpegSink, Relay, TranscodeSink } from '../src/index.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--software');
const software = process.argv.includes('--software');
const url = args[0] ?? 'rtsp://localhost:8554/stream';
const output = args[1] ?? 'transcoded.mp4';
const height = Number(args[2] ?? 720);

// mjpeg over http carries no timestamps, arrival times stand in for them
const mjpeg = /^https?:/.test(url);
const source = new AvSource(url, mjpeg ? { format: 'mpjpeg', wallclock: true } : { transport: 'tcp' });
const relay = new Relay({ source, logger: console });

const recorder = new TranscodeSink(new FfmpegSink({ output, format: 'mp4' }), {
  hardware: !software,
  video: { codec: 'h264', height, bitRate: 2_000_000 },
  audio: { codec: 'aac' },
  // prints the chosen decoder, filter graph and encoder
  logger: { debug: console.log, warn: console.warn, error: console.error },
});
relay.pipe(recorder);

relay.on('error', (error) => console.error('relay error:', error));

// stop() drains the encoders and writes the mp4 trailer, without it the file is unplayable
process.on('SIGINT', () => {
  relay.stop().then(() => process.exit(0));
});

await relay.start();
console.log(`recording ${url} to ${output} at ${height}p, press Ctrl+C to stop`);
