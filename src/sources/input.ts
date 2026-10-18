import { Demuxer } from 'node-av/api';
import { AV_NOPTS_VALUE, AVMEDIA_TYPE_AUDIO } from 'node-av/constants';
import { FFmpegError, FormatContext, Rational } from 'node-av/lib';

import type { Packet, Stream } from 'node-av/lib';
import type { Readable } from 'node:stream';
import type { Logger } from '../types.js';

/**
 * Input accepted by the node-av backed sources.
 *
 * A URL or file path (`rtsp://`, `http(s)://`, `tcp://`, a local path), an
 * in-memory `Buffer` of muxed bytes, or a Node.js `Readable` carrying a byte
 * stream. A `Readable` can only be read once, so it cannot be looped or
 * reconnected.
 */
export type AvInput = string | Buffer | Readable;

/**
 * Demuxer settings for one {@link DemuxInput}.
 *
 * @internal
 */
export interface DemuxSettings {
  format?: string;
  options?: Record<string, string | number>;
  /** Replace the input timestamps with the arrival time. */
  wallclock?: boolean;
  /** After a reopen, skip the time the input was gone, to stay aligned with inputs that kept running. */
  catchUp?: boolean;
  logger?: Logger;
}

/**
 * Layout snapshot of one stream, compared after a reopen.
 *
 * @internal
 */
export interface LayoutEntry {
  codecType: number;
  codecId: number;
  timeBase: string;
}

// wallclock stamps need a finer grid than the 1/25 that MJPEG demuxers report
const WALLCLOCK_TIME_BASE = new Rational(1, 90_000);
// audio keeps its sample timeline while it stays this close to the wallclock
const WALLCLOCK_TOLERANCE_S = 0.2;
// audio that stays ahead by more than the tolerance for this long is cut back
const WALLCLOCK_LEAD_WINDOW_S = 1;

/**
 * Keeps the timestamps of one stream usable.
 *
 * A reopened input restarts its own clock (a looped file begins at zero, a
 * reconnected camera may reset its RTP mapping), so the first packet after a
 * reopen re-anchors an offset that continues the previous timeline. Packets
 * without any timestamp, as produced by raw elementary streams, get one
 * synthesized from their duration or the stream's frame rate. The first pass of
 * a timed input is never modified.
 *
 * With catch-up, the timeline also skips the time between the last packet
 * before and the first packet after a reopen, so an input that reconnected
 * stays aligned with other inputs that kept running meanwhile.
 *
 * In wallclock mode every packet is stamped with its arrival time instead.
 * Audio packets continue their own sample timeline while it stays within a
 * small tolerance of the wallclock, so bursty arrival does not turn into
 * audible jitter. A burst of buffered audio, as an input delivers what it read
 * ahead while opening or what piled up during a stall, would keep that
 * timeline ahead of the picture for good. Once it stays ahead by more than the
 * tolerance for a whole window, as much audio as it is ahead is dropped.
 * Devices that send their audio in large chunks fall back to no lead with
 * every chunk and are left alone.
 *
 * @internal
 */
class TrackClock {
  private offset = 0n;
  private end = 0n;
  private rebase = false;
  private resume?: number;
  private last = 0n;
  private arrival?: number;
  private window?: { start: bigint; lead: bigint };
  private skipUntil?: bigint;
  private readonly frameDuration: bigint;
  private readonly ticksPerSecond: number;
  private readonly tolerance: bigint;

  /**
   * @param stream - The stream whose packets are stamped
   *
   * @param epoch - Wallclock origin in `performance.now()` milliseconds, set in wallclock mode
   *
   * @param catchUp - Skip the time the input was gone on a reopen
   *
   * @param logger - Reports audio that is cut back to the wallclock
   *
   * @internal
   */
  constructor(
    stream: Stream,
    private readonly epoch?: number,
    private readonly catchUp = false,
    private readonly logger?: Logger,
  ) {
    const timeBase = stream.timeBase;
    this.frameDuration = frameDuration(stream);
    this.ticksPerSecond = timeBase.den / timeBase.num;
    // video durations are often guessed from a nominal frame rate, only audio durations are exact
    this.tolerance = stream.codecpar.codecType === AVMEDIA_TYPE_AUDIO ? BigInt(Math.round(WALLCLOCK_TOLERANCE_S * this.ticksPerSecond)) : -1n;
  }

