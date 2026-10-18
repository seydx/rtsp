import { HardwareContext } from 'node-av/api';
import { describe, expect, it } from 'vitest';

import { acquireHardware } from '../hardware.js';

const detected = HardwareContext.auto();
const hasDevice = detected !== null;
detected?.dispose();

describe('acquireHardware', () => {
  it('stays in software when disabled', () => {
    expect(acquireHardware(false)).toBeUndefined();
  });

  it.skipIf(!hasDevice)('shares one device until the last lease is returned', () => {
    const first = acquireHardware(true)!;
    const second = acquireHardware(undefined)!;
    expect(second.context).toBe(first.context);

    first.release();
    // a second release of the same lease must not count twice
    first.release();
    expect(first.context.isDisposed).toBe(false);

    second.release();
    expect(first.context.isDisposed).toBe(true);

    const third = acquireHardware(true)!;
    expect(third.context).not.toBe(first.context);
    third.release();
  });

  it.skipIf(!hasDevice)('opens a dedicated device for explicit options', () => {
    const shared = acquireHardware(true)!;
    const dedicated = acquireHardware({})!;
    expect(dedicated.context).not.toBe(shared.context);
    dedicated.release();
    expect(dedicated.context.isDisposed).toBe(true);
    expect(shared.context.isDisposed).toBe(false);
    shared.release();
  });

  it.skipIf(!hasDevice)('uses a given device without taking it over', () => {
    const context = HardwareContext.auto()!;
    const lease = acquireHardware(context)!;
    expect(lease.context).toBe(context);
    lease.release();
    expect(context.isDisposed).toBe(false);
    context.dispose();
  });
});
