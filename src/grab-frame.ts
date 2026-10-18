import { CallbackSink } from './sinks/callback.js';

import type { Relay } from './relay.js';

/**
 * Options for {@link grabFrame}.
 */
export interface GrabFrameOptions {
  /**
   * Time in milliseconds to wait for the frame, including opening the upstream.
   *
   * @default 10000
   */
  timeout?: number;

  /**
   * Index of the track to grab from, defaults to the first video track.
   */
  track?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Grab the next frame of a relay's video track.
 *
 * Attaches a short-lived sink to the relay, takes the first packet of the
 * track and detaches again. The bytes are the frame as the source encoded it,
 * nothing is decoded or re-encoded: a complete JPEG image for an MJPEG
 * source, a keyframe for H.264 or HEVC, because every sink starts at one. The
 * frame comes from the shared upstream, so a camera that accepts a single
 * client serves snapshots and viewers over one connection.
 *
 * A relay that is not running opens its upstream for the grab and closes it
 * again `idleTimeout` after it. Give the relay an `idleTimeout` so that
 * snapshots in a row reuse the connection.
 *
 * @param relay - The relay to grab from
 *
 * @param options - Timeout and track
 *
 * @returns The encoded frame, a copy owned by the caller
 *
 * @throws {Error} If the source has no such track, the relay fails or stops
 * before a frame arrived, or no frame arrived within the timeout
 *
 * @example
 * ```typescript
 * import { AvSource, grabFrame, Relay } from '@seydx/rtsp';
 *
 * const relay = new Relay({ source: new AvSource('http://camera.local/video.mjpg', { format: 'mpjpeg', wallclock: true }), idleTimeout: 10_000 });
 * const jpeg = await grabFrame(relay, { timeout: 5000 });
 * ```
 *
 * @see {@link CallbackSink} For observing every packet instead
 */
export async function grabFrame(relay: Relay, options: GrabFrameOptions = {}): Promise<Buffer> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  let resolve!: (frame: Buffer) => void;
  let reject!: (error: unknown) => void;
  const frame = new Promise<Buffer>((done, fail) => ((resolve = done), (reject = fail)));
  let track: number | undefined;

  // the relay's own error says more than the stop that follows it
  const onError = (error: unknown): void => reject(error);
  relay.on('error', onError);
  const sink = relay.pipe(
    new CallbackSink({
      onInit: (info) => {
        track = options.track ?? info.tracks.find((candidate) => candidate.kind === 'video')?.index;
        if (track === undefined) reject(new Error('the source has no video track'));
        else if (!info.tracks.some((candidate) => candidate.index === track)) reject(new Error(`the source has no track ${track}`));
      },
      onPacket: (packet) => {
        if (packet.streamIndex !== track) return;
        const data = packet.av?.data;
        // the relay frees the packet once this returns, the caller gets bytes of its own
        if (data) resolve(Buffer.from(data));
        else reject(new Error('the frame carries no data'));
      },
      onClose: () => reject(new Error('the relay stopped before a frame arrived')),
    }),
  );
  const timer = setTimeout(() => reject(new Error(`no frame within ${timeout}ms`)), timeout);

  try {
    return await frame;
  } finally {
    clearTimeout(timer);
    relay.off('error', onError);
    await relay.unpipe(sink);
  }
}
