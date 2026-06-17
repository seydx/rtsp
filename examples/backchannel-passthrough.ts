/**
 * Backchannel Pass-Through
 *
 * Two-way audio relay: pulls an RTSP camera with the ONVIF backchannel enabled and re-serves it
 * locally while advertising the camera's own talkback codec. Because the advertised codec matches
 * the upstream verbatim, inbound viewer RTP is forwarded straight to the camera with no transcoding.
 *
 * Usage: tsx examples/backchannel-passthrough.ts <rtsp_url>
 *
 * Examples:
 *   tsx examples/backchannel-passthrough.ts rtsp://user:pass@camera.local/stream
 */

import { Relay } from '../src/index.js';
import { AvSource } from '../src/sources/index.js';

// Camera URL is the first CLI arg; fall back to a placeholder so the file is self-contained.
const input = process.argv[2] ?? 'rtsp://user:pass@camera.local/stream';

// TCP transport is firewall-friendly; backchannel: true requests the camera's ONVIF talkback stream.
const source = new AvSource(input, { transport: 'tcp', backchannel: true });

const relay = new Relay({ source });

// backchannel: true advertises the upstream's own talkback codec, so viewer RTP is forwarded
// as-is to the camera (pass-through) — no transcoding step is inserted.
const server = await relay.serveRtsp({ path: 'live', backchannel: true });

console.log('Two-way RTSP relay ready at', server.url);

// Open the upstream up front so we can confirm whether the camera actually advertised a backchannel.
await relay.start();
if (!source.backchannel) {
  // Pass-through still serves video/audio downstream, but talkback will be silently unavailable.
  console.warn('Camera advertised no backchannel — talkback is unavailable.');
} else {
  console.log(`Talkback codec: ${source.backchannel.codec} @ ${source.backchannel.clockRate}Hz`);
}

// Tear the relay (and its server sink) down cleanly on Ctrl+C.
process.on('SIGINT', () => {
  void relay.stop().then(() => process.exit(0));
});
