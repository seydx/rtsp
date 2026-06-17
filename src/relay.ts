import { SinkChannel } from './sink-channel.js';
import { BackchannelTranscoder } from './sinks/rtsp-server/backchannel-transcoder.js';
import { RtspServerSink } from './sinks/rtsp-server/rtsp-server-sink.js';
import { TypedEmitter } from './util/emitter.js';

import { supportsBackchannel } from './types.js';

import type { RtspServerSinkOptions } from './sinks/rtsp-server/rtsp-server-sink.js';
import type { Logger, MediaPacket, Sink, Source, StreamInfo } from './types.js';

/**
 * Options for relay creation.
 *
 * Configures the single upstream source, its idle lifecycle, per-sink buffering,
 * and startup behavior. Only `source` is required; the remaining fields tune how
 * aggressively the relay holds the upstream open and how it copes with slow sinks.
 */
export interface RelayOptions {
  /**
   * The single upstream that feeds every attached sink.
   *
   * Exactly one connection to this source is held regardless of how many sinks
   * are piped; the relay opens it lazily (or eagerly with `autoStart`) and fans
   * each demuxed packet out to all ready consumers.
   */
  source: Source;

  /**
   * How long, in milliseconds, to keep the upstream alive after the last sink
   * leaves before tearing it down.
   *
   * When a positive value is given the relay waits that long before closing the
   * source, letting a reconnecting client reuse the already-open upstream. A
   * value of `0` (the default) stops the upstream immediately once the final
   * sink detaches.
   */
  idleTimeout?: number;

  /**
   * Per-sink buffer depth, in packets, before backpressure kicks in.
   *
   * Each sink has its own queue; when a sink falls behind and its queue exceeds
   * this depth, packets are dropped and the sink is re-synced at the next
   * keyframe rather than blocking the whole fan-out. Defaults to 512.
   */
  maxQueue?: number;

  /**
   * Open the upstream eagerly during construction instead of on the first sink.
   *
   * When `true` the relay calls {@link Relay.start} immediately so the source is
   * connected before any sink is piped; otherwise the upstream stays idle until
   * the first {@link Relay.pipe}. Defaults to `false`.
   */
  autoStart?: boolean;

  /**
   * Optional logger for diagnostic and error output.
   *
   * Receives non-fatal warnings and errors raised while pumping the upstream,
   * initializing sinks, or closing the source. Propagated to sinks created via
   * {@link Relay.serveRtsp}. When omitted no diagnostics are emitted.
   */
  logger?: Logger;
}

/**
 * Lifecycle state of a relay.
 *
 * Transitions follow `idle` -> `starting` -> `running` -> `stopping` -> `idle`.
 * The relay reports its current phase through {@link Relay.status}.
 */
export type RelayState = 'idle' | 'starting' | 'running' | 'stopping';

/**
 * Event map emitted by a relay.
 *
 * Describes the signatures of every event a {@link Relay} can emit, used to type
 * the `on`/`off`/`emit` surface inherited from the typed emitter.
 */
export interface RelayEvents {
  /**
   * Fired once the upstream is open and the stream layout is resolved.
   *
   * Carries the {@link StreamInfo} describing the tracks (and optional
   * backchannel) the relay will fan out. Emitted exactly once per running cycle,
   * after attached sinks have been initialized.
   */
  start: (info: StreamInfo) => void;

  /**
   * Fired after the upstream and every sink have been torn down.
   *
   * Emitted on both explicit {@link Relay.stop} and end-of-stream teardown,
   * signalling that the relay has returned to the `idle` state.
   */
  stop: () => void;

  /**
   * Fired when the upstream ends on its own (EOF or disconnect).
   *
   * Indicates the source stopped producing packets without a caller-initiated
   * stop; the relay then drains and closes its sinks, after which `stop` follows.
   */
  end: () => void;

  /**
   * Fired when the relay encounters a non-recoverable error.
   *
   * Carries the offending error. Raised when the upstream fails to open or the
   * pump loop throws; the relay tears itself down afterwards.
   */
  error: (error: unknown) => void;

  /**
   * Fired immediately after a sink is piped onto the relay.
   *
   * Carries the newly attached {@link Sink}. Emitted before the sink has been
   * synced to a keyframe, so the sink may not yet be receiving packets.
   */
  'sink:added': (sink: Sink) => void;

