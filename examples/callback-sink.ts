/**
 * Callback Sink
 *
 * Attaches a CallbackSink to a relay to observe the raw, keyframe-gated packet flow of an RTSP
 * source. Logs the resolved track layout on init and, for every packet, its stream index and
 * whether it is a keyframe.
 *
 * Usage: tsx examples/callback-sink.ts <rtsp_url>
 *
 * Examples:
 *   tsx examples/callback-sink.ts rtsp://user:pass@camera.local/stream
 */

import { Relay } from '../src/index.js';
import { CallbackSink } from '../src/sinks/index.js';
import { AvSource } from '../src/sources/index.js';

import type { MediaPacket, StreamInfo } from '../src/types.js';

// Fall back to a public test stream so the example runs with no arguments.
const url = process.argv[2] ?? 'rtsp://rtspstream:demo@zephyr.rtsp.stream/movie';

// TCP transport is firewall-friendly and avoids UDP packet loss for a clean read of the flow.
const source = new AvSource(url, { transport: 'tcp' });
const relay = new Relay({ source });

// CallbackSink is the simplest consumer: it forwards each lifecycle phase to a plain handler.
const sink = new CallbackSink({
  // Fired once before any packet, so we can see the source's track layout up front.
  onInit: (info: StreamInfo): void => {
    for (const track of info.tracks) {
      console.log(`track ${track.index}: ${track.kind} (${track.codec})`);
    }
  },
  // The packet is only valid for the duration of this call — we just read scalar fields, so no clone needed.
  onPacket: (packet: MediaPacket): void => {
    console.log(`packet stream=${packet.streamIndex} keyframe=${packet.isKeyframe}`);
  },
  onClose: (): void => {
    console.log('sink closed');
  },
});

relay.pipe(sink);

// Top-level await: open the upstream and start fanning packets out to the sink.
await relay.start();
console.log(`relaying ${url} — press Ctrl+C to stop`);

// Graceful shutdown: tear down sinks and close the upstream connection on Ctrl+C.
process.on('SIGINT', () => {
  relay.stop().then(() => process.exit(0));
});
