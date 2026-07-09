import { avGetCodecName, Demuxer } from 'node-av';

import { wrapAvPacket } from '../av-packet.js';
import { toTrackInfo } from './stream-info.js';

import type { BackchannelInfo, BackchannelSource, Logger, MediaPacket, Source, StreamInfo } from '../types.js';

/**
 * Input accepted by an {@link AvSource}.
 *
 * Mirrors everything node-av's `Demuxer.open` understands: a URL or path string
 * (`rtsp://`, `tcp://`, `http(s)://`, or a local file path) or an in-memory
 * `Buffer` of already-muxed bytes. The string form is also what enables RTSP
 * specific behaviour such as transport selection and the ONVIF backchannel.
 */
export type AvInput = string | Buffer;

/**
 * Options controlling how an {@link AvSource} opens and reads its input.
 *
 * Every field is optional; the defaults are tuned for inherently live inputs
 * such as RTSP cameras. Options that map onto libav demuxer settings (transport,
 * timeout, format) are forwarded to node-av's `Demuxer.open`, while pacing and
 * looping are applied by the source itself.
 */
export interface AvSourceOptions {
  /**
   * Force a specific input demuxer instead of relying on auto-detection.
   *
   * Useful for raw or headerless inputs where libav cannot probe the container,
   * for example `h264` or `mpegts`. When omitted, the format is detected from
   * the URL scheme and the input bytes.
   */
  format?: string;

  /**
   * Lower-layer transport used for RTSP inputs.
   *
   * Shorthand for the `rtsp_transport` demuxer option: `tcp` is interleaved and
   * firewall-friendly, `udp` lowers latency at the cost of possible packet loss.
   * Ignored for non-RTSP inputs. When omitted, libav chooses its own default.
   */
  transport?: 'tcp' | 'udp';

  /**
   * Open and read timeout in microseconds.
   *
   * Passed through as the libav `timeout` (a.k.a. `stimeout`) option; the I/O
   * layer aborts if no data arrives within this window. Note the unit is
   * microseconds, so one second is `1_000_000`. When omitted, libav blocks
   * indefinitely.
   */
  timeout?: number;

  /**
   * Throttle delivery to a multiple of real time, like ffmpeg's `-re` flag.
   *
   * A value of `1` paces packets to the source's own timestamps, which is
   * required to serve a non-realtime input (such as a file) as a live stream;
   * larger values play faster than real time. Omit for inherently live inputs
   * (e.g. RTSP), which already arrive at their natural rate.
   */
  readrate?: number;

  /**
   * Reopen the input automatically when it reaches the end.
   *
   * Enables looping a finite file or reconnecting a stream that terminates:
   * after the input drains, the source closes and reopens it, continuing to
   * yield packets on the same wall clock. When `false` (the default), the
   * packet iterator completes once the input ends.
   */
  loop?: boolean;

  /**
   * Automatically reopen the input after a read failure.
   *
   * Without this, a mid-stream error (camera reboot, network blip) ends the
   * packet iterator and surfaces the error to the consumer. With reconnect
   * enabled, the source instead closes and reopens the input with an
   * exponential backoff, resuming packet delivery once the upstream answers
   * again. An unexpected end-of-stream is also treated as a disconnect when
   * {@link AvSourceOptions.loop} is not set. Pass `true` for the defaults or an
   * {@link AvReconnectOptions} to tune the backoff. The reconnected input is
   * assumed to expose the same stream layout as the original; downstream sinks
   * are not re-initialized.
   */
  reconnect?: boolean | AvReconnectOptions;

  /**
   * Request the ONVIF backchannel (talkback) on an RTSP input.
   *
   * When enabled, `backchannel=1` is appended to the RTSP URL and, once the
   * input is open, the camera's advertised send-only stream is exposed via
   * {@link BackchannelSource}. If the camera advertises no backchannel, a
   * warning is logged and the feature is silently unavailable.
   */
  backchannel?: boolean;

  /**
   * Extra format-specific demuxer options passed straight through to libav.
   *
   * Merged underneath the dedicated fields ({@link AvSourceOptions.transport}
   * and {@link AvSourceOptions.timeout} take precedence over identically named
   * keys here). Use this to set any libav option that has no first-class field.
   */
  options?: Record<string, string | number>;

  /**
   * Optional logger for diagnostic output.
   *
   * Receives debug messages when the input is opened and warnings or errors when
   * the backchannel is missing or teardown fails. When omitted, the source runs
   * silently.
   */
  logger?: Logger;
}

