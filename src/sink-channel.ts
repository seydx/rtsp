import type { Logger, MediaPacket, Sink } from './types.js';

/**
 * Configuration for a single per-sink fan-out channel.
 *
 * @internal
 */
export interface SinkChannelOptions {
  /**
   * Stream indexes that carry video.
   *
   * Used to decide whether a packet is a video packet and whether the channel
   * must wait for a keyframe before it starts forwarding. An empty set means the
   * source has no video, so the channel opens its gate on the first packet.
   */
  videoIndexes: ReadonlySet<number>;

  /**
   * Maximum number of packets buffered before the backlog is dropped.
   *
   * When the outbound queue reaches this length the entire backlog is flushed
   * and the channel re-gates on the next keyframe. This bounds memory and keeps
   * a slow sink from stalling the shared upstream pull, at the cost of a brief
   * glitch on the affected consumer.
   */
  maxQueue: number;

  /**
   * Optional logger for overflow, write-failure, and close diagnostics.
   */
  logger?: Logger;

  /**
   * Callback invoked exactly once when the channel tears itself down.
   *
   * Fired after the underlying sink is closed, whether the teardown was caused
   * by a write error or an explicit close. Lets the owning relay drop its
   * reference to this channel.
   */
  onClosed?: (channel: SinkChannel) => void;
}

/**
 * Per-consumer fan-out wrapper around a single sink.
 *
 * Couples one sink to the relay with keyframe gating and a bounded outbound
 * queue. A freshly added consumer is held muted until it can start cleanly, and
 * its writes are drained on an independent loop so that one slow consumer never
 * blocks the shared upstream. The channel takes ownership of every packet it is
 * offered and releases it once the packet has been written or dropped.
 *
 * @internal
 *
 * @see {@link Sink} For the wrapped consumer contract
 *
 * @see {@link MediaPacket} For the packet ownership model
 */
export class SinkChannel {
  /**
   * Whether the channel is forwarding packets.
   *
   * Starts `false` and flips to `true` once the keyframe gate opens. Resets to
   * `false` when the queue overflows so the channel resynchronises on the next
   * keyframe instead of continuing mid-GOP.
   */
  active = false;

  private readonly queue: MediaPacket[] = [];
  private draining = false;
  private closed = false;
  private acceptOffers = true;
  private inited = false;
  private initPromise?: Promise<void>;

  /**
   * Create a fan-out channel for one sink.
   *
   * @param sink - The downstream consumer this channel drives
   *
   * @param options - Gating, queue-bound, logging, and teardown configuration
   *
   * @internal
   */
  constructor(
    readonly sink: Sink,
    private readonly options: SinkChannelOptions,
  ) {}

  /**
   * Whether the channel is initialized and open.
   *
   * Becomes `true` once {@link init} has resolved and remains so until the
   * channel is closed.
   *
   * @example
   * ```typescript
   * if (channel.ready) {
   *   channel.offer(packet);
   * }
   * ```
   */
  get ready(): boolean {
    return this.inited && !this.closed;
  }

  /**
   * Offer one owned packet to the channel.
   *
   * The channel takes ownership of the packet and always consumes it: it is
   * either queued for writing or freed immediately. Packets are dropped while
   * the keyframe gate is closed, after the channel has closed, or when the queue
   * overflows and the backlog is flushed for resynchronisation.
   *
   * @param packet - An owned packet to forward; ownership transfers to the channel
   *
   * @example
   * ```typescript
   * channel.offer(packet.clone());
   * ```
   */
  offer(packet: MediaPacket): void {
    if (this.closed || !this.acceptOffers) {
      packet.free();
      return;
    }

    if (!this.active) {
      if (!this.requiresKeyframe) {
        this.active = true;
      } else if (this.isVideo(packet) && packet.isKeyframe) {
        this.active = true;
      } else {
        packet.free();
        return;
      }
    }

    if (this.queue.length >= this.options.maxQueue) {
      this.options.logger?.warn?.('[rtsp] sink queue overflow — dropping backlog and resyncing');
      this.flushQueue();
      // Re-gate so we restart cleanly at the next keyframe instead of mid-GOP.
      this.active = false;
      packet.free();
      return;
    }

    this.queue.push(packet);
    void this.drain();
  }