  /**
   * Fired once a previously attached sink has been detached and closed.
   *
   * Carries the removed {@link Sink}. May be triggered by {@link Relay.unpipe},
   * by the sink closing itself, or by relay teardown.
   */
  'sink:removed': (sink: Sink) => void;
}

/**
 * Default per-sink queue depth, in packets, used when `maxQueue` is unset.
 *
 * @internal
 */
const DEFAULT_MAX_QUEUE = 512;

/**
 * Single-source, multi-sink media relay.
 *
 * Connects one upstream source and fans its packets out to many sinks while
 * holding exactly one upstream connection regardless of how many consumers are
 * attached. The upstream is lazy by default: it opens when the first sink is
 * piped and, after the configured idle timeout, closes once the last sink
 * leaves. Slow sinks are isolated by per-sink queues and re-synced at the next
 * keyframe rather than stalling the whole fan-out.
 *
 * @example
 * ```typescript
 * import { Relay } from '@seydx/rtsp';
 *
 * const relay = new Relay({ source });
 * relay.pipe(sink);
 * await relay.start();
 * ```
 *
 * @example
 * ```typescript
 * import { Relay } from '@seydx/rtsp';
 *
 * const relay = new Relay({ source, idleTimeout: 5000 });
 * const server = await relay.serveRtsp({ port: 8554, path: 'live' });
 * ```
 *
 * @see {@link Source} For the upstream contract
 *
 * @see {@link Sink} For the consumer contract
 *
 * @see {@link RtspServerSink} For exposing the relay as an RTSP endpoint
 */
export class Relay extends TypedEmitter<RelayEvents> {
  private readonly source: Source;
  private readonly logger?: Logger;
  private readonly idleTimeout: number;
  private readonly maxQueue: number;

  private readonly channels = new Set<SinkChannel>();
  private readonly videoIndexes = new Set<number>();

  private state: RelayState = 'idle';
  private streamInfo?: StreamInfo;
  private startPromise?: Promise<void>;
  private pullAbort?: AbortController;
  private pumpPromise?: Promise<void>;
  private idleTimer?: ReturnType<typeof setTimeout>;

  /**
   * Create a relay around a single upstream source.
   *
   * Stores the source and lifecycle tuning but does not open the upstream unless
   * `autoStart` is set; otherwise the connection is deferred until the first
   * sink is piped or {@link Relay.start} is called.
   *
   * @param options - Relay configuration including the source and lifecycle options
   *
   * @example
   * ```typescript
   * import { Relay } from '@seydx/rtsp';
   *
   * const relay = new Relay({ source, autoStart: true });
   * ```
   */
  constructor(options: RelayOptions) {
    super();
    this.source = options.source;
    this.logger = options.logger;
    this.idleTimeout = options.idleTimeout ?? 0;
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;

    if (options.autoStart) this.start();
  }

  /**
   * Current lifecycle phase of the relay.
   *
   * Reflects whether the upstream is idle, opening, actively pumping, or being
   * torn down.
   *
   * @example
   * ```typescript
   * if (relay.status === 'running') {
   *   console.log('upstream is live');
   * }
   * ```
   */
  get status(): RelayState {
    return this.state;
  }

  /**
   * Resolved stream layout of the open upstream, if any.
   *
   * Populated once the upstream is open and `undefined` while the relay is idle.
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
   * Number of sinks currently attached to the relay.
   *
   * Counts every piped sink regardless of whether it has finished syncing to a
   * keyframe and started receiving packets.
   *
   * @example
   * ```typescript
   * console.log(`${relay.sinkCount} consumers attached`);
   * ```
   */
  get sinkCount(): number {
    return this.channels.size;
  }

  /**
   * Attach a sink to the relay.
   *
   * Wraps the sink in an isolated channel, lazily starts the upstream if it is
   * not already running, and syncs the sink at the next keyframe before it begins
   * receiving packets. The same sink instance is returned for convenient
   * chaining.
   *
   * @param sink - The consumer to attach to the relayed stream
   *
   * @returns The same sink instance that was passed in
   *
   * @example
   * ```typescript
   * const attached = relay.pipe(new CallbackSink({ onPacket: (packet) => handle(packet) }));
   * ```
   *
   * @see {@link Relay.unpipe} To detach a sink
   */
  pipe<T extends Sink>(sink: T): T {
    const channel = new SinkChannel(sink, {
      videoIndexes: this.videoIndexes,
      maxQueue: this.maxQueue,
      logger: this.logger,
      onClosed: (c) => this.handleChannelClosed(c),
    });
    this.channels.add(channel);
    this.cancelIdleTimer();
    this.emit('sink:added', sink);
    this.activateChannel(channel);
    return sink;
  }