/**
 * Backoff tuning for {@link AvSourceOptions.reconnect}.
 *
 * Controls how aggressively the source retries reopening its input after a
 * read failure. Every field is optional; the defaults reconnect quickly at
 * first and back off exponentially so an unreachable camera is not hammered.
 */
export interface AvReconnectOptions {
  /**
   * Initial delay before the first reopen attempt, in milliseconds.
   *
   * Doubled on every consecutive failed attempt up to
   * {@link AvReconnectOptions.maxDelayMs}. Defaults to `1000`.
   */
  delayMs?: number;

  /**
   * Upper bound for the exponential backoff delay, in milliseconds.
   *
   * Defaults to `30000`.
   */
  maxDelayMs?: number;

  /**
   * Maximum number of consecutive failed attempts before giving up.
   *
   * Counts attempts since the last successfully delivered packet; once
   * exceeded, the original error is thrown to the consumer. Defaults to
   * unlimited retries.
   */
  maxRetries?: number;
}

/**
 * Resolved reconnect policy with all defaults applied.
 *
 * @internal
 */
interface ReconnectPolicy {
  delayMs: number;
  maxDelayMs: number;
  maxRetries: number;
}

/**
 * Normalize the user-facing reconnect option into a concrete policy.
 *
 * @param option - The raw `reconnect` option value
 *
 * @returns The resolved policy, or `undefined` when reconnecting is disabled
 *
 * @internal
 */
function resolveReconnect(option: boolean | AvReconnectOptions | undefined): ReconnectPolicy | undefined {
  if (!option) return undefined;
  const opts = option === true ? {} : option;
  return {
    delayMs: opts.delayMs ?? 1000,
    maxDelayMs: opts.maxDelayMs ?? 30_000,
    maxRetries: opts.maxRetries ?? Number.POSITIVE_INFINITY,
  };
}

/**
 * Compute the exponential backoff delay for the given attempt number.
 *
 * @param policy - The resolved reconnect policy
 *
 * @param attempt - 1-based count of consecutive failed attempts
 *
 * @returns The delay in milliseconds, capped at the policy's maximum
 *
 * @internal
 */
function backoffDelay(policy: ReconnectPolicy, attempt: number): number {
  return Math.min(policy.delayMs * 2 ** (attempt - 1), policy.maxDelayMs);
}

/**
 * Append `backchannel=1` to an RTSP URL, preserving any existing query string.
 *
 * Returns the URL unchanged if a `backchannel` query parameter is already
 * present, so it is safe to call more than once.
 *
 * @param input - RTSP URL to augment
 *
 * @returns The URL with the backchannel query parameter ensured
 *
 * @internal
 */
function withBackchannel(input: string): string {
  if (/[?&]backchannel=/.test(input)) return input;
  return input + (input.includes('?') ? '&' : '?') + 'backchannel=1';
}

/**
 * Wait for the given duration, resolving early if the signal aborts.
 *
 * Used by the read-rate pacer so that an in-flight delay does not hold up
 * shutdown when the consumer aborts mid-stream.
 *
 * @param ms - Delay in milliseconds
 *
 * @param signal - Abort signal that resolves the delay immediately when fired
 *
 * @returns A promise that settles after `ms` or on abort, whichever is first
 *
 * @internal
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * A relay source backed by node-av's demuxer.
 *
 * Because libav handles the input, a single instance covers RTSP, TCP, HTTP(S),
 * local files and raw byte streams behind one uniform interface — the relay
 * never sees the difference. When pointed at an RTSP camera, it can also expose
 * the ONVIF backchannel so viewer audio can be sent back upstream, and it can
 * pace or loop finite inputs to behave like a continuous live stream.
 *
 * @example
 * ```typescript
 * import { AvSource, Relay } from '@seydx/rtsp';
 *
 * // Live RTSP camera over TCP with talkback enabled.
 * const source = new AvSource('rtsp://user:pass@camera.local/stream', {
 *   transport: 'tcp',
 *   backchannel: true,
 * });
 *
 * const relay = new Relay({ source });
 * await relay.start();
 * ```
 *
 * @example
 * ```typescript
 * import { AvSource } from '@seydx/rtsp';
 *
 * // Serve a file as a looping live stream paced to real time.
 * const source = new AvSource('/media/clip.mp4', { readrate: 1, loop: true });
 * ```
 *
 * @see {@link Source} For the relay source contract
 *
 * @see {@link BackchannelSource} For the talkback contract this source implements
 *
 * @see {@link Relay} For wiring a source to one or more sinks
 */
