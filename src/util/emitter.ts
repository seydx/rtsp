import { EventEmitter } from 'node:events';

/**
 * Strongly typed wrapper around the Node.js EventEmitter.
 *
 * Exposes a familiar `on`/`once`/`off`/`emit` surface while enforcing event
 * names and listener signatures at compile time. Each emitter instance owns a
 * private underlying EventEmitter, so subscribers and emitted payloads are
 * checked against the provided event map. This lets the library publish a
 * fully typed event API without taking on any third-party dependency.
 *
 * @template Events - Map of event names to their listener signatures; the
 * parameters of each listener define the payload accepted by `emit` for that
 * event.
 *
 * @example
 * ```typescript
 * interface MyEvents {
 *   ready: () => void;
 *   data: (chunk: Buffer) => void;
 * }
 *
 * class MyService extends TypedEmitter<MyEvents> {}
 *
 * const service = new MyService();
 * service.on('data', (chunk) => console.log(chunk.length));
 * service.emit('ready');
 * ```
 */
export class TypedEmitter<Events extends Record<keyof Events, (...args: any[]) => void>> {
  /**
   * Underlying Node.js EventEmitter that performs the actual dispatch.
   *
   * @internal
   */
  private readonly emitter = new EventEmitter();

  /**
   * Register a listener for an event.
   *
   * The listener is invoked every time the event is emitted, until it is
   * removed via {@link off} or {@link removeAllListeners}.
   *
   * @param event - Name of the event to subscribe to
   *
   * @param listener - Callback invoked with the event's typed payload
   *
   * @returns This emitter, for chaining
   *
   * @example
   * ```typescript
   * service.on('data', (chunk) => handle(chunk));
   * ```
   */
  on<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.emitter.on(event as string, listener);
    return this;
  }

  /**
   * Register a one-time listener for an event.
   *
   * The listener is invoked at most once, on the next emission of the event,
   * and is then automatically removed.
   *
   * @param event - Name of the event to subscribe to
   *
   * @param listener - Callback invoked once with the event's typed payload
   *
   * @returns This emitter, for chaining
   *
   * @example
   * ```typescript
   * service.once('ready', () => console.log('ready'));
   * ```
   */
  once<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.emitter.once(event as string, listener);
    return this;
  }

  /**
   * Remove a previously registered listener for an event.
   *
   * Only the exact listener reference passed to {@link on} or {@link once} is
   * removed; passing a different function has no effect.
   *
   * @param event - Name of the event to unsubscribe from
   *
   * @param listener - The exact listener reference to remove
   *
   * @returns This emitter, for chaining
   *
   * @example
   * ```typescript
   * service.off('data', handler);
   * ```
   */
  off<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.emitter.off(event as string, listener);
    return this;
  }

  /**
   * Emit an event, invoking all registered listeners synchronously.
   *
   * The arguments are type-checked against the listener signature for the
   * given event. Unlike a raw Node.js EventEmitter, emitting `error` without a
   * registered listener does **not** throw — a consumer that opted out of error
   * events must never crash the process over one.
   *
   * @param event - Name of the event to emit
   *
   * @param args - Payload forwarded to each listener, matching the event's signature
   *
   * @returns `true` if the event had listeners, `false` otherwise
   *
   * @example
   * ```typescript
   * service.emit('ready');
   * ```
   */
  emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): boolean {
    // Node treats 'error' specially: emitting it with no listener throws the
    // payload. Swallow that case instead — this is a library-facing emitter.
    if (event === 'error' && this.emitter.listenerCount('error') === 0) return false;
    return this.emitter.emit(event as string, ...args);
  }

  /**
   * Remove all listeners for every event.
   *
   * Typically used during teardown to ensure no callbacks fire after the
   * owning object has been disposed.
   *
   * @returns This emitter, for chaining
   *
   * @example
   * ```typescript
   * service.removeAllListeners();
   * ```
   */
  removeAllListeners(): this {
    this.emitter.removeAllListeners();
    return this;
  }
}
