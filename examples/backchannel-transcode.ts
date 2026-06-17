/**
 * Two-Way Audio with Transcoding
 *
 * Relays an RTSP camera and re-serves it with an ONVIF backchannel advertised in a
 * different codec than the camera natively accepts. Viewers push Opus talkback and
 * the relay transcodes it on the fly into the camera's own backchannel codec.
 *
 * Usage: tsx examples/backchannel-transcode.ts <rtsp_url> [port] [path]
 *
 * Examples:
 *   tsx examples/backchannel-transcode.ts rtsp://user:pass@192.168.1.50/stream
 *   tsx examples/backchannel-transcode.ts rtsp://cam.local/onvif 8554 talk
 */

import { Relay } from '../src/index.js';
import { AvSource } from '../src/sources/index.js';

import type { BackchannelAdvertise } from '../src/sinks/rtsp-server/index.js';

const input = process.argv[2] ?? 'rtsp://127.0.0.1:8554/camera';
const port = Number(process.argv[3] ?? 8554);
const path = process.argv[4] ?? 'live';

// Request the camera's backchannel so its native talkback codec is discovered;
// the transcoder uses that as the encode target when viewers send Opus.
const source = new AvSource(input, { transport: 'tcp', backchannel: true, logger: console });

const relay = new Relay({ source, logger: console });

// Codec advertised to *viewers*. It deliberately differs from the camera's codec
// (commonly G.711) — the relay transcodes inbound viewer RTP to the camera format.
const advertise: BackchannelAdvertise = { codec: 'opus', payloadType: 97, clockRate: 48000, channels: 2 };

const server = await relay.serveRtsp({ port, path, backchannel: advertise });

console.log(`Serving ${server.url}`);
console.log(`Talkback advertised as ${advertise.codec}/${advertise.clockRate}/${advertise.channels} (pt ${advertise.payloadType})`);

server.on('viewer:added', (count) => console.log(`viewer connected (${count} active)`));
server.on('viewer:removed', (count) => console.log(`viewer left (${count} active)`));

// Graceful shutdown: stopping the relay tears down the server sink, the transcoder,
// and the upstream camera connection.
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  relay.stop().then(() => process.exit(0));
});
