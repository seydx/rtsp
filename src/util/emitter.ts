import { EventEmitter } from 'node:events';

/**
 * Event emitter with typed event names and listener signatures.
 *
 * Base class of {@link Relay} and {@link RtspServerSink}. Unlike a plain
 * `EventEmitter`, emitting `error` without a listener does not throw, so an
 * unobserved library error never crashes the process.
 *
 * @example
 * ```typescript
 * relay.on('error', (error) => console.error(error));
 * relay.once('start', (info) => console.log(info.tracks.length));
 * ```
 */
export class TypedEmitter<Events extends Record<keyof Events, (...args: any[]) => void>> {
  private readonly emitter = new EventEmitter();

  /**
   * Add a listener.
   *
   * @param event - Event name
   *
   * @param listener - Called on every emit
   *
   * @returns This emitter
   *
   * @example
   * ```typescript
   * relay.on('sink:error', (sink, error) => console.warn(error));
   * ```
   */
  on<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.emitter.on(event as string, listener);
    return this;
  }

  /**
   * Add a listener that is removed after its first call.
   *
   * @param event - Event name
   *
   * @param listener - Called on the next emit
   *
   * @returns This emitter
   *
   * @example
   * ```typescript
   * relay.once('stop', () => console.log('stopped'));
   * ```
   */
  once<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.emitter.once(event as string, listener);
    return this;
  }

  /**
   * Remove a listener.
   *
   * @param event - Event name
   *
   * @param listener - The listener to remove
   *
   * @returns This emitter
   *
   * @example
   * ```typescript
   * relay.off('error', onError);
   * ```
   */
  off<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.emitter.off(event as string, listener);
    return this;
  }

  /**
   * Call every listener of an event.
   *
   * @param event - Event name
   *
   * @param args - Arguments for the listeners
   *
   * @returns `true` if the event had listeners
   *
   * @example
   * ```typescript
   * emitter.emit('start', info);
   * ```
   */
  emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): boolean {
    // node throws an unhandled 'error' event, a library must not crash its host for that
    if (event === 'error' && this.emitter.listenerCount('error') === 0) return false;
    return this.emitter.emit(event as string, ...args);
  }

  /**
   * Remove every listener of every event.
   *
   * @returns This emitter
   *
   * @example
   * ```typescript
   * relay.removeAllListeners();
   * ```
   */
  removeAllListeners(): this {
    this.emitter.removeAllListeners();
    return this;
  }
}
