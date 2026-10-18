/**
 * Two-Way Audio with Transcoding
 *
 * Serves a camera with a talkback codec that differs from the one the camera
 * accepts. Viewers send PCMA, which every RTSP client supports, and the server
 * converts it to the camera's own backchannel codec on the fly.
 *
 * Usage: tsx examples/backchannel-transcode.ts <rtsp_url> [port] [path]
 *
 * Examples:
 *   tsx examples/backchannel-transcode.ts rtsp://user:pass@192.168.1.50/stream
 *   tsx examples/backchannel-transcode.ts rtsp://cam.local/onvif 8554 talk
 */

import { AvSource, Relay, RtspServerSink } from '../src/index.js';

import type { BackchannelFormat } from '../src/index.js';

const input = process.argv[2] ?? 'rtsp://127.0.0.1:8554/camera';
const port = Number(process.argv[3] ?? 8554);
const path = process.argv[4] ?? 'live';

const source = new AvSource(input, { transport: 'tcp', backchannel: true, logger: console });
const relay = new Relay({ source, logger: console });

// what viewers see, the camera keeps its own codec
const advertise: BackchannelFormat = { codec: 'pcm_alaw', payloadType: 8, clockRate: 8000, channels: 1 };

const server = await new RtspServerSink(relay, { port, path, backchannel: { advertise, idleTimeout: 2000 }, logger: console }).listen();

console.log(`serving ${server.url}, talkback advertised as ${advertise.codec}/${advertise.clockRate}`);

server.on('viewer:added', (count) => console.log(`viewer joined (${count} playing)`));
server.on('viewer:removed', (count) => console.log(`viewer left (${count} playing)`));
server.on('backchannel:start', () => console.log('talkback started'));
server.on('backchannel:stop', () => console.log('talkback stopped'));

process.on('SIGINT', () => {
  server
    .shutdown()
    .then(() => relay.stop())
    .then(() => process.exit(0));
});
