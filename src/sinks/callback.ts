import type { MediaPacket, Sink, StreamInfo } from '../types.js';

/**
 * Lifecycle callbacks for a {@link CallbackSink}.
 *
 * Each handler is optional, so a consumer can subscribe to only the phases it
 * cares about. Handlers may be synchronous or asynchronous; when a handler
 * returns a promise the relay awaits it before proceeding, which provides
 * natural backpressure on the upstream packet flow.
 */
export interface CallbackSinkHandlers {
  /**
   * Called once when the relay resolves the upstream stream layout.
   *
   * Receives the full {@link StreamInfo} (tracks plus any backchannel format)
   * before the first packet is delivered, giving the consumer a chance to set up
   * per-track state. If it returns a promise, the relay awaits it before
   * delivering packets.
   */
  onInit?: (info: StreamInfo) => void | Promise<void>;

  /**
   * Called for every keyframe-gated packet the relay delivers to this sink.
   *
   * The {@link MediaPacket} is only valid for the duration of this call: the
   * relay frees it once the returned promise resolves, so any payload that must
   * outlive the call has to be copied out (or the packet cloned) here.
   */
  onPacket?: (packet: MediaPacket) => void | Promise<void>;

  /**
   * Called once on teardown, after the last packet has been delivered.
   *
   * Use this to release any resources allocated in {@link onInit}. If it returns
   * a promise, the relay awaits it as part of closing the sink.
   */
  onClose?: () => void | Promise<void>;
}

/**
 * The simplest sink: hands every keyframe-gated packet to a callback.
 *
 * Wraps a set of lifecycle handlers behind the {@link Sink} interface so raw
 * consumers, tests, and ad-hoc integrations can observe the relayed stream
 * without implementing a full sink class. It is also the canonical reference
 * implementation of {@link Sink}. Each delivered packet is only valid for the
 * duration of the packet handler — copy out anything that must be kept.
 *
 * @example
 * ```typescript
 * import { CallbackSink } from '@seydx/rtsp';
 *
 * const sink = new CallbackSink({
 *   onInit: (info) => console.log('tracks:', info.tracks.length),
 *   onPacket: (packet) => console.log('packet on stream', packet.streamIndex),
 *   onClose: () => console.log('done'),
 * });
 * ```
 *
 * @see {@link Sink} For the sink contract this implements
 *
 * @see {@link CallbackSinkHandlers} For the available lifecycle handlers
 */
export class CallbackSink implements Sink {
  /**
   * Create a callback-backed sink.
   *
   * @param handlers - Lifecycle callbacks invoked on init, per packet, and on close
   *
   * @example
   * ```typescript
   * const sink = new CallbackSink({ onPacket: (packet) => buffer.push(packet.clone()) });
   * ```
   */
  constructor(private readonly handlers: CallbackSinkHandlers) {}

  /**
   * Initialize the sink with the resolved stream layout.
   *
   * Forwards to the {@link CallbackSinkHandlers.onInit} handler if one was
   * provided; otherwise resolves immediately.
   *
   * @param info - Resolved description of the tracks the source carries
   *
   * @returns The handler's result, awaited by the relay before packets flow
   *
   * @example
   * ```typescript
   * await sink.init(streamInfo);
   * ```
   */
  init(info: StreamInfo): void | Promise<void> {
    return this.handlers.onInit?.(info);
  }

  /**
   * Deliver one packet to the consumer.
   *
   * Forwards to the {@link CallbackSinkHandlers.onPacket} handler if one was
   * provided. The packet is freed by the relay once the returned promise
   * resolves, so the handler must copy out any payload it needs to retain.
   *
   * @param packet - The keyframe-gated media packet to consume
   *
   * @returns The handler's result, awaited by the relay before the next packet
   *
   * @example
   * ```typescript
   * await sink.write(packet);
   * ```
   */
  write(packet: MediaPacket): void | Promise<void> {
    return this.handlers.onPacket?.(packet);
  }

  /**
   * Tear down the sink.
   *
   * Forwards to the {@link CallbackSinkHandlers.onClose} handler if one was
   * provided; otherwise resolves immediately.
   *
   * @returns The handler's result, awaited by the relay during teardown
   *
   * @example
   * ```typescript
   * await sink.close();
   * ```
   */
  close(): void | Promise<void> {
    return this.handlers.onClose?.();
  }
}