  /**
   * Initialize the underlying sink with the resolved stream layout.
   *
   * Idempotent: the wrapped sink's `init()` is invoked at most once, and
   * concurrent or repeated calls share the same in-flight promise.
   *
   * @param info - Resolved stream information forwarded to the sink
   *
   * @returns A promise that resolves once the sink has been initialized
   *
   * @example
   * ```typescript
   * await channel.init(streamInfo);
   * ```
   */
  async init(info: Parameters<Sink['init']>[0]): Promise<void> {
    this.initPromise ??= (async () => {
      await this.sink.init(info);
      this.inited = true;
    })();
    return this.initPromise;
  }

  /**
   * Gracefully close the channel after draining the backlog.
   *
   * Stops accepting new packets, waits for the queued backlog to finish writing,
   * then closes the sink. Use this for clean end-of-stream teardown; for aborts
   * and errors prefer {@link close}, which discards the backlog immediately.
   *
   * @returns A promise that resolves once the backlog is flushed and the sink is closed
   *
   * @example
   * ```typescript
   * // upstream ended cleanly
   * await channel.drainAndClose();
   * ```
   *
   * @see {@link close} For immediate teardown that drops the backlog
   */
  async drainAndClose(): Promise<void> {
    if (this.closed) return;
    this.acceptOffers = false;
    while ((this.queue.length > 0 || this.draining) && !this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.close();
  }

  /**
   * Close the channel immediately, discarding any backlog.
   *
   * Marks the channel closed, frees all queued packets, closes the underlying
   * sink, and fires the configured close callback. Idempotent: repeated calls
   * after the first are no-ops. Sink close failures are logged rather than
   * propagated so teardown always completes.
   *
   * @returns A promise that resolves once the sink is closed and the callback has run
   *
   * @example
   * ```typescript
   * await channel.close();
   * ```
   *
   * @see {@link drainAndClose} For graceful teardown that flushes the backlog first
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.flushQueue();
    try {
      await this.sink.close();
    } catch (error) {
      this.options.logger?.error?.('[rtsp] sink close failed:', error);
    }
    this.options.onClosed?.(this);
  }

  /**
   * Whether the channel must wait for a keyframe before forwarding.
   *
   * True when the source carries at least one video stream, in which case the
   * gate only opens on a video keyframe. False for audio/data-only sources,
   * where the gate opens on the first packet.
   *
   * @returns `true` if a keyframe is required to start
   *
   * @internal
   */
  private get requiresKeyframe(): boolean {
    return this.options.videoIndexes.size > 0;
  }

  /**
   * Test whether a packet belongs to a video stream.
   *
   * @param packet - The packet to classify
   *
   * @returns `true` if the packet's stream index is a known video index
   *
   * @internal
   */
  private isVideo(packet: MediaPacket): boolean {
    return this.options.videoIndexes.has(packet.streamIndex);
  }

  /**
   * Drain the outbound queue into the sink.
   *
   * Runs as a single self-guarded loop: only one drain is ever in flight, so
   * packets are written strictly in order. A write failure logs the error, frees
   * the offending packet, and closes the channel.
   *
   * @returns A promise that resolves when the queue is empty or the channel closes
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
        } catch (error) {
          this.options.logger?.error?.('[rtsp] sink write failed — closing channel:', error);
          packet.free();
          void this.close();
          return;
        }
        packet.free();
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Free every queued packet and empty the queue.
   *
   * @internal
   */
  private flushQueue(): void {
    for (const packet of this.queue) packet.free();
    this.queue.length = 0;
  }
}
