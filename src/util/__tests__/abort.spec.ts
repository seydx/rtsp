import { describe, expect, it } from 'vitest';

import { delay, linkAbort } from '../abort.js';

describe('delay', () => {
  it('resolves after the given time', async () => {
    const start = performance.now();
    await delay(30, new AbortController().signal);
    expect(performance.now() - start).toBeGreaterThanOrEqual(25);
  });

  it('resolves early when the signal aborts', async () => {
    const controller = new AbortController();
    const start = performance.now();
    setTimeout(() => controller.abort(), 10);
    await delay(5000, controller.signal);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('resolves at once for an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delay(5000, controller.signal)).resolves.toBeUndefined();
  });
});

describe('linkAbort', () => {
  it('forwards an abort until unlinked', () => {
    const outer = new AbortController();
    const inner = new AbortController();
    const unlink = linkAbort(outer.signal, inner);
    outer.abort(new Error('stop'));
    expect(inner.signal.aborted).toBe(true);
    expect(inner.signal.reason).toEqual(new Error('stop'));
    unlink();
  });

  it('stops forwarding after unlink', () => {
    const outer = new AbortController();
    const inner = new AbortController();
    linkAbort(outer.signal, inner)();
    outer.abort();
    expect(inner.signal.aborted).toBe(false);
  });

  it('aborts at once when the signal already aborted', () => {
    const outer = new AbortController();
    outer.abort();
    const inner = new AbortController();
    linkAbort(outer.signal, inner);
    expect(inner.signal.aborted).toBe(true);
  });
});
