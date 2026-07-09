import { AV_NOPTS_VALUE } from 'node-av';
import { describe, expect, it } from 'vitest';

import { requireAvPacket, wrapAvPacket } from '../av-packet.js';

import type { Packet } from 'node-av';
import type { MediaPacket } from '../types.js';

/** Build a minimal fake native packet exposing just what wrapAvPacket reads. */
function fakePacket(init: { streamIndex?: number; isKeyframe?: boolean; pts?: bigint; dts?: bigint }): Packet {
  const packet = {
    streamIndex: init.streamIndex ?? 0,
    isKeyframe: init.isKeyframe ?? false,
    pts: init.pts ?? AV_NOPTS_VALUE,
    dts: init.dts ?? AV_NOPTS_VALUE,
    freed: false,
    clone(): unknown {
      return fakePacket(init);
    },
    free(): void {
      this.freed = true;
    },
  };
  return packet as unknown as Packet;
}

describe('wrapAvPacket', () => {
  it('exposes pts/dts as numbers', () => {
    const media = wrapAvPacket(fakePacket({ streamIndex: 2, isKeyframe: true, pts: 9000n, dts: 6000n }));
    expect(media.streamIndex).toBe(2);
    expect(media.isKeyframe).toBe(true);
    expect(media.pts).toBe(9000);
    expect(media.dts).toBe(6000);
  });

  it('maps AV_NOPTS_VALUE to undefined', () => {
    const media = wrapAvPacket(fakePacket({ pts: AV_NOPTS_VALUE, dts: AV_NOPTS_VALUE }));
    expect(media.pts).toBeUndefined();
    expect(media.dts).toBeUndefined();
  });

  it('keeps timestamps and the stream-index override on clones', () => {
    const media = wrapAvPacket(fakePacket({ streamIndex: 0, pts: 100n }), 7);
    const copy = media.clone();
    expect(copy.streamIndex).toBe(7);
    expect(copy.pts).toBe(100);
    copy.free();
    media.free();
  });
});

describe('requireAvPacket', () => {
  it('returns the native handle for AV-backed packets', () => {
    const native = fakePacket({});
    const media = wrapAvPacket(native);
    expect(requireAvPacket(media)).toBe(native);
  });

  it('throws for plain packets without a native handle', () => {
    const plain: MediaPacket = {
      streamIndex: 0,
      isKeyframe: false,
      clone: () => plain,
      free: () => undefined,
    };
    expect(() => requireAvPacket(plain)).toThrow(/AV-backed/);
  });
});