  /**
   * Re-anchor the timeline on the next timed packet.
   *
   * @param opened - When the reopen started, in `performance.now()` milliseconds
   *
   * @internal
   */
  restart(opened: number): void {
    this.rebase = true;
    this.resume = this.arrival !== undefined ? opened : undefined;
  }

  /**
   * Adjust the timestamps of one packet in place.
   *
   * @param packet - The packet to adjust
   *
   * @returns `false` if the packet is dropped to bring wallclock audio back in line
   *
   * @internal
   */
  stamp(packet: Packet): boolean {
    if (this.epoch !== undefined) return this.stampArrival(packet, this.epoch);

    const pts = packet.pts;
    const dts = packet.dts;
    const duration = packet.duration;
    const raw = dts !== AV_NOPTS_VALUE ? dts : pts;

    if (this.resume !== undefined) {
      // what the open read ahead arrives in one burst after it, but dates from when the reopen started
      const gone = BigInt(Math.round(((this.resume - (this.arrival ?? 0)) / 1000) * this.ticksPerSecond));
      this.resume = undefined;
      if (this.last + gone > this.end) this.end = this.last + gone;
    }

    if (raw === AV_NOPTS_VALUE) {
      const step = duration > 0n ? duration : this.frameDuration;
      // no basis for a clock, leave it untimed rather than collapse every packet onto one instant
      if (step <= 0n) return true;
      packet.pts = this.end;
      packet.dts = this.end;
      this.mark(this.end);
      this.end += step;
      return true;
    }

    if (this.rebase) {
      this.rebase = false;
      this.offset = this.end - raw;
    }
    if (this.offset !== 0n) {
      if (pts !== AV_NOPTS_VALUE) packet.pts = pts + this.offset;
      if (dts !== AV_NOPTS_VALUE) packet.dts = dts + this.offset;
    }
    this.mark(raw + this.offset);
    // a packet without duration still advances one tick so the next pass never collides with it
    const next = raw + this.offset + (duration > 0n ? duration : 1n);
    if (next > this.end) this.end = next;
    return true;
  }

  /**
   * Remember the newest timestamp and when it arrived, for catching up after a reopen.
   *
   * @param timestamp - The packet's adjusted decode timestamp
   *
   * @internal
   */
  private mark(timestamp: bigint): void {
    if (!this.catchUp) return;
    this.last = timestamp;
    this.arrival = performance.now();
  }

  /**
   * Stamp a packet with its arrival time, strictly increasing.
   *
   * @param packet - The packet to stamp
   *
   * @param epoch - Wallclock origin in `performance.now()` milliseconds
   *
   * @returns `false` if the packet is dropped to bring audio back in line
   *
   * @internal
   */
  private stampArrival(packet: Packet, epoch: number): boolean {
    const now = BigInt(Math.round(((performance.now() - epoch) / 1000) * this.ticksPerSecond));
    const duration = this.tolerance >= 0n ? packet.duration : 0n;
    if (duration > 0n && this.skipUntil !== undefined) {
      if (now < this.skipUntil) return false;
      this.skipUntil = undefined;
    }
    const slack = duration > 0n ? this.tolerance : 0n;
    const pts = now > this.end + slack ? now : this.end;
    packet.pts = pts;
    packet.dts = pts;
    this.end = pts + (duration > 0n ? duration : 1n);
    if (duration > 0n) this.watchLead(pts - now, now);
    return true;
  }