export class AvSource implements Source, BackchannelSource {
  private demuxer?: Demuxer;
  private _backchannel?: BackchannelInfo;

  /** Aborts the demuxer reads on teardown so close() never frees the demuxer mid-read. */
  private abort?: AbortController;

  /** Resolves when the active packets() read loop has fully unwound; awaited by close(). */
  private reading?: Promise<void>;

  /**
   * Create a source for the given input.
   *
   * No I/O happens here; the input is opened lazily by {@link AvSource.open}.
   *
   * @param input - URL, path, or in-memory buffer to demux
   *
   * @param opts - Options controlling transport, timeout, pacing, looping and the backchannel
   */
  constructor(
    private readonly input: AvInput,
    private readonly opts: AvSourceOptions = {},
  ) {}

  /**
   * The upstream talkback format, once known.
   *
   * Populated by {@link AvSource.open} when {@link AvSourceOptions.backchannel}
   * is enabled and the camera advertises a send-only stream; otherwise
   * `undefined`.
   *
   * @example
   * ```typescript
   * await source.open();
   * if (source.backchannel) {
   *   console.log('talkback codec:', source.backchannel.codec);
   * }
   * ```
   */
  get backchannel(): BackchannelInfo | undefined {
    return this._backchannel;
  }

  /**
   * Open the input and resolve its stream layout.
   *
   * Establishes the demuxer connection and, when the backchannel is requested,
   * reads the camera's talkback descriptor. Must be called once before
   * {@link AvSource.packets}.
   *
   * @returns The resolved stream info, including tracks and an optional backchannel descriptor
   *
   * @throws {Error} If node-av fails to open the input
   *
   * @example
   * ```typescript
   * const source = new AvSource('rtsp://camera.local/stream');
   * const info = await source.open();
   * console.log(info.tracks.map((t) => t.codec));
   * ```
   */
  async open(): Promise<StreamInfo> {
    this.abort = new AbortController();
    this.demuxer = await this.openDemuxer();
    if (this.opts.backchannel) this._backchannel = this.readBackchannel();
    return { tracks: this.demuxer.streams.map(toTrackInfo), backchannel: this._backchannel };
  }

  /**
   * Send one RTP packet of talkback audio back to the camera.
   *
   * The payload must already be encoded in the backchannel codec described by
   * {@link AvSource.backchannel}. The call is a no-op when the input is not open
   * or no backchannel is available, and send failures are logged rather than
   * thrown.
   *
   * @param rtp - A single RTP packet in the backchannel codec
   *
   * @example
   * ```typescript
   * if (source.backchannel) {
   *   source.sendBackchannel(rtpPacket);
   * }
   * ```
   */
  sendBackchannel(rtp: Buffer): void {
    if (!this.demuxer || !this._backchannel) return;
    this.demuxer
      .getFormatContext()
      .sendRTSPPacket(this._backchannel.streamIndex, rtp)
      .catch((error) => this.opts.logger?.debug?.('[rtsp] sendBackchannel failed:', error));
  }

