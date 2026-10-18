import { SinkChannel } from './sink-channel.js';
import { TypedEmitter } from './util/emitter.js';

import type { Logger, MediaPacket, Sink, Source, StreamInfo } from './types.js';

/**
 * Options for a {@link Relay}.
 *
 * Only `source` is required. The other fields tune how long the upstream stays
 * open and how the relay copes with slow sinks and dead upstreams.
 */
export interface RelayOptions {
  /**
   * The upstream that feeds every attached sink.
   *
   * The relay holds exactly one connection to it, however many sinks are piped.
   */
  source: Source;

  /**
   * Time in milliseconds to keep the upstream open after the last sink left.
   *
   * A sink that attaches within this window reuses the running upstream. With
   * `0` the upstream closes as soon as the last sink leaves.
   *
   * @default 0
   */
  idleTimeout?: number;

  /**
   * Per-sink queue length in packets.
   *
   * A sink that falls this far behind is cut back to the newest buffered
   * keyframe, or loses its backlog and restarts at the next keyframe. The
   * upstream and the other sinks are not slowed down.
   *
   * @default 512
   */
  maxQueue?: number;

  /**
   * Open the upstream right away instead of on the first {@link Relay.pipe}.
   *
   * @default false
   */
  autoStart?: boolean;

  /**
   * Time in milliseconds the running upstream may deliver no packet before it
   * counts as stalled.
   *
   * A live source can hang without ending or failing, for example a camera
   * whose session starts but never sends a frame. When the gap since the last
   * packet exceeds this value, the relay emits `error` and stops, so the next
   * {@link Relay.pipe} opens a fresh upstream session. Set it above the largest
   * normal gap of the source. `0` disables the check.
   *
   * @default 0
   */
  stallTimeout?: number;

  /**
   * Logger for warnings and errors from the relay and its sink channels.
   */
  logger?: Logger;
}

/**
 * Lifecycle state of a {@link Relay}.
 *
 * Moves through `idle`, `starting`, `running`, `stopping` and back to `idle`.
 */
export type RelayState = 'idle' | 'starting' | 'running' | 'stopping';

/**
 * Events emitted by a {@link Relay}.
 */
export interface RelayEvents {
  /**
   * The upstream is open and every attached sink is initialized.
   *
   * Emitted once per running cycle with the resolved stream layout.
   */
  start: (info: StreamInfo) => void;

  /**
   * The upstream and every sink attached at that time are closed.
   *
   * Follows an explicit {@link Relay.stop}, an idle teardown, an upstream end
   * and an upstream failure alike.
   */
  stop: () => void;

  /**
   * The upstream ended on its own.
   *
   * The relay writes the remaining backlog of every sink before closing it;
   * `stop` follows.
   */
  end: () => void;

  /**
   * The upstream failed to open, failed while running or stalled.
   *
   * The relay tears itself down afterwards. Emitting `error` without a listener
   * does not throw.
   */
  error: (error: unknown) => void;

  /**
   * A sink failed in `init()` or `write()`.
   *
   * The sink is closed and removed (`sink:removed` follows); the upstream and
   * the other sinks keep running.
   */
  'sink:error': (sink: Sink, error: unknown) => void;

  /**
   * A sink was piped onto the relay.
   *
   * Emitted before the sink is initialized or receives packets.
   */
  'sink:added': (sink: Sink) => void;

  /**
   * A sink was closed and detached.
   *
   * Follows {@link Relay.unpipe}, a sink failure and relay teardown.
   */
  'sink:removed': (sink: Sink) => void;
}

const DEFAULT_MAX_QUEUE = 512;
const MIN_STALL_CHECK_MS = 250;

