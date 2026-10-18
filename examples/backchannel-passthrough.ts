/**
 * Backchannel Pass-Through
 *
 * Two-way audio relay. Pulls a camera with its ONVIF backchannel and serves it
 * again while advertising the camera's own talkback codec, so viewer audio is
 * forwarded to the camera without transcoding.
 *
 * Usage: tsx examples/backchannel-passthrough.ts <rtsp_url>
 *
 * Examples:
 *   tsx examples/backchannel-passthrough.ts rtsp://user:pass@camera.local/stream
 */

import { AvSource, Relay, RtspServerSink } from '../src/index.js';

const input = process.argv[2] ?? 'rtsp://user:pass@camera.local/stream';

const source = new AvSource(input, { transport: 'tcp', backchannel: true });
const relay = new Relay({ source, idleTimeout: 10_000 });

// true advertises the camera's talkback format as is
const server = await new RtspServerSink(relay, { path: 'live', backchannel: true }).listen();
console.log('two-way RTSP relay ready at', server.url);

server.on('backchannel:start', () => console.log('viewer started talking'));
server.on('backchannel:stop', () => console.log('viewer stopped talking'));

// open the upstream now to learn whether the camera offers talkback at all
await relay.start();
if (source.backchannel) console.log(`talkback codec: ${source.backchannel.codec} @ ${source.backchannel.clockRate} Hz`);
else console.warn('the camera advertises no backchannel, talkback is unavailable');

process.on('SIGINT', () => {
  void server
    .shutdown()
    .then(() => relay.stop())
    .then(() => process.exit(0));
});