  /**
   * Yield demuxed media packets until the signal aborts or the input ends.
   *
   * Drives one read pass over the input; when {@link AvSourceOptions.loop} is
   * enabled, the input is reopened on completion and streaming continues on the
   * same wall clock until aborted. With {@link AvSourceOptions.reconnect}, read
   * failures (and unexpected end-of-stream) reopen the input under an
   * exponential backoff instead of ending iteration. {@link AvSource.open} must
   * have been called first.
   *
   * @param signal - Abort signal that stops iteration and aborts any in-flight pacing delay
   *
   * @yields {MediaPacket} Demuxed media packets (each must be freed by the caller)
   *
   * @throws {Error} If called before {@link AvSource.open}, or when a read fails
   * and reconnecting is disabled or its retries are exhausted
   *
   * @example
   * ```typescript
   * const ac = new AbortController();
   * await source.open();
   * for await (const packet of source.packets(ac.signal)) {
   *   handle(packet);
   *   packet.free();
   * }
   * ```
   */
  async *packets(signal: AbortSignal): AsyncIterable<MediaPacket> {
    if (!this.demuxer) throw new Error('AvSource.open() must be called before packets()');

    // Tie the relay's pull signal to our internal abort so aborting either one
    // stops the demuxer read (and lets close() unblock a stalled read).
    const onAbort = (): void => this.abort?.abort();
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const reconnect = resolveReconnect(this.opts.reconnect);
    // Consecutive failed attempts; reset once a reopened input delivers packets.
    const retry = { attempts: 0 };

    // Expose the read loop's lifetime so close() can wait for it to unwind before
    // freeing the demuxer — closing a demuxer mid-read is a process-killing UAF.
    let done!: () => void;
    this.reading = new Promise<void>((resolve) => (done = resolve));
    try {
      while (!signal.aborted) {
        let readError: Error | undefined;
        let produced = false;
        try {
          produced = yield* this.readOnce(signal);
        } catch (error) {
          if (signal.aborted || this.abort?.signal.aborted) break;
          readError = error instanceof Error ? error : new Error(String(error));
        }
        if (signal.aborted) break;
        if (produced) retry.attempts = 0;

        if (readError === undefined && !this.opts.loop && !reconnect) break;

        if (readError !== undefined || !this.opts.loop) {
          // A read failure — or, with reconnect but no loop, an unexpected
          // end-of-stream (a live input that "ends" has disconnected) — gates
          // the reopen behind the backoff.
          retry.attempts++;
          if (!reconnect || retry.attempts > reconnect.maxRetries) {
            if (readError !== undefined) throw readError;
            break;
          }
          if (readError !== undefined) this.opts.logger?.warn?.('[rtsp] AvSource read failed — reconnecting:', readError);
          else this.opts.logger?.warn?.('[rtsp] AvSource input ended — reconnecting');
          // Wait on the internal abort: it fires for both a consumer abort (via
          // the onAbort bridge) and a direct close(), so teardown never has to
          // sit out a long backoff.
          await delay(backoffDelay(reconnect, retry.attempts), this.abort!.signal);
          if (signal.aborted || this.abort?.signal.aborted) break;
        }

        // Reopen the input (loop restart or reconnect attempt) and keep
        // streaming on the same wall clock.
        if (!(await this.reopen(signal, reconnect, retry))) break;
      }
    } finally {
      done();
      this.reading = undefined;
    }
  }

  /**
   * Release the input and all associated native resources.
   *
   * Safe to call more than once and at any time, including before
   * {@link AvSource.open}. After closing, the source can be reopened with a fresh
   * {@link AvSource.open} call.
   *
   * @returns A promise that resolves once the source is fully closed
   *
   * @example
   * ```typescript
   * await source.close();
   * ```
   */
  async close(): Promise<void> {
    // Abort the read, wait for the packets() loop to fully unwind, then free the
    // demuxer — never close it while a read is still in flight.
    this.abort?.abort();
    await this.reading;
    await this.closeDemuxer();
  }

  /**
   * Open the underlying node-av demuxer for the configured input.
   *
   * Builds the demuxer options bag, layering the dedicated transport and timeout
   * fields over any caller-supplied options, and appends the backchannel query
   * to string inputs when talkback is requested.
   *
   * @returns The opened demuxer
   *
   * @throws {Error} If node-av fails to open the input
   *
   * @internal
   */
  private async openDemuxer(): Promise<Demuxer> {
    const options: Record<string, string | number> = { ...this.opts.options };
    if (this.opts.transport) options.rtsp_transport = this.opts.transport;
    if (this.opts.timeout != null) options.timeout = this.opts.timeout;

    let input = this.input;
    if (this.opts.backchannel && typeof input === 'string') input = withBackchannel(input);

    this.opts.logger?.debug?.('[rtsp] AvSource opening', input);
    return Demuxer.open(input, {
      format: this.opts.format as never,
      options: options as never,
      signal: this.abort?.signal,
    });
  }

  /**
   * Close the current input and reopen it, retrying under the reconnect policy.
   *
   * Backs both the plain `loop` restart (a failed reopen throws immediately when
   * reconnecting is disabled, as before) and the reconnect path, where reopen
   * failures are retried with exponential backoff until the policy's retry
   * budget is exhausted.
   *
   * @param signal - Abort signal that cancels retries and in-flight delays
   *
   * @param reconnect - Resolved reconnect policy, or `undefined` when disabled
   *
   * @param retry - Shared retry state across read and reopen failures
   *
   * @param retry.attempts - Count of consecutive failed attempts, reset by the caller once packets flow
   *
   * @returns `true` once the input is open again, `false` when aborted
   *
   * @throws {Error} If a reopen fails and reconnecting is disabled or its
   * retries are exhausted
   *
   * @internal
   */
  private async reopen(signal: AbortSignal, reconnect: ReconnectPolicy | undefined, retry: { attempts: number }): Promise<boolean> {
    await this.closeDemuxer();
    for (;;) {
      if (signal.aborted || this.abort?.signal.aborted) return false;
      try {
        this.demuxer = await this.openDemuxer();
        return true;
      } catch (error) {
        if (signal.aborted || this.abort?.signal.aborted) return false;
        retry.attempts++;
        if (!reconnect || retry.attempts > reconnect.maxRetries) throw error;
        this.opts.logger?.warn?.('[rtsp] AvSource reopen failed — retrying:', error);
        // Internal abort covers both consumer aborts and direct close().
        await delay(backoffDelay(reconnect, retry.attempts), this.abort!.signal);
      }
    }
  }