/**
 * Single-source, multi-sink media relay.
 *
 * Connects one upstream source and fans its packets out to any number of sinks
 * over a single upstream connection. The upstream opens when the first sink is
 * piped and closes after {@link RelayOptions.idleTimeout} once the last one
 * left. Every sink starts at a video keyframe and has its own bounded queue, so
 * a slow sink never holds up the others.
 *
 * @example
 * ```typescript
 * import { AvSource, CallbackSink, Relay } from '@seydx/rtsp';
 *
 * const relay = new Relay({ source: new AvSource('rtsp://camera.local/stream') });
 * relay.pipe(new CallbackSink({ onPacket: (packet) => console.log(packet.streamIndex) }));
 * ```
 *
 * @example
 * ```typescript
 * import { AvSource, Relay, RtspServerSink } from '@seydx/rtsp';
 *
 * const relay = new Relay({ source: new AvSource('rtsp://camera.local/stream'), idleTimeout: 5000 });
 * const server = await new RtspServerSink(relay, { port: 8554 }).listen();
 * console.log(server.url);
 * ```
 *
 * @see {@link Source} For the upstream contract
 *
 * @see {@link Sink} For the consumer contract
 *
 * @see {@link RtspServerSink} For serving the relay over RTSP
 */
export class Relay extends TypedEmitter<RelayEvents> {
  readonly source: Source;

  private readonly logger?: Logger;
  private readonly idleTimeout: number;
  private readonly maxQueue: number;
  private readonly stallTimeout: number;
  private readonly channels = new Set<SinkChannel>();
  private readonly videoIndexes = new Set<number>();
  private state: RelayState = 'idle';
  private sinkSeen = false;
  private streamInfo?: StreamInfo;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private pullAbort?: AbortController;
  private idleTimer?: NodeJS.Timeout;

  /**
   * Create a relay around one upstream source.
   *
   * Nothing is opened here unless {@link RelayOptions.autoStart} is set.
   *
   * @param options - The source and lifecycle options
   *
   * @example
   * ```typescript
   * import { Relay } from '@seydx/rtsp';
   *
   * const relay = new Relay({ source, idleTimeout: 10_000, stallTimeout: 8_000 });
   * ```
   */
  constructor(options: RelayOptions) {
    super();
    this.source = options.source;
    this.logger = options.logger;
    this.idleTimeout = options.idleTimeout ?? 0;
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.stallTimeout = options.stallTimeout ?? 0;

    // runStart already reports the failure through 'error'
    if (options.autoStart) void this.start().catch(() => undefined);
  }

  /**
   * Current lifecycle state.
   *
   * @example
   * ```typescript
   * if (relay.status === 'running') console.log('upstream is live');
   * ```
   */
  get status(): RelayState {
    return this.state;
  }

  /**
   * Stream layout of the open upstream, `undefined` while idle.
   *
   * @example
   * ```typescript
   * const tracks = relay.info?.tracks ?? [];
   * ```
   */
  get info(): StreamInfo | undefined {
    return this.streamInfo;
  }

  /**
   * Number of attached sinks, including those still waiting for a keyframe.
   *
   * @example
   * ```typescript
   * console.log(`${relay.sinkCount} sinks attached`);
   * ```
   */
  get sinkCount(): number {
    return this.channels.size;
  }

  /**
   * Attach a sink.
   *
   * Starts the upstream if needed. The sink is initialized with the stream
   * layout and receives packets from the next video keyframe on. Piping while
   * the relay is stopping waits for the teardown and then opens a fresh
   * upstream.
   *
   * @param sink - The consumer to attach
   *
   * @returns The same sink, for chaining
   *
   * @example
   * ```typescript
   * const sink = relay.pipe(new CallbackSink({ onPacket: (packet) => handle(packet) }));
   * ```
   *
   * @see {@link Relay.unpipe} To detach a sink
   */
  pipe<T extends Sink>(sink: T): T {
    const channel = new SinkChannel(sink, {
      videoIndexes: this.videoIndexes,
      maxQueue: this.maxQueue,
      logger: this.logger,
      onClosed: (closed) => this.handleChannelClosed(closed),
      onError: (failed, error) => this.emit('sink:error', failed.sink, error),
    });
    this.channels.add(channel);
    this.sinkSeen = true;
    this.cancelIdleTimer();
    this.emit('sink:added', sink);
    void this.activate(channel);
    return sink;
  }