  /**
   * Track how far audio runs ahead of the wallclock and cut back a lead that never drops.
   *
   * @param lead - How far the packet's timestamp is ahead of its arrival, in ticks
   *
   * @param now - Arrival time in ticks
   *
   * @internal
   */
  private watchLead(lead: bigint, now: bigint): void {
    const window = this.window;
    if (!window) {
      this.window = { start: now, lead };
      return;
    }
    if (lead < window.lead) window.lead = lead;
    if (now - window.start < BigInt(Math.round(WALLCLOCK_LEAD_WINDOW_S * this.ticksPerSecond))) return;

    if (window.lead > this.tolerance) {
      // timestamps cannot go back, so the audio that arrives while the wallclock catches up is dropped
      this.skipUntil = now + window.lead;
      this.window = undefined;
      this.logger?.debug?.(`[rtsp] audio ran ${Math.round((Number(window.lead) / this.ticksPerSecond) * 1000)}ms ahead of the wallclock, dropping that much`);
      return;
    }
    // the closing packet opens the next window, a chunk start counts in both
    this.window = { start: now, lead };
  }
}

/**
 * One node-av demuxer input with a timeline that survives reopens.
 *
 * Shared by {@link AvSource} and {@link MultiSource}. The demuxer is opened
 * with an abort signal, so aborting it interrupts a blocked open or read and
 * the input can be closed without freeing the demuxer under a running read.
 *
 * @internal
 */
export class DemuxInput {
  private demuxer?: Demuxer;
  private snapshot?: FormatContext;
  private copies: Stream[] = [];
  private readonly clocks = new Map<number, TrackClock>();
  private epoch = performance.now();

  /**
   * @param input - The input to demux
   *
   * @param settings - Format, demuxer options and timestamp mode
   *
   * @internal
   */
  constructor(
    readonly input: AvInput,
    private readonly settings: DemuxSettings = {},
  ) {}

  /**
   * Copies of the streams of the first open, valid until {@link DemuxInput.dispose}.
   *
   * Handed to sinks, which may use them for the whole stream, while every
   * reopen frees the demuxer's own streams.
   *
   * @internal
   */
  get tracks(): Stream[] {
    return this.copies;
  }

  /**
   * The open demuxer, if any.
   *
   * @internal
   */
  get current(): Demuxer | undefined {
    return this.demuxer;
  }

  /**
   * Open the demuxer, continuing the timeline of a previous open.
   *
   * @param signal - Interrupts the open and every later read when it aborts
   *
   * @returns The streams of the opened input
   *
   * @throws {Error} If node-av fails to open the input or the signal aborted
   *
   * @internal
   */
  async open(signal: AbortSignal): Promise<Stream[]> {
    const opened = performance.now();
    // node-av closes a demuxer whose open raced the abort and rethrows the abort
    const demuxer = await Demuxer.open(this.input as string, {
      format: this.settings.format,
      options: this.settings.options as never,
      signal,
    });
    this.demuxer = demuxer;
    for (const clock of this.clocks.values()) clock.restart(opened);
    for (const stream of demuxer.streams) {
      if (this.settings.wallclock && stream.timeBase.num * WALLCLOCK_TIME_BASE.den > stream.timeBase.den) stream.timeBase = WALLCLOCK_TIME_BASE;
      if (!this.clocks.has(stream.index)) {
        this.clocks.set(stream.index, new TrackClock(stream, this.settings.wallclock ? this.epoch : undefined, this.settings.catchUp, this.settings.logger));
      }
    }
    if (!this.snapshot) this.copies = this.copyStreams(demuxer.streams);
    return demuxer.streams;
  }

  /**
   * Read packets from the open demuxer until it ends.
   *
   * The caller owns every yielded packet.
   *
   * @yields {Packet} Demuxed packets with usable timestamps
   *
   * @throws {Error} If the input is not open or a read fails
   *
   * @internal
   */
  async *packets(): AsyncGenerator<Packet> {
    if (!this.demuxer) throw new Error('input is not open');
    for await (const packet of this.demuxer.packets()) {
      // node-av yields null as its end sentinel
      if (!packet) continue;
      const clock = this.clocks.get(packet.streamIndex);
      if (clock && !clock.stamp(packet)) {
        packet.free();
        continue;
      }
      yield packet;
    }
  }

