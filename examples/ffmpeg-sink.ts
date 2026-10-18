/**
 * FFmpeg Sink Recording
 *
 * Records a relayed source into a container file with an FfmpegSink. Streams
 * are copied, not re-encoded, so recording is cheap and lossless.
 *
 * Usage: tsx examples/ffmpeg-sink.ts <rtsp_url> [output] [format]
 *
 * Options:
 *   <rtsp_url>  RTSP input URL to record (default: rtsp://localhost:8554/stream)
 *   [output]    Destination file path (default: out.ts)
 *   [format]    Container format (default: mpegts)
 *
 * Examples:
 *   tsx examples/ffmpeg-sink.ts rtsp://camera/live
 *   tsx examples/ffmpeg-sink.ts rtsp://camera/live recording.mp4 mp4
 */

import { AvSource, FfmpegSink, Relay } from '../src/index.js';

const url = process.argv[2] ?? 'rtsp://localhost:8554/stream';
const output = process.argv[3] ?? 'out.ts';
const format = process.argv[4] ?? 'mpegts';

const relay = new Relay({ source: new AvSource(url, { transport: 'tcp' }) });

// the recording starts at the next keyframe, so the file is playable from its first frame
relay.pipe(new FfmpegSink({ output, format }));

relay.on('end', () => console.log('upstream ended, recording finalized'));
relay.on('error', (error) => console.error('relay error:', error));

// stop() waits for the muxer to write its trailer, without it an mp4 is unplayable
process.on('SIGINT', () => {
  relay.stop().then(() => process.exit(0));
});

await relay.start();
console.log(`recording ${url} to ${output} (${format}), press Ctrl+C to stop`);
