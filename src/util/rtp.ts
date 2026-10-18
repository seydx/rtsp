/**
 * The parts of an RTP packet the library reads.
 *
 * @internal
 */
export interface RtpPacket {
  payloadType: number;
  marker: boolean;
  sequence: number;
  timestamp: number;
  payload: Buffer;
}

const RTP_VERSION = 2;
const RTP_HEADER_SIZE = 12;

/**
 * Map a lower-case FFmpeg codec name to its SDP rtpmap encoding name.
 *
 * @param codec - Lower-case FFmpeg codec name
 *
 * @returns The encoding name used in an SDP `a=rtpmap` line
 *
 * @internal
 */
export function rtpmapName(codec: string): string {
  switch (codec) {
    case 'pcm_mulaw':
      return 'PCMU';
    case 'pcm_alaw':
      return 'PCMA';
    case 'pcm_s16be':
      return 'L16';
    case 'opus':
      return 'opus';
    case 'aac':
      return 'MPEG4-GENERIC';
    default:
      return codec.toUpperCase();
  }
}

/**
 * Build the SDP `a=rtpmap` value of an audio format.
 *
 * Opus is always announced with two channels, as RFC 7587 requires.
 *
 * @param codec - Lower-case FFmpeg codec name
 *
 * @param clockRate - RTP clock rate in Hz
 *
 * @param channels - Channel count
 *
 * @returns The value after `a=rtpmap:<pt> `, for example `PCMA/8000`
 *
 * @internal
 */
export function rtpmapValue(codec: string, clockRate: number, channels: number): string {
  if (codec === 'opus') return 'opus/48000/2';
  return `${rtpmapName(codec)}/${clockRate}${channels > 1 ? `/${channels}` : ''}`;
}

/**
 * Whether a packet from the RTP muxer is RTCP rather than RTP.
 *
 * @param packet - Packet bytes
 *
 * @returns `true` for RTCP packet types 200 to 204
 *
 * @internal
 */
export function isRtcp(packet: Buffer): boolean {
  return packet.length > 1 && packet[1] >= 200 && packet[1] <= 204;
}

/**
 * Parse an RTP packet (RFC 3550), skipping CSRCs, header extensions and padding.
 *
 * @param packet - Raw RTP bytes
 *
 * @returns The parsed packet, or `undefined` when the bytes are not valid RTP
 *
 * @internal
 */
export function parseRtp(packet: Buffer): RtpPacket | undefined {
  if (packet.length < RTP_HEADER_SIZE || packet[0] >> 6 !== RTP_VERSION) return undefined;

  let offset = RTP_HEADER_SIZE + (packet[0] & 0x0f) * 4;
  if (packet[0] & 0x10) {
    if (packet.length < offset + 4) return undefined;
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  let end = packet.length;
  if (packet[0] & 0x20) end -= packet[end - 1];
  if (offset > end) return undefined;

  return {
    payloadType: packet[1] & 0x7f,
    marker: (packet[1] & 0x80) !== 0,
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    payload: packet.subarray(offset, end),
  };
}

/**
 * Split an RFC 3640 `AAC-hbr` payload into its access units.
 *
 * @param payload - RTP payload with AU headers (13-bit size, 3-bit index)
 *
 * @returns One buffer per AAC access unit, empty when the payload is malformed
 *
 * @internal
 */
export function splitAacAccessUnits(payload: Buffer): Buffer[] {
  if (payload.length < 2) return [];
  const headerBits = payload.readUInt16BE(0);
  const count = Math.floor(headerBits / 16);
  let offset = 2 + Math.ceil(headerBits / 8);
  if (offset > payload.length) return [];

  const units: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const size = payload.readUInt16BE(2 + i * 2) >> 3;
    if (offset + size > payload.length) break;
    units.push(payload.subarray(offset, offset + size));
    offset += size;
  }
  return units;
}

/**
 * Read one parameter from an SDP `a=fmtp` parameter list.
 *
 * @param fmtp - The parameter list, e.g. `mode=AAC-hbr;config=1408`
 *
 * @param key - Parameter name, compared case-insensitively
 *
 * @returns The parameter value, or `undefined` when absent
 *
 * @internal
 */
export function fmtpParam(fmtp: string | undefined, key: string): string | undefined {
  if (!fmtp) return undefined;
  const wanted = key.toLowerCase();
  for (const part of fmtp.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim().toLowerCase() === wanted) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * Extends 32-bit RTP timestamps into a monotonic 64-bit timeline starting at zero.
 *
 * @internal
 */
export class RtpClock {
  private last?: number;
  private extended = 0n;

  /**
   * Map the next RTP timestamp onto the extended timeline.
   *
   * @param timestamp - The 32-bit RTP timestamp of the packet
   *
   * @returns The extended timestamp in the same clock units
   *
   * @internal
   */
  extend(timestamp: number): bigint {
    if (this.last !== undefined) {
      // signed 32-bit difference survives the wrap at 2^32
      this.extended += BigInt((timestamp - this.last) | 0);
    }
    this.last = timestamp;
    return this.extended;
  }
}
