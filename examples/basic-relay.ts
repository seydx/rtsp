/**
 * Basic RTSP Relay
 *
 * Pulls one RTSP camera over TCP and serves it again as a local RTSP endpoint.
 * The camera connection opens with the first viewer and stays warm for a few
 * seconds after the last one left, so a quick reconnect reuses it.
 *
 * Usage: tsx examples/basic-relay.ts <rtsp_url>
 *
 * Examples:
 *   tsx examples/basic-relay.ts rtsp://user:pass@camera.local/stream
 */

import { AvSource, Relay, RtspServerSink } from '../src/index.js';

const input = process.argv[2] ?? 'rtsp://user:pass@camera.local/stream';

const relay = new Relay({ source: new AvSource(input, { transport: 'tcp' }), idleTimeout: 10_000 });

// listens at once, the camera is only contacted when a viewer asks for the stream
const server = await new RtspServerSink(relay, { path: 'live' }).listen();
console.log('RTSP relay ready at', server.url);

process.on('SIGINT', () => {
  void server
    .shutdown()
    .then(() => relay.stop())
    .then(() => process.exit(0));
});
