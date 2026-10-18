import { AV_LOG_DEBUG, AV_LOG_ERROR, AV_LOG_INFO, AV_LOG_WARNING } from 'node-av/constants';
import { Log } from 'node-av/lib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installNativeLogging } from '../native-logging.js';

type Callback = (level: number, message: string) => void;

function captureCallbacks(): { calls: (Callback | null)[]; options: unknown[] } {
  const calls: (Callback | null)[] = [];
  const options: unknown[] = [];
  vi.spyOn(Log, 'setCallback').mockImplementation(((callback: Callback | null, opts?: unknown) => {
    calls.push(callback);
    options.push(opts);
  }) as never);
  return { calls, options };
}

describe('installNativeLogging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes native messages by level', () => {
    const { calls, options } = captureCallbacks();
    const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const handle = installNativeLogging(logger);
    const callback = calls[0]!;

    callback(AV_LOG_ERROR, 'broken');
    callback(AV_LOG_WARNING, 'odd');
    callback(AV_LOG_INFO, 'fyi');

    expect(logger.error).toHaveBeenCalledWith('[node-av] broken');
    expect(logger.warn).toHaveBeenCalledWith('[node-av] odd');
    expect(logger.debug).toHaveBeenCalledWith('[node-av] fyi');
    expect(options[0]).toEqual({ maxLevel: AV_LOG_WARNING });
    handle.dispose();
  });

  it('drops known noise and custom patterns', () => {
    const { calls } = captureCallbacks();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const handle = installNativeLogging(logger, { ignore: ['Estimating duration', /^Qavg/], maxLevel: AV_LOG_DEBUG });
    const callback = calls[0]!;

    callback(AV_LOG_WARNING, '2 frames left in the queue on closing');
    callback(AV_LOG_WARNING, 'deprecated pixel format used');
    callback(AV_LOG_WARNING, 'RFC 2435 suggests two quantization tables, 1 provided');
    callback(AV_LOG_ERROR, 'Invalid RTP/JPEG packet. Invalid qtable length 64.');
    callback(AV_LOG_ERROR, 'Cannot load libcuda.so.1');
    callback(AV_LOG_ERROR, 'Could not dynamically load CUDA');
    callback(AV_LOG_WARNING, 'Estimating duration from bitrate');
    callback(AV_LOG_WARNING, 'kept');
    // a length the depacketizer rejects is a real error
    callback(AV_LOG_ERROR, 'Invalid RTP/JPEG packet. Invalid qtable length 100.');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('[node-av] kept');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('[node-av] Invalid RTP/JPEG packet. Invalid qtable length 100.');
    handle.dispose();
  });

  it('releases the process-wide slot once and only for the active bridge', () => {
    const { calls } = captureCallbacks();
    const first = installNativeLogging({});
    const second = installNativeLogging({});
    // installing the second disposed the first
    expect(calls.filter((call) => call === null)).toHaveLength(1);

    first.dispose();
    expect(calls.filter((call) => call === null)).toHaveLength(1);
    second.dispose();
    second.dispose();
    expect(calls.filter((call) => call === null)).toHaveLength(2);
  });
});