  /**
   * Detach a previously piped sink.
   *
   * Closes the sink's channel, which flushes and releases it and emits
   * `sink:removed`. If the detached sink was the last one and the relay is
   * running, the idle teardown timer is scheduled. Detaching a sink that is not
   * attached is a no-op.
   *
   * @param sink - The sink to detach
   *
   * @returns A promise that resolves once the sink has been closed
   *
   * @example
   * ```typescript
   * await relay.unpipe(sink);
   * ```
   *
   * @see {@link Relay.pipe} To attach a sink
   */
  async unpipe(sink: Sink): Promise<void> {
    const channel = this.findChannel(sink);
    if (channel) await channel.close();
  }

  /**
   * Expose this relay as a multi-client RTSP endpoint.
   *
   * Creates and starts an RTSP server sink bound to this relay. The returned sink
   * begins listening immediately and lazily attaches to the relay when the first
   * client connects. When a backchannel is requested, inbound viewer talkback is
   * either forwarded straight to the source (pass-through) or transcoded to the
   * camera's codec, depending on the option shape.
   *
   * @param options - RTSP server sink options such as host, port, path, auth, and backchannel
   *
   * @returns A promise resolving to the listening RTSP server sink
   *
   * @example
   * ```typescript
   * const server = await relay.serveRtsp({ port: 8554, path: 'cam' });
   * ```
   *
   * @example
   * ```typescript
   * // Advertise a backchannel; relay transcodes viewer audio to the camera codec.
   * const server = await relay.serveRtsp({
   *   port: 8554,
   *   backchannel: { codec: 'opus', payloadType: 96, clockRate: 48000, channels: 1 },
   * });
   * ```
   *
   * @see {@link RtspServerSink} For the underlying server sink
   *
   * @see {@link BackchannelSource} For sources that accept talkback audio
   */
  async serveRtsp(options?: RtspServerSinkOptions): Promise<RtspServerSink> {
    const sink = new RtspServerSink(this, { logger: this.logger, ...options });
    await sink.listen();

    if (options?.backchannel === true) {
      // Pass-through: forward inbound viewer RTP straight to the source.
      sink.on('backchannel', (rtp) => {
        if (supportsBackchannel(this.source)) this.source.sendBackchannel(rtp);
      });
    } else if (options?.backchannel) {
      this.wireBackchannelTranscode(sink, options.backchannel);
    }
    return sink;
  }

  /**
   * Open the upstream and begin pumping packets.
   *
   * Resolves the stream layout, initializes any already-attached sinks, emits
   * `start`, and kicks off the pump loop. Idempotent and safe to call
   * concurrently: repeated calls share the same in-flight start, and calling it
   * while already running resolves immediately.
   *
   * @returns A promise that resolves once the upstream is running
   *
   * @throws {Error} If the upstream source fails to open
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
    this.startPromise ??= this.runStart();
    return this.startPromise;
  }

  /**
   * Tear down the upstream and every attached sink.
   *
   * Aborts the pump loop, closes all sink channels immediately (without draining
   * their backlog), closes the source, resets internal state to idle, and emits
   * `stop`. A no-op when the relay is already idle or stopping.
   *
   * @returns A promise that resolves once teardown is complete
   *
   * @example
   * ```typescript
   * await relay.stop();
   * ```
   *
   * @see {@link Relay.start} To open the upstream
   */
  async stop(): Promise<void> {
    this.cancelIdleTimer();
    if (this.state === 'idle' || this.state === 'stopping') return;
    this.state = 'stopping';

    this.pullAbort?.abort();
    // Let the pump loop unwind before closing the source: closing the underlying
    // demuxer while it is still being iterated can crash the native layer.
    await this.settlePump();
    await Promise.all([...this.channels].map((c) => c.close()));

    try {
      await this.source.close();
    } catch (error) {
      this.logger?.error?.('[rtsp] source close failed:', error);
    }

    this.streamInfo = undefined;
    this.videoIndexes.clear();
    this.startPromise = undefined;
    this.pumpPromise = undefined;
    this.state = 'idle';
    this.emit('stop');
  }

