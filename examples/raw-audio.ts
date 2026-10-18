/**
 * Raw Audio Frames
 *
 * Turns bare audio frames, as some devices deliver them over proprietary
 * protocols, into an ADTS AAC stream that a MultiSource serves next to the
 * video. The example generates silent G.711 frames; a real integration pushes
 * the frames it receives from the device. Both inputs are stamped with their
 * arrival time, so they stay in sync whatever clocks the device uses.
 *
 * Usage: tsx examples/raw-audio.ts <video_url>
 *
 * Examples:
 *   tsx examples/raw-audio.ts rtsp://user:pass@camera.local/stream
 */

import { MultiSource, RawAudioTranscoder, Relay, RtspServerSink } from '../src/index.js';

const video = process.argv[2] ?? 'rtsp://user:pass@camera.local/stream';

// 20ms of 8 kHz mu-law per frame
const transcoder = new RawAudioTranscoder({
  from: { codec: 'pcm_mulaw', sampleRate: 8000, channels: 1, samplesPerFrame: 160 },
  to: { codec: 'aac', bitRate: 32_000 },
  onError: (error) => console.error('audio failed:', error),
});
transcoder.start();
const timer = setInterval(() => transcoder.push(Buffer.alloc(160, 0xff)), 20);

const source = new MultiSource([
  { input: video, options: { rtsp_transport: 'tcp' }, wallclock: true },
  { input: transcoder.stream, format: 'aac', wallclock: true },
]);
const relay = new Relay({ source, logger: console });
const server = await new RtspServerSink(relay).listen();
console.log(`serving at ${server.url}`);

process.on('SIGINT', () => {
  clearInterval(timer);
  transcoder.close();
  server
    .shutdown()
    .then(() => relay.stop())
    .then(() => process.exit(0));
});
