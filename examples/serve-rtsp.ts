/**
 * Serve RTSP — fan one upstream out to many rtsp:// pullers.
 *
 * Opens a single upstream once and re-publishes it as a multi-client RTSP endpoint via `relay.serveRtsp`,
 * so any number of ffplay/VLC clients can pull from the one URL while the camera is only connected once.
 *
 * Usage: tsx examples/serve-rtsp.ts <rtsp_url> [port] [path]
 *
 * Examples:
 *   tsx examples/serve-rtsp.ts rtsp://user:pass@camera.local/stream
 *   tsx examples/serve-rtsp.ts rtsp://camera.local/stream 8554 live
 *   ffplay rtsp://127.0.0.1:8554/live      # then run several of these at once
 */

import { Relay } from '../src/index.js';
import { AvSource } from '../src/sources/index.js';

import type { Sink, StreamInfo } from '../src/index.js';

const input = process.argv[2] ?? 'rtsp://127.0.0.1:8554/source';
const port = Number(process.argv[3] ?? 8554);
const path = process.argv[4] ?? 'live';

// TCP transport keeps the upstream firewall-friendly and avoids UDP packet loss while fanning out.
const source = new AvSource(input, { transport: 'tcp' });

// idleTimeout keeps the upstream open briefly after the last client leaves so a reconnecting
// puller reuses the already-open camera connection instead of forcing a fresh DESCRIBE.
const relay = new Relay({ source, idleTimeout: 5000 });

// A readable name for the sink in lifecycle logs (sinks are opaque to the relay core).
const sinkName = (sink: Sink): string => sink.constructor.name;

relay.on('start', (info: StreamInfo) => {
  const tracks = info.tracks.map((t) => `${t.kind}:${t.codec}`).join(', ');
  console.log(`[relay] upstream live — ${info.tracks.length} track(s): ${tracks}`);
});
relay.on('stop', () => console.log('[relay] upstream stopped'));
relay.on('sink:added', (sink) => console.log(`[relay] sink added: ${sinkName(sink)} (${relay.sinkCount} attached)`));
relay.on('sink:removed', (sink) => console.log(`[relay] sink removed: ${sinkName(sink)} (${relay.sinkCount} attached)`));
relay.on('error', (error) => console.error('[relay] error:', error));

// Begins listening immediately; the upstream stays idle until the first client connects.
const server = await relay.serveRtsp({ host: '0.0.0.0', port, path });

console.log(`[server] pull from ${server.url}`);
console.log('[server] point ffplay/VLC at the URL above — many clients can pull at once.');

// Track concurrent viewers so it is obvious the single upstream is being fanned out.
server.on('viewer:added', (count) => console.log(`[server] viewer connected (${count} playing)`));
server.on('viewer:removed', (count) => console.log(`[server] viewer left (${count} playing)`));

// Graceful shutdown: tear down every viewer, the listener, and the upstream on Ctrl-C.
process.on('SIGINT', () => {
  console.log('\n[server] shutting down...');
  void (async () => {
    await server.shutdown();
    await relay.stop();
    process.exit(0);
  })();
});
