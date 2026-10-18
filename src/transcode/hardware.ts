import { HardwareContext } from 'node-av/api';

import type { HardwareOptions } from 'node-av/api';

/**
 * Which hardware a transcoder may use.
 *
 * `true` shares one automatically detected device across the process, `false`
 * stays in software, `HardwareOptions` opens a dedicated device and a
 * `HardwareContext` is used as given.
 */
export type HardwareSetting = boolean | HardwareOptions | HardwareContext;

/**
 * A hardware device borrowed for the lifetime of a transcoder.
 *
 * @internal
 */
export interface HardwareLease {
  readonly context: HardwareContext;
  release(): void;
}

/**
 * The device shared by every transcoder with the default setting.
 *
 * @internal
 */
interface SharedDevice {
  context: HardwareContext;
  users: number;
}

// one device for every transcoder: GPU contexts are expensive (a CUDA context alone holds hundreds of MB)
let shared: SharedDevice | undefined;

/**
 * Borrow a hardware device according to a setting.
 *
 * @param setting - The setting, `true` when omitted
 *
 * @returns The lease, or `undefined` for software or when no device is available
 *
 * @internal
 */
export function acquireHardware(setting: HardwareSetting | undefined): HardwareLease | undefined {
  if (setting === false) return undefined;
  if (setting instanceof HardwareContext) return { context: setting, release: () => undefined };

  if (setting === undefined || setting === true) {
    if (!shared || shared.context.isDisposed) {
      const context = HardwareContext.auto();
      if (!context) return undefined;
      shared = { context, users: 0 };
    }
    const entry = shared;
    entry.users++;
    return { context: entry.context, release: once(() => releaseShared(entry)) };
  }

  const context = HardwareContext.auto(setting);
  return context ? { context, release: once(() => context.dispose()) } : undefined;
}

/**
 * Drop one user of the shared device and dispose it after the last.
 *
 * @param entry - The shared device the lease was taken from
 *
 * @internal
 */
function releaseShared(entry: SharedDevice): void {
  entry.users--;
  if (entry.users > 0) return;
  entry.context.dispose();
  if (shared === entry) shared = undefined;
}

/**
 * Wrap a function so only its first call has an effect.
 *
 * @param fn - The function
 *
 * @returns The guarded function
 *
 * @internal
 */
function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}