  /**
   * Detach a sink and close it.
   *
   * Detaching the last sink schedules the idle teardown. Unknown sinks are
   * ignored.
   *
   * @param sink - The sink to detach
   *
   * @returns A promise that resolves once the sink is closed
   *
   * @example
   * ```typescript
   * await relay.unpipe(sink);
   * ```
   *
   * @see {@link Relay.pipe} To attach a sink
   */
  async unpipe(sink: Sink): Promise<void> {
    for (const channel of this.channels) {
      if (channel.sink === sink) {
        await channel.close();
        return;
      }
    }
  }

  /**
   * Open the upstream and start pumping packets.
   *
   * Concurrent calls share one start. Calling it while running resolves at once;
   * calling it while stopping waits for the teardown and starts again.
   *
   * @returns A promise that resolves once the relay is running
   *
   * @throws {Error} If the source fails to open
   *
   * @example
   * ```typescript
   * await relay.start();
   * ```
   *
   * @see {@link Relay.stop} To tear the upstream down
   */
  start(): Promise<void> {
    if (this.state === 'running') return Promise.resolve();
    if (this.stopping) return this.stopping.then(() => this.start());
    this.starting ??= this.runStart();
    return this.starting;
  }

  /**
   * Close the upstream and every attached sink.
   *
   * Queued packets are dropped. Stopping during a pending start aborts the open,
   * and the relay never turns `running` afterwards. Concurrent calls share one
   * teardown and all resolve when it is complete.
   *
   * @returns A promise that resolves once the relay is idle
   *
   * @example
   * ```typescript
   * await relay.stop();
   * ```
   *
   * @see {@link Relay.start} To open the upstream
   */
  stop(): Promise<void> {
    this.cancelIdleTimer();
    if (this.state === 'idle') return Promise.resolve();
    this.stopping ??= this.teardown(false);
    return this.stopping;
  }

  /**
   * Open the source and go live.
   *
   * @returns A promise that resolves once the relay is running
   *
   * @throws {Error} If the source fails to open
   *
   * @internal
   */
  private async runStart(): Promise<void> {
    this.state = 'starting';
    let info: StreamInfo;
    try {
      info = await this.source.open();
    } catch (error) {
      // a stop() during the open aborted it on purpose
      if (this.state !== 'starting') return;
      this.starting = undefined;
      this.state = 'idle';
      this.emit('error', error);
      throw error;
    }
    if (this.state !== 'starting') {
      // teardown closed the source before this open finished, a source that ignored that close is open now
      await this.closeSource();
      return;
    }

    this.streamInfo = info;
    for (const track of info.tracks) {
      if (track.kind === 'video') this.videoIndexes.add(track.index);
    }
    // sinks must be ready before the first packet, a non-live source can drain before they are
    await Promise.all([...this.channels].map((channel) => channel.init(info)));
    if (this.state !== 'starting') return;

    this.state = 'running';
    this.emit('start', info);
    void this.pump();
    // all sinks left or failed during the start, do not pump into the void
    if (this.sinkSeen && this.channels.size === 0) this.scheduleIdleStop();
  }

  /**
   * Tear the upstream and the attached sinks down.
   *
   * Sinks piped while this runs are left alone; they restart the relay once it
   * is idle.
   *
   * @param drain - Write each sink's backlog before closing it (upstream end)
   *
   * @returns A promise that resolves once the relay is idle
   *
   * @internal
   */
  private async teardown(drain: boolean): Promise<void> {
    const pendingStart = this.state === 'starting' ? this.starting : undefined;
    this.state = 'stopping';
    this.pullAbort?.abort();
    this.pullAbort = undefined;
    const channels = [...this.channels];

    if (pendingStart) {
      // closing the source aborts the pending open, runStart then sees 'stopping' and unwinds
      await this.closeSource();
      await pendingStart.catch(() => undefined);
      await Promise.all(channels.map((channel) => channel.close()));
    } else {
      await Promise.all(channels.map((channel) => (drain ? channel.drainAndClose() : channel.close())));
      await this.closeSource();
    }

    this.streamInfo = undefined;
    this.videoIndexes.clear();
    this.sinkSeen = this.channels.size > 0;
    this.starting = undefined;
    this.stopping = undefined;
    this.state = 'idle';
    this.emit('stop');
  }