  /**
   * Forget the timeline, so the next open starts a fresh one.
   *
   * @param epoch - Wallclock origin in `performance.now()` milliseconds, shared by inputs of one source
   *
   * @internal
   */
  resetTimeline(epoch = performance.now()): void {
    this.clocks.clear();
    this.epoch = epoch;
  }

  /**
   * Close the demuxer, logging instead of throwing.
   *
   * @returns A promise that resolves once the demuxer is closed
   *
   * @internal
   */
  async close(): Promise<void> {
    const demuxer = this.demuxer;
    this.demuxer = undefined;
    try {
      await demuxer?.close();
    } catch (error) {
      this.settings.logger?.error?.('[rtsp] demuxer close failed:', error);
    }
  }

  /**
   * Close the demuxer and free the stream copies, once the sinks are done with them.
   *
   * @returns A promise that resolves once everything is released
   *
   * @internal
   */
  async dispose(): Promise<void> {
    await this.close();
    this.snapshot?.freeContext();
    this.snapshot = undefined;
    this.copies = [];
  }

  /**
   * Copy the streams into a context of their own, with the same indexes.
   *
   * @param streams - Streams of the open demuxer
   *
   * @returns The copies
   *
   * @throws {Error} If the codec parameters cannot be copied
   *
   * @internal
   */
  private copyStreams(streams: readonly Stream[]): Stream[] {
    const snapshot = new FormatContext();
    snapshot.allocContext();
    this.snapshot = snapshot;
    return streams.map((stream) => {
      const copy = snapshot.newStream(null);
      FFmpegError.throwIfError(stream.codecpar.copy(copy.codecpar), 'Failed to copy the stream parameters');
      copy.timeBase = stream.timeBase;
      copy.avgFrameRate = stream.avgFrameRate;
      copy.rFrameRate = stream.rFrameRate;
      copy.sampleAspectRatio = stream.sampleAspectRatio;
      copy.disposition = stream.disposition;
      const metadata = stream.metadata;
      if (metadata) copy.metadata = metadata;
      return copy;
    });
  }
}

/**
 * Capture the layout of an opened input for a later {@link sameLayout} check.
 *
 * @param streams - Streams of the open input
 *
 * @returns One entry per stream
 *
 * @internal
 */
export function captureLayout(streams: readonly Stream[]): LayoutEntry[] {
  return streams.map((stream) => ({
    codecType: stream.codecpar.codecType,
    codecId: stream.codecpar.codecId,
    timeBase: `${stream.timeBase.num}/${stream.timeBase.den}`,
  }));
}

/**
 * Whether a reopened input has the layout of the earlier open.
 *
 * A reconnected upstream must deliver what the sinks were initialized with,
 * otherwise their muxers and decoders would receive foreign packets.
 *
 * @param before - Layout of the earlier open
 *
 * @param after - Streams of the reopened input
 *
 * @returns `true` if count, media types, codecs and time bases match
 *
 * @internal
 */
export function sameLayout(before: readonly LayoutEntry[], after: readonly Stream[]): boolean {
  const current = captureLayout(after);
  return (
    current.length === before.length &&
    current.every((entry, i) => entry.codecType === before[i].codecType && entry.codecId === before[i].codecId && entry.timeBase === before[i].timeBase)
  );
}

/**
 * Per-frame duration of a stream derived from its frame rate.
 *
 * @param stream - The stream to inspect
 *
 * @returns The duration in time base units, or `0n` without a usable frame rate
 *
 * @internal
 */
function frameDuration(stream: Stream): bigint {
  const timeBase = stream.timeBase;
  const rate = stream.rFrameRate.num > 0 ? stream.rFrameRate : stream.avgFrameRate;
  if (timeBase.num <= 0 || timeBase.den <= 0 || rate.num <= 0 || rate.den <= 0) return 0n;
  return BigInt(Math.round((timeBase.den * rate.den) / (timeBase.num * rate.num)));
}
