import type { Logger, MediaPacket, Sink, StreamInfo } from './types.js';

/**
 * Configuration for one per-sink fan-out channel.
 *
 * @internal
 */
export interface SinkChannelOptions {
  /** Stream indexes that carry video; an empty set disables keyframe gating. */
  videoIndexes: ReadonlySet<number>;

  /** Queue length at which the backlog is cut back to a keyframe or dropped. */
  maxQueue: number;

  /** Logger for overflow, failure and close diagnostics. */
  logger?: Logger;

  /** Called once after the channel closed its sink, for whatever reason. */
  onClosed?: (channel: SinkChannel) => void;

  /** Called when the sink fails to initialize or write, before the channel closes. */
  onError?: (channel: SinkChannel, error: unknown) => void;
}

/**
 * Per-consumer wrapper around one sink.
 *
 * Holds a new consumer back until a video keyframe arrives, buffers packets in a
 * bounded queue and writes them on its own loop, so one slow sink never blocks
 * the shared upstream. The channel owns every packet it accepts and frees it
 * once written or dropped.
 *
 * @internal
 */
export class SinkChannel {
  private readonly queue: MediaPacket[] = [];
  private idleWaiters: (() => void)[] = [];
  private gateOpen = false;
  private draining = false;
  private accepting = true;
  private closed = false;
  private initialized = false;
  private initPromise?: Promise<void>;
  private lastWriteAt = 0;

  /**
   * @param sink - The consumer this channel drives
   *
   * @param options - Gating, queue and callback configuration
   *
   * @internal
   */
  constructor(
    readonly sink: Sink,
    private readonly options: SinkChannelOptions,
  ) {}

  /**
   * Initialize the sink once with the stream layout.
   *
   * Concurrent and repeated calls share one attempt. A failing `init()` is
   * reported through `onError` and closes the channel, so the returned promise
   * never rejects.
   *
   * @param info - The resolved stream layout
   *
   * @returns A promise that settles once the attempt finished
   *
   * @internal
   */
  init(info: StreamInfo): Promise<void> {
    this.initPromise ??= this.runInit(info);
    return this.initPromise;
  }

  /**
   * Whether {@link offer} would keep this packet rather than drop it.
   *
   * Lets the relay skip cloning for channels that are closed, not yet
   * initialized or still waiting for a keyframe.
   *
   * @param packet - The packet about to be offered
   *
   * @returns `true` if the channel would queue the packet
   *
   * @internal
   */
  accepts(packet: MediaPacket): boolean {
    if (!this.initialized || this.closed || !this.accepting) return false;
    return this.gateOpen || this.options.videoIndexes.size === 0 || this.isVideoKeyframe(packet);
  }

  /**
   * Hand one owned packet to the channel.
   *
   * The channel always takes ownership: the packet is queued or freed.
   *
   * @param packet - The packet to forward
   *
   * @internal
   */
  offer(packet: MediaPacket): void {
    if (!this.accepts(packet)) {
      packet.free();
      return;
    }
    this.gateOpen = true;
    if (this.queue.length >= this.options.maxQueue) {
      this.relieve(packet);
      return;
    }
    this.queue.push(packet);
    this.drain();
  }

  /**
   * Stop accepting packets, write the backlog, then close the sink.
   *
   * @returns A promise that resolves once the sink is closed
   *
   * @internal
   */
  async drainAndClose(): Promise<void> {
    this.accepting = false;
    while (!this.closed && (this.queue.length > 0 || this.draining)) {
      await this.whenDrainIdle();
    }
    await this.close();
  }

