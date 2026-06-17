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
   * same wall clock until aborted. {@link AvSource.open} must have been called
   * first.
   *
   * @param signal - Abort signal that stops iteration and aborts any in-flight pacing delay
   *
   * @yields {MediaPacket} Demuxed media packets (each must be freed by the caller)
   *
   * @throws {Error} If called before {@link AvSource.open}
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

    do {
      yield* this.readOnce(signal);
      if (signal.aborted || !this.opts.loop) break;
      // Loop: reopen the input and keep streaming on the same wall clock.
      await this.closeDemuxer();
      if (signal.aborted) break;
      this.demuxer = await this.openDemuxer();
    } while (!signal.aborted);
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
    });
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
   * @internal
   */
  private async *readOnce(signal: AbortSignal): AsyncIterable<MediaPacket> {
    const demuxer = this.demuxer!;
    const readrate = this.opts.readrate;
    let wallStart = 0;
    let baseSeconds = 0;
    let paced = false;

    for await (const packet of demuxer.packets()) {
      // node-av yields `null` as an end/flush sentinel — nothing to relay.
      if (!packet) continue;
      if (signal.aborted) {
        packet.free();
        return;
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
          if (waitMs > 1) await delay(waitMs, signal);
        }
      }

      yield wrapAvPacket(packet);
    }
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
