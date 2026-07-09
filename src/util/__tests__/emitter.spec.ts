import { describe, expect, it } from 'vitest';

import { TypedEmitter } from '../emitter.js';

interface TestEvents {
  error: (error: unknown) => void;
  data: (value: number) => void;
}

class TestEmitter extends TypedEmitter<TestEvents> {}

describe('TypedEmitter', () => {
  it('delivers typed events to registered listeners', () => {
    const emitter = new TestEmitter();
    const seen: number[] = [];
    emitter.on('data', (value) => seen.push(value));

    expect(emitter.emit('data', 42)).toBe(true);
    expect(seen).toEqual([42]);
  });

  it("does not throw when 'error' is emitted without a listener", () => {
    const emitter = new TestEmitter();
    // A raw Node EventEmitter would throw the payload here and crash the process.
    expect(() => emitter.emit('error', new Error('boom'))).not.toThrow();
    expect(emitter.emit('error', new Error('boom'))).toBe(false);
  });

  it("still delivers 'error' when a listener is registered", () => {
    const emitter = new TestEmitter();
    const seen: unknown[] = [];
    emitter.on('error', (error) => seen.push(error));

    expect(emitter.emit('error', 'oops')).toBe(true);
    expect(seen).toEqual(['oops']);
  });

  it('removes listeners via off and removeAllListeners', () => {
    const emitter = new TestEmitter();
    const seen: number[] = [];
    const listener = (value: number): void => {
      seen.push(value);
    };

    emitter.on('data', listener);
    emitter.off('data', listener);
    emitter.emit('data', 1);

    emitter.on('data', listener);
    emitter.removeAllListeners();
    emitter.emit('data', 2);

    expect(seen).toEqual([]);
  });
});
