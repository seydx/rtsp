/**
 * Callback Sink
 *
 * Observes the packet flow of a source with a CallbackSink. Logs the track
 * layout once and then every packet with its stream index and keyframe flag.
 *
 * Usage: tsx examples/callback-sink.ts <rtsp_url>
 *
 * Examples:
 *   tsx examples/callback-sink.ts rtsp://user:pass@camera.local/stream
 */

import { AvSource, CallbackSink, Relay } from '../src/index.js';

const url = process.argv[2] ?? 'rtsp://rtspstream:demo@zephyr.rtsp.stream/movie';

const relay = new Relay({ source: new AvSource(url, { transport: 'tcp' }) });

relay.pipe(
  new CallbackSink({
    onInit: (info) => {
      for (const track of info.tracks) console.log(`track ${track.index}: ${track.kind} (${track.codec})`);
    },
    // the packet is only valid during this call, clone() it to keep it longer
    onPacket: (packet) => {
      console.log(`packet stream=${packet.streamIndex} keyframe=${packet.isKeyframe} pts=${packet.pts}`);
    },
    onClose: () => console.log('sink closed'),
  }),
);

await relay.start();
console.log(`relaying ${url}, press Ctrl+C to stop`);

process.on('SIGINT', () => {
  relay.stop().then(() => process.exit(0));
});