  /**
   * Close the channel now, dropping the backlog.
   *
   * Waits for a write that is already running, because closing a sink under an
   * in-flight write frees native state (muxers, filters) mid-call. Idempotent.
   *
   * @returns A promise that resolves once the sink is closed
   *
   * @internal
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    while (this.draining) {
      await this.whenDrainIdle();
    }
    try {
      await this.sink.close();
    } catch (error) {
      this.options.logger?.error?.('[rtsp] sink close failed:', error);
    }
    this.options.onClosed?.(this);
  }

  /**
   * Run the sink's `init()` and report a failure.
   *
   * @param info - The resolved stream layout
   *
   * @returns A promise that resolves once the attempt finished
   *
   * @internal
   */
  private async runInit(info: StreamInfo): Promise<void> {
    try {
      await this.sink.init(info);
      this.initialized = true;
    } catch (error) {
      this.options.logger?.error?.('[rtsp] sink init failed:', error);
      this.options.onError?.(this, error);
      await this.close();
    }
  }

  /**
   * Make room in a full queue.
   *
   * Prefers cutting the backlog at the newest buffered keyframe, which keeps the
   * consumer on a clean GOP without an output gap (the usual case after a burst
   * from a stalled upstream). Otherwise drops everything and restarts at the
   * next keyframe, which may be the incoming packet itself.
   *
   * @param packet - The packet that did not fit
   *
   * @internal
   */
  private relieve(packet: MediaPacket): void {
    const age = this.lastWriteAt === 0 ? 'never wrote' : `last write ${((performance.now() - this.lastWriteAt) / 1000).toFixed(1)}s ago`;
    const cut = this.newestKeyframeIndex();
    if (cut > 0 && this.queue.length - cut <= this.options.maxQueue / 2) {
      this.options.logger?.warn?.(`[rtsp] sink queue overflow (${this.queue.length} packets, ${age}), skipping to the newest buffered keyframe`);
      for (const dropped of this.queue.splice(0, cut)) dropped.free();
      this.queue.push(packet);
      this.drain();
      return;
    }

    this.options.logger?.warn?.(`[rtsp] sink queue overflow (${this.queue.length} packets, ${age}), dropping the backlog`);
    this.flush();
    if (this.options.videoIndexes.size > 0 && !this.isVideoKeyframe(packet)) {
      this.gateOpen = false;
      packet.free();
      return;
    }
    this.queue.push(packet);
    this.drain();
  }

  /**
   * Write queued packets to the sink in order, one at a time.
   *
   * Only one drain loop runs at a time. A failing write is reported through
   * `onError` and closes the channel.
   *
   * @returns A promise that resolves when the queue is empty or the channel closed
   *
   * @internal
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const packet = this.queue.shift()!;
        try {
          await this.sink.write(packet);
          this.lastWriteAt = performance.now();
        } catch (error) {
          this.options.logger?.error?.('[rtsp] sink write failed, closing channel:', error);
          this.options.onError?.(this, error);
          this.close();
          return;
        } finally {
          packet.free();
        }
      }
    } finally {
      this.draining = false;
      this.notifyDrainIdle();
    }
  }

  /**
   * Resolve on the next exit of the drain loop.
   *
   * @returns A promise that resolves when the running drain pass ends
   *
   * @internal
   */
  private whenDrainIdle(): Promise<void> {
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Wake everything waiting on {@link whenDrainIdle}.
   *
   * @internal
   */
  private notifyDrainIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Whether the packet is a keyframe on a video track.
   *
   * @param packet - The packet to test
   *
   * @returns `true` for video keyframes
   *
   * @internal
   */
  private isVideoKeyframe(packet: MediaPacket): boolean {
    return packet.isKeyframe && this.options.videoIndexes.has(packet.streamIndex);
  }

  /**
   * Queue index of the newest buffered video keyframe.
   *
   * @returns The index, or `-1` when no keyframe is buffered
   *
   * @internal
   */
  private newestKeyframeIndex(): number {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.isVideoKeyframe(this.queue[i])) return i;
    }
    return -1;
  }

  /**
   * Free every queued packet and empty the queue.
   *
   * @internal
   */
  private flush(): void {
    for (const packet of this.queue) packet.free();
    this.queue.length = 0;
  }
}
