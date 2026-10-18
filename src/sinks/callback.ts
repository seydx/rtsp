import type { MediaPacket, Sink, StreamInfo } from '../types.js';

/**
 * Callbacks of a {@link CallbackSink}. All are optional and may return a promise.
 */
export interface CallbackSinkHandlers {
  /**
   * Called once with the stream layout before the first packet.
   *
   * Throwing detaches the sink.
   *
   * @param info - The stream layout
   */
  onInit?: (info: StreamInfo) => void | Promise<void>;

  /**
   * Called for every packet from the first video keyframe on, one at a time.
   *
   * The packet is freed once the callback returned or its promise resolved;
   * clone it to keep it longer. Throwing detaches the sink.
   *
   * @param packet - The packet
   */
  onPacket?: (packet: MediaPacket) => void | Promise<void>;

  /**
   * Called once when the sink is detached or the relay stops.
   */
  onClose?: () => void | Promise<void>;
}

/**
 * Sink that hands packets to plain callbacks.
 *
 * The quickest way to consume a relay in process, for example to inspect
 * packets, count bytes or feed a custom pipeline. A returned promise applies
 * backpressure: the next packet waits until it resolves, while the relay and
 * the other sinks keep running.
 *
 * @example
 * ```typescript
 * import { CallbackSink } from '@seydx/rtsp';
 *
 * relay.pipe(
 *   new CallbackSink({
 *     onInit: (info) => console.log(info.tracks.map((track) => track.codec)),
 *     onPacket: (packet) => console.log(packet.streamIndex, packet.isKeyframe),
 *   }),
 * );
 * ```
 *
 * @see {@link Sink} For the sink contract
 *
 * @see {@link Relay.pipe} For attaching it
 */
export class CallbackSink implements Sink {
  /**
   * Create a sink from callbacks.
   *
   * @param handlers - The callbacks to invoke
   *
   * @example
   * ```typescript
   * const sink = new CallbackSink({ onPacket: (packet) => handle(packet) });
   * ```
   */
  constructor(private readonly handlers: CallbackSinkHandlers) {}

  /**
   * Forward the stream layout to {@link CallbackSinkHandlers.onInit}.
   *
   * @param info - The stream layout
   *
   * @returns The callback's result
   *
   * @example
   * ```typescript
   * await sink.init(info);
   * ```
   */
  init(info: StreamInfo): void | Promise<void> {
    return this.handlers.onInit?.(info);
  }

  /**
   * Forward a packet to {@link CallbackSinkHandlers.onPacket}.
   *
   * @param packet - The packet, owned by the relay
   *
   * @returns The callback's result
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
   * Invoke {@link CallbackSinkHandlers.onClose}.
   *
   * @returns The callback's result
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
