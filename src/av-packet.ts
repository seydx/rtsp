import type { MediaPacket } from './types.js';
import type { Packet } from 'node-av';

/**
 * Wrap a node-av packet as a relay media packet.
 *
 * Adapts a native node-av packet to the {@link MediaPacket} interface that the relay
 * fan-out machinery consumes, while keeping a direct reference to the native handle so
 * AV-backed sinks can recover it. Cloning is ref-counted and shares the payload buffer,
 * which keeps fanning a single demuxed packet out to many consumers cheap, and freeing
 * releases only the specific handle it is called on.
 *
 * The relay typically clones once per consumer and frees the original, leaving each
 * consumer responsible for freeing its own clone after it has been written.
 *
 * @param packet - The native node-av packet to wrap
 *
 * @param streamIndex - Stream index to expose on the wrapper; defaults to the packet's
 * own index. Override it when several demuxers are merged into one source and a
 * per-demuxer index must be remapped onto a global stream index.
 *
 * @returns A {@link MediaPacket} backed by the given native packet
 *
 * @throws {Error} If a later `clone()` call fails because `av_packet_clone` returns null
 *
 * @example
 * ```typescript
 * import { wrapAvPacket } from '@seydx/rtsp';
 *
 * const media = wrapAvPacket(nativePacket);
 * const copy = media.clone(); // cheap, ref-counted fan-out
 * media.free();
 * ```
 *
 * @see {@link MediaPacket} For the relay packet contract
 *
 * @see {@link requireAvPacket} To recover the native handle from a media packet
 */
export function wrapAvPacket(packet: Packet, streamIndex = packet.streamIndex): MediaPacket {
  return {
    streamIndex,
    isKeyframe: packet.isKeyframe,
    av: packet,
    clone: () => {
      const copy = packet.clone();
      // av_packet_clone returns null on allocation failure; surface it rather than
      // handing back a half-formed wrapper around a missing handle.
      if (!copy) throw new Error('av_packet_clone failed');
      return wrapAvPacket(copy, streamIndex);
    },
    free: () => packet.free(),
  };
}

/**
 * Narrow a media packet to its underlying node-av packet.
 *
 * Recovers the native node-av handle carried by an AV-backed {@link MediaPacket}. Sinks
 * that operate on native packets (muxers, encoders, AV-aware writers) use this to assert
 * that the packet originated from an AV source rather than a plain JavaScript packet, and
 * to obtain the handle in a single, strongly typed step.
 *
 * @param packet - The media packet to narrow
 *
 * @returns The underlying native node-av packet
 *
 * @throws {Error} If the packet carries no native handle (i.e. it came from a non-AV source)
 *
 * @example
 * ```typescript
 * import { requireAvPacket } from '@seydx/rtsp';
 *
 * const native = requireAvPacket(media);
 * await muxer.writePacket(native);
 * ```
 *
 * @see {@link wrapAvPacket} To produce an AV-backed media packet
 *
 * @see {@link MediaPacket} For the relay packet contract
 */
export function requireAvPacket(packet: MediaPacket): Packet {
  if (!packet.av) {
    throw new Error('Sink requires an AV-backed source (packet has no node-av handle)');
  }
  return packet.av;
}