  /**
   * Wait for the pump loop to finish after an abort, bounded by a timeout.
   *
   * The pump only breaks once the source yields (or its read unblocks), so a
   * stalled upstream could otherwise hold teardown open indefinitely; the timeout
   * caps that wait and lets teardown proceed.
   *
   * @returns A promise that resolves when the pump settles or the timeout elapses
   *
   * @internal
   */
  private async settlePump(): Promise<void> {
    if (!this.pumpPromise) return;
    let timer: ReturnType<typeof setTimeout>;
    const guard = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 2_000);
      timer.unref?.();
    });
    await Promise.race([this.pumpPromise.catch(() => undefined), guard]);
    clearTimeout(timer!);
  }

  /**
   * Wire up lazy transcoding of inbound viewer talkback to the camera's codec.
   *
   * Subscribes to the sink's `backchannel` event and, on the first inbound RTP
   * packet, spins up a {@link BackchannelTranscoder} converting from the
   * advertised codec to whatever the source's backchannel expects, forwarding the
   * result upstream. The transcoder is created lazily and torn down when the
   * relay stops.
   *
   * @param sink - The RTSP server sink emitting inbound viewer talkback
   *
   * @param advertise - The talkback codec advertised to viewers, used as the transcoder input format
   *
   * @internal
   */
  private wireBackchannelTranscode(sink: RtspServerSink, advertise: Exclude<RtspServerSinkOptions['backchannel'], boolean | undefined>): void {
    let transcoder: BackchannelTranscoder | undefined;
    let starting: Promise<void> | undefined;

    sink.on('backchannel', (rtp) => {
      const source = this.source;
      if (!supportsBackchannel(source) || !source.backchannel) return;
      if (!transcoder) {
        const camera = source.backchannel;
        transcoder = new BackchannelTranscoder({
          from: advertise,
          to: { codecId: camera.codecId ?? 0, sampleRate: camera.clockRate, channels: camera.channels, format: 'rtp' },
          output: (buf) => source.sendBackchannel(buf),
          logger: this.logger,
        });
        starting = transcoder.start();
      }
      starting?.then(() => transcoder?.push(rtp)).catch((error) => this.logger?.error?.('[rtsp] backchannel transcoder failed:', error));
    });

    this.on('stop', () => {
      void transcoder?.close();
      transcoder = undefined;
      starting = undefined;
    });
  }

  /**
   * Tear down on end-of-stream, letting sinks flush their backlog first.
   *
   * Unlike {@link Relay.stop}, this drains each sink's queue before closing so
   * buffered packets are not discarded, then closes the source and resets to
   * idle. Used when the upstream ends on its own rather than on a caller request.
   *
   * @returns A promise that resolves once teardown is complete
   *
   * @internal
   */
  private async gracefulStop(): Promise<void> {
    this.cancelIdleTimer();
    if (this.state !== 'running') return;
    this.state = 'stopping';

    await Promise.all([...this.channels].map((c) => c.drainAndClose()));

    try {
      await this.source.close();
    } catch (error) {
      this.logger?.error?.('[rtsp] source close failed:', error);
    }

    this.streamInfo = undefined;
    this.videoIndexes.clear();
    this.startPromise = undefined;
    this.pumpPromise = undefined;
    this.state = 'idle';
    this.emit('stop');
  }

  /**
   * Perform the actual upstream open and transition into the running state.
   *
   * Opens the source, records the resolved stream info and video track indexes,
   * initializes already-attached sinks before any packet flows, emits `start`,
   * and launches the pump loop. On failure it resets to idle and re-raises after
   * emitting `error`. Backs the idempotent {@link Relay.start} entry point.
   *
   * @returns A promise that resolves once the relay is running
   *
   * @throws {Error} If the source fails to open
   *
   * @internal
   */
  private async runStart(): Promise<void> {
    this.state = 'starting';
    try {
      const info = await this.source.open();
      this.streamInfo = info;
      this.videoIndexes.clear();
      for (const track of info.tracks) {
        if (track.kind === 'video') this.videoIndexes.add(track.index);
      }
      // Initialize sinks that are already attached before any packet flows —
      // otherwise a fast (non-realtime) source can drain before they're ready.
      await Promise.all(
        [...this.channels].map((c) =>
          c.init(info).catch((error) => {
            this.logger?.error?.('[rtsp] sink init failed:', error);
            return c.close();
          }),
        ),
      );
      this.state = 'running';
      this.emit('start', info);
      this.pumpPromise = this.pumpLoop();
    } catch (error) {
      this.startPromise = undefined;
      this.state = 'idle';
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Continuously pull packets from the source and dispatch them to sinks.
   *
   * Iterates the source's packet stream under an abort controller until the
   * signal is aborted or the stream ends. A natural end triggers graceful
   * teardown; an unexpected error emits `error` and forces a stop. Aborted
   * iterations exit quietly so explicit stops are not reported as failures.
   *
   * @returns A promise that resolves when the pump loop exits
   *
   * @internal
   */
  private async pumpLoop(): Promise<void> {
    const abort = new AbortController();
    this.pullAbort = abort;
    try {
      for await (const packet of this.source.packets(abort.signal)) {
        if (abort.signal.aborted) {
          packet.free();
          break;
        }
        this.dispatch(packet);
      }
      if (!abort.signal.aborted) {
        this.emit('end');
        this.gracefulStop();
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.logger?.error?.('[rtsp] upstream pump failed:', error);
        this.emit('error', error);
        this.stop();
      }
    }
  }

  /**
   * Fan one upstream packet out to every ready sink.
   *
   * Offers an independently-owned clone to each keyframe-synced channel and frees
   * the original once distribution is complete, ensuring single ownership per
   * holder.
   *
   * @param packet - The demuxed packet to distribute; ownership is consumed here
   *
   * @internal
   */
  private dispatch(packet: MediaPacket): void {
    // Clone per ready consumer (cheap, ref-counted for native packets); the
    // original is freed once fanned out.
    for (const channel of this.channels) {
      if (channel.ready) channel.offer(packet.clone());
    }
    packet.free();
  }

  /**
   * Bring a freshly-piped channel online.
   *
   * Ensures the upstream is started, then initializes the channel against the
   * resolved stream info if the relay is already running. If the upstream fails
   * to start the channel is closed and dropped; if it was removed in the
   * meantime no further work is done.
   *
   * @param channel - The newly added sink channel to activate
   *
   * @returns A promise that resolves once activation completes
   *
   * @internal
   */
  private async activateChannel(channel: SinkChannel): Promise<void> {
    try {
      await this.start();
    } catch {
      // start() already emitted 'error'; drop the freshly-added channel.
      await channel.close();
      return;
    }
    if (!this.channels.has(channel)) return;
    if (this.streamInfo) await channel.init(this.streamInfo);
  }

  /**
   * Handle a channel that has closed itself.
   *
   * Removes the channel from the active set, emits `sink:removed`, and schedules
   * idle teardown when the last sink leaves while the relay is running. Invoked
   * via the channel's `onClosed` callback.
   *
   * @param channel - The channel that has closed
   *
   * @internal
   */
  private handleChannelClosed(channel: SinkChannel): void {
    if (this.channels.delete(channel)) {
      this.emit('sink:removed', channel.sink);
    }
    if (this.channels.size === 0 && this.state === 'running') {
      this.scheduleIdleStop();
    }
  }

  /**
   * Schedule (or immediately perform) teardown after the last sink leaves.
   *
   * When `idleTimeout` is zero or negative the relay stops at once; otherwise an
   * unref'd timer is armed and the relay stops after the timeout only if no sink
   * has reattached in the meantime, allowing reconnecting clients to reuse the
   * still-open upstream.
   *
   * @internal
   */
  private scheduleIdleStop(): void {
    this.cancelIdleTimer();
    if (this.idleTimeout <= 0) {
      this.stop();
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.channels.size === 0) this.stop();
    }, this.idleTimeout);
    this.idleTimer.unref?.();
  }

  /**
   * Cancel any pending idle teardown timer.
   *
   * Clears the armed idle timer if one exists, so a newly attached sink keeps the
   * upstream alive.
   *
   * @internal
   */
  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /**
   * Find the channel wrapping a given sink.
   *
   * Linearly scans the active channels for the one bound to the supplied sink.
   *
   * @param sink - The sink to look up
   *
   * @returns The matching channel, or `undefined` if the sink is not attached
   *
   * @internal
   */
  private findChannel(sink: Sink): SinkChannel | undefined {
    for (const channel of this.channels) {
      if (channel.sink === sink) return channel;
    }
    return undefined;
  }
}