  /**
   * Read the camera's backchannel descriptor from the open demuxer.
   *
   * Looks for a send-only RTSP stream and maps its codec, payload type and clock
   * parameters into a {@link BackchannelInfo}. Returns `undefined` (and logs a
   * warning) when no backchannel was advertised.
   *
   * @returns The talkback descriptor, or `undefined` if none is available
   *
   * @internal
   */
  private readBackchannel(): BackchannelInfo | undefined {
    const info = this.demuxer?.getFormatContext().getRTSPStreamInfo();
    const send = info?.find((s) => s.direction === 'sendonly');
    if (!send) {
      this.opts.logger?.warn?.('[rtsp] backchannel requested but the camera advertised none');
      return undefined;
    }
    return {
      streamIndex: send.streamIndex,
      codec: avGetCodecName(send.codecId) ?? 'unknown',
      codecId: send.codecId,
      payloadType: send.payloadType,
      clockRate: send.sampleRate ?? 8000,
      channels: send.channels ?? 1,
    };
  }

  /**
   * Run a single read pass over the currently open demuxer.
   *
   * Iterates the demuxer's packets, applying optional read-rate pacing relative
   * to the first packet's wall-clock arrival, and wraps each native packet as a
   * relay {@link MediaPacket}. Aborting frees any in-flight packet and ends the
   * pass.
   *
   * @param signal - Abort signal that stops iteration and shortcuts pacing delays
   *
   * @yields {MediaPacket} Media packets for one pass over the input (each must be freed by the caller)
   *
   * @returns `true` if the pass yielded at least one packet, letting the caller
   * reset its reconnect backoff only once media actually flowed again
   *
   * @internal
   */
  private async *readOnce(signal: AbortSignal): AsyncGenerator<MediaPacket, boolean, void> {
    const demuxer = this.demuxer!;
    const readrate = this.opts.readrate;
    let wallStart = 0;
    let baseSeconds = 0;
    let paced = false;
    let produced = false;

    try {
      for await (const packet of demuxer.packets()) {
        // node-av yields `null` as an end/flush sentinel — nothing to relay.
        if (!packet) continue;
        if (signal.aborted) {
          packet.free();
          return produced;
        }

        if (readrate && readrate > 0) {
          const tb = packet.timeBase;
          const dts = packet.dts;
          if (tb && tb.den > 0 && dts >= 0n) {
            const seconds = (Number(dts) * tb.num) / tb.den / readrate;
            if (!paced) {
              // Anchor the wall clock to the first paced packet so timing is relative, not absolute.
              wallStart = Date.now();
              baseSeconds = seconds;
              paced = true;
            }
            const waitMs = (seconds - baseSeconds) * 1000 - (Date.now() - wallStart);
            // Internal abort covers both consumer aborts and direct close().
            if (waitMs > 1) await delay(waitMs, this.abort?.signal ?? signal);
          }
        }

        produced = true;
        yield wrapAvPacket(packet);
      }
    } catch (error) {
      // A read aborted by teardown (close()/abort) is expected; only surface real errors.
      if (!signal.aborted && !this.abort?.signal.aborted) throw error;
    }
    return produced;
  }

  /**
   * Close the current demuxer and clear the reference.
   *
   * Detaches the demuxer first so a concurrent abort cannot double-close it, then
   * closes it. Close failures are logged and swallowed so teardown always
   * completes.
   *
   * @returns A promise that resolves once the demuxer is closed
   *
   * @internal
   */
  private async closeDemuxer(): Promise<void> {
    const demuxer = this.demuxer;
    this.demuxer = undefined;
    if (!demuxer) return;
    try {
      await demuxer.close();
    } catch (error) {
      this.opts.logger?.error?.('[rtsp] AvSource close failed:', error);
    }
  }
}
