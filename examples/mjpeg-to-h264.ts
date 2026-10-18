/**
 * MJPEG to H.264
 *
 * Serves an MJPEG camera as an H.264 RTSP stream. Frames are stamped with their
 * arrival time, because MJPEG carries no timestamps, and re-encoded with the
 * hardware encoder of the machine when one is available, otherwise with
 * libx264.
 *
 * Usage: tsx examples/mjpeg-to-h264.ts <mjpeg_url> [port] [path]
 *
 * Examples:
 *   tsx examples/mjpeg-to-h264.ts http://camera.local/video.mjpg
 *   tsx examples/mjpeg-to-h264.ts http://camera.local/mjpeg 8554 garden
 */

import { AvSource, Relay, RtspServerSink } from '../src/index.js';

const input = process.argv[2] ?? 'http://camera.local/video.mjpg';
const port = Number(process.argv[3] ?? 8554);
const path = process.argv[4] ?? 'live';

const source = new AvSource(input, { format: 'mpjpeg', wallclock: true, reconnect: true, logger: console });
const relay = new Relay({ source, idleTimeout: 10_000, stallTimeout: 10_000, logger: console });

const server = await new RtspServerSink(relay, {
  host: '0.0.0.0',
  port,
  path,
  // a keyframe every second lets new viewers start quickly
  transcode: { video: { codec: 'h264', bitRate: 2_000_000, gopSize: 15 } },
  logger: console,
}).listen();

console.log(`serving ${input} as H.264 at ${server.url}`);

process.on('SIGINT', () => {
  server
    .shutdown()
    .then(() => relay.stop())
    .then(() => process.exit(0));
});
