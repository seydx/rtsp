import type { MediaPacket, Source, StreamInfo } from '../../types.js';

/**
 * Tracks how many packets are currently alive (cloned but not freed) so tests
 * can assert the relay never leaks native handles.
 */
export class PacketTracker {
  live = 0;
  totalCreated = 0;

  make(init: { streamIndex: number; isKeyframe: boolean; pts?: number; tag?: string }): MediaPacket {
    const create = (): MediaPacket => {
      this.live++;
      this.totalCreated++;
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

/** A push-driven {@link Source} for deterministic relay tests. */
export class FakeSource implements Source {
  opened = false;
  closed = false;
  openCount = 0;
  closeCount = 0;

  private buffer: MediaPacket[] = [];
  private ended = false;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly info: StreamInfo,
    private readonly opts: { failOpen?: Error; openDelay?: number } = {},
  ) {}

  async open(): Promise<StreamInfo> {
    this.openCount++;
    if (this.opts.openDelay) await new Promise((resolve) => setTimeout(resolve, this.opts.openDelay));
    if (this.opts.failOpen) throw this.opts.failOpen;
    this.opened = true;
    return this.info;
  }

  /** Feed one packet to the (single) active iterator. */
  push(packet: MediaPacket): void {
    this.buffer.push(packet);
    this.notify();
  }

  /** Signal end-of-stream. */
  end(): void {
    this.ended = true;
    this.notify();
  }

  async *packets(signal: AbortSignal): AsyncIterable<MediaPacket> {
    while (true) {
      if (signal.aborted) return;
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.ended) return;
      await this.waitNext(signal);
    }
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.closed = true;
    // Drop anything still buffered so the tracker can settle.
    for (const packet of this.buffer) packet.free();
    this.buffer = [];
  }

  private waitNext(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
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
    for (const w of waiters) w();
  }
}

/** Resolve after the current microtask/timer queue drains. */
export function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
