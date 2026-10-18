import { AV_NOPTS_VALUE } from 'node-av/constants';

import type { Packet } from 'node-av/lib';
import type { MediaPacket } from './types.js';

/**
 * {@link MediaPacket} backed by a node-av packet.
 *
 * The routing fields are read from the native packet once and carried over to
 * clones, so fanning a packet out costs one `av_packet_clone` per copy and no
 * further native getter calls.
 *
 * @internal
 */
class AvMediaPacket implements MediaPacket {
  constructor(
    readonly av: Packet,
    readonly streamIndex: number,
    readonly isKeyframe: boolean,
    readonly pts: number | undefined,
    readonly dts: number | undefined,
  ) {}

  clone(): MediaPacket {
    const copy = this.av.clone();
    if (!copy) throw new Error('av_packet_clone failed');
    return new AvMediaPacket(copy, this.streamIndex, this.isKeyframe, this.pts, this.dts);
  }

  free(): void {
    this.av.free();
  }
}

/**
 * Convert a native timestamp to the optional number form of {@link MediaPacket}.
 *
 * @param value - The native `bigint` timestamp
 *
 * @returns The timestamp as a number, or `undefined` for `AV_NOPTS_VALUE`
 *
 * @internal
 */
function toTimestamp(value: bigint): number | undefined {
  return value === AV_NOPTS_VALUE ? undefined : Number(value);
}

/**
 * Wrap a node-av packet as a relay media packet.
 *
 * The wrapper keeps the native handle, so AV-backed sinks can still reach it
 * through {@link MediaPacket.av}. Cloning shares the payload buffer by reference
 * count. Freeing releases only the handle it is called on. Ownership of `packet`
 * moves to the returned wrapper.
 *
 * @param packet - The native node-av packet to wrap
 *
 * @param streamIndex - Stream index exposed on the wrapper. Defaults to the
 * packet's own index; override it when several inputs are merged into one
 * global track space.
 *
 * @returns A {@link MediaPacket} that owns the native packet
 *
 * @example
 * ```typescript
 * import { wrapAvPacket } from '@seydx/rtsp';
 *
 * const media = wrapAvPacket(nativePacket);
 * const copy = media.clone();
 * media.free();
 * ```
 *
 * @see {@link MediaPacket} For the packet contract
 *
 * @see {@link requireAvPacket} To get the native handle back
 */
export function wrapAvPacket(packet: Packet, streamIndex = packet.streamIndex): MediaPacket {
  return new AvMediaPacket(packet, streamIndex, packet.isKeyframe, toTimestamp(packet.pts), toTimestamp(packet.dts));
}

/**
 * Get the node-av packet behind a media packet.
 *
 * Sinks that work on native packets (muxers, encoders) use this to assert that a
 * packet came from an AV-backed source.
 *
 * @param packet - The media packet to unwrap
 *
 * @returns The underlying node-av packet
 *
 * @throws {Error} If the packet carries no native handle
 *
 * @example
 * ```typescript
 * import { requireAvPacket } from '@seydx/rtsp';
 *
 * const native = requireAvPacket(media);
 * await muxer.writePacket(native, 0);
 * ```
 *
 * @see {@link wrapAvPacket} To create an AV-backed media packet
 */
export function requireAvPacket(packet: MediaPacket): Packet {
  if (!packet.av) throw new Error('Sink requires an AV-backed source (packet has no node-av handle)');
  return packet.av;
}
