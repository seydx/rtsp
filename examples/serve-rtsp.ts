/**
 * Serve RTSP
 *
 * Fans one upstream out to many RTSP viewers. Any number of ffplay or VLC
 * clients can pull the same URL while the camera only sees one connection.
 * Lifecycle events show when the upstream opens and how many viewers watch.
 *
 * Usage: tsx examples/serve-rtsp.ts <rtsp_url> [port] [path]
 *
 * Examples:
 *   tsx examples/serve-rtsp.ts rtsp://user:pass@camera.local/stream
 *   tsx examples/serve-rtsp.ts rtsp://camera.local/stream 8554 live
 *   ffplay rtsp://127.0.0.1:8554/live
 */

import { AvSource, Relay, RtspAuth, RtspServerSink } from '../src/index.js';

const input = process.argv[2] ?? 'rtsp://127.0.0.1:8554/source';
const port = Number(process.argv[3] ?? 8554);
const path = process.argv[4] ?? 'live';

const source = new AvSource(input, { transport: 'tcp', timeout: 10_000, reconnect: { delay: 1000, maxDelay: 30_000 } });

// stallTimeout fails a camera that keeps the connection open but stops sending
const relay = new Relay({ source, idleTimeout: 5000, stallTimeout: 15_000 });

relay.on('start', (info) => {
  const tracks = info.tracks.map((track) => `${track.kind}:${track.codec}`).join(', ');
  console.log(`[relay] upstream open, tracks: ${tracks}`);
});
relay.on('stop', () => console.log('[relay] upstream closed'));
relay.on('error', (error) => console.error('[relay] error:', error));

const server = await new RtspServerSink(relay, {
  host: '0.0.0.0',
  port,
  path,
  auth: process.env.RTSP_PASSWORD ? new RtspAuth({ username: 'viewer', password: process.env.RTSP_PASSWORD }) : undefined,
}).listen();

console.log(`[server] pull from ${server.url}`);

server.on('viewer:added', (count) => console.log(`[server] viewer joined (${count} playing)`));
server.on('viewer:removed', (count) => console.log(`[server] viewer left (${count} playing)`));

process.on('SIGINT', () => {
  void server
    .shutdown()
    .then(() => relay.stop())
    .then(() => process.exit(0));
});
