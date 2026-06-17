/**
 * Basic RTSP Relay
 *
 * Quickstart that pulls a single RTSP camera over TCP and re-serves it as a local
 * RTSP endpoint. The upstream is opened lazily on the first viewer and, thanks to
 * the idle timeout, kept warm briefly after the last viewer leaves so reconnects
 * reuse the existing camera connection.
 *
 * Usage: tsx examples/basic-relay.ts <rtsp_url>
 *
 * Examples:
 *   tsx examples/basic-relay.ts rtsp://user:pass@camera.local/stream
 */

import { Relay } from '../src/index.js';
import { AvSource } from '../src/sources/index.js';

// Camera URL is the first CLI arg; fall back to a placeholder so the file is self-contained.
const input = process.argv[2] ?? 'rtsp://user:pass@camera.local/stream';

// TCP transport is firewall-friendly and avoids UDP packet loss for the upstream pull.
const source = new AvSource(input, { transport: 'tcp' });

// idleTimeout keeps the upstream open 10s after the last viewer so quick reconnects reuse it.
const relay = new Relay({ source, idleTimeout: 10_000 });

// serveRtsp starts listening immediately; it only attaches to the camera once a client connects.
const server = await relay.serveRtsp({ path: 'live' });

console.log('RTSP relay ready at', server.url);

// Tear the relay (and its server sink) down cleanly on Ctrl+C.
process.on('SIGINT', () => {
  relay.stop().then(() => process.exit(0));
});
