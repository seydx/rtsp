import type { MediaPacket, Source, StreamInfo } from '../../types.js';

/**
 * Creates plain media packets and counts the live ones, so tests can assert
 * that nothing leaks or is freed twice.
 */
export class PacketTracker {
  live = 0;
  created = 0;

  make(init: { streamIndex: number; isKeyframe: boolean; pts?: number }): MediaPacket {
    const create = (): MediaPacket => {
      this.live++;
      this.created++;
      let freed = false;
      return {
        streamIndex: init.streamIndex,
        isKeyframe: init.isKeyframe,
        pts: init.pts,
        clone: () => create(),
        free: () => {
          if (freed) throw new Error('double free');
          freed = true;
          this.live--;
        },
      };
    };
    return create();
  }
}

export interface FakeSourceOptions {
  failOpen?: Error;
  openDelay?: number;
  closeDelay?: number;
}

/**
 * A push-driven source for deterministic relay tests.
 */
export class FakeSource implements Source {
  opened = false;
  closed = false;
  openCount = 0;
  closeCount = 0;

  private buffer: MediaPacket[] = [];
  private ended = false;
  private failure?: Error;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly info: StreamInfo,
    private readonly options: FakeSourceOptions = {},
  ) {}

  async open(): Promise<StreamInfo> {
    this.openCount++;
    this.ended = false;
    this.failure = undefined;
    if (this.options.openDelay) await delay(this.options.openDelay);
    if (this.options.failOpen) throw this.options.failOpen;
    this.opened = true;
    this.closed = false;
    return this.info;
  }

  push(packet: MediaPacket): void {
    this.buffer.push(packet);
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  fail(error: Error): void {
    this.failure = error;
    this.notify();
  }

  async *packets(signal: AbortSignal): AsyncIterable<MediaPacket> {
    for (;;) {
      if (signal.aborted) return;
      const packet = this.buffer.shift();
      if (packet) {
        yield packet;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await this.next(signal);
    }
  }

  async close(): Promise<void> {
    this.closeCount++;
    if (this.options.closeDelay) await delay(this.options.closeDelay);
    this.opened = false;
    this.closed = true;
    for (const packet of this.buffer) packet.free();
    this.buffer = [];
  }

  private next(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.push(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

/**
 * Wait for timers and microtasks to settle.
 */
export function flush(ms = 0): Promise<void> {
  return delay(ms);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