  /**
   * Pull packets from the source and fan them out until it ends, fails, stalls or is aborted.
   *
   * @returns A promise that resolves when the pull loop exits
   *
   * @internal
   */
  private async pump(): Promise<void> {
    const abort = new AbortController();
    this.pullAbort = abort;

    let lastPacketAt = performance.now();
    let stalled = false;
    let watchdog: NodeJS.Timeout | undefined;
    if (this.stallTimeout > 0) {
      watchdog = setInterval(
        () => {
          if (performance.now() - lastPacketAt < this.stallTimeout) return;
          stalled = true;
          abort.abort();
        },
        Math.max(MIN_STALL_CHECK_MS, Math.floor(this.stallTimeout / 4)),
      );
      watchdog.unref();
    }

    let failure: unknown;
    let failed = false;
    try {
      for await (const packet of this.source.packets(abort.signal)) {
        if (abort.signal.aborted) {
          packet.free();
          break;
        }
        lastPacketAt = performance.now();
        this.dispatch(packet);
      }
    } catch (error) {
      failure = error;
      failed = true;
    } finally {
      clearInterval(watchdog);
    }

    if (stalled) {
      failure = new Error(`upstream stalled: no packet within ${this.stallTimeout}ms`);
    } else if (abort.signal.aborted) {
      return;
    } else if (!failed) {
      this.emit('end');
      if (this.state === 'running') {
        this.cancelIdleTimer();
        this.stopping ??= this.teardown(true);
      }
      return;
    }

    this.logger?.error?.('[rtsp] upstream failed:', failure);
    this.emit('error', failure);
    void this.stop();
  }

  /**
   * Hand one upstream packet to every channel that wants it.
   *
   * Each interested channel but the last gets a clone, the last gets the
   * original, so a single sink costs no clone at all.
   *
   * @param packet - The packet to distribute; ownership is consumed
   *
   * @internal
   */
  private dispatch(packet: MediaPacket): void {
    let target: SinkChannel | undefined;
    for (const channel of this.channels) {
      if (!channel.accepts(packet)) continue;
      target?.offer(packet.clone());
      target = channel;
    }
    if (target) target.offer(packet);
    else packet.free();
  }

  /**
   * Start the upstream for a newly piped channel and initialize the channel.
   *
   * @param channel - The channel to bring online
   *
   * @returns A promise that resolves once the channel is initialized or dropped
   *
   * @internal
   */
  private async activate(channel: SinkChannel): Promise<void> {
    try {
      await this.start();
    } catch {
      // start() already emitted 'error'
      await channel.close();
      return;
    }
    if (this.channels.has(channel) && this.streamInfo) await channel.init(this.streamInfo);
  }

  /**
   * Forget a closed channel and schedule the idle teardown after the last one.
   *
   * @param channel - The channel that closed
   *
   * @internal
   */
  private handleChannelClosed(channel: SinkChannel): void {
    if (this.channels.delete(channel)) this.emit('sink:removed', channel.sink);
    if (this.channels.size === 0 && this.state === 'running') this.scheduleIdleStop();
  }

  /**
   * Stop now, or after {@link RelayOptions.idleTimeout} if no sink returned by then.
   *
   * @internal
   */
  private scheduleIdleStop(): void {
    this.cancelIdleTimer();
    if (this.idleTimeout <= 0) {
      void this.stop();
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.channels.size === 0) void this.stop();
    }, this.idleTimeout);
    this.idleTimer.unref();
  }

  /**
   * Cancel a pending idle teardown.
   *
   * @internal
   */
  private cancelIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /**
   * Close the source, logging instead of throwing.
   *
   * @returns A promise that resolves once the source is closed
   *
   * @internal
   */
  private async closeSource(): Promise<void> {
    try {
      await this.source.close();
    } catch (error) {
      this.logger?.error?.('[rtsp] source close failed:', error);
    }
  }
}
