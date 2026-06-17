import { AVMEDIA_TYPE_AUDIO, AVMEDIA_TYPE_VIDEO, avGetCodecName } from 'node-av';

import type { TrackInfo, TrackKind } from '../types.js';
import type { Stream } from 'node-av';

/**
 * Classify a node-av stream into a relay track kind.
 *
 * Maps the stream's underlying FFmpeg media type onto the simplified
 * {@link TrackKind} vocabulary used throughout the relay. Video and audio
 * streams map to their respective kinds; everything else (subtitles, data,
 * attachments, unknown) collapses to `data`.
 *
 * @param stream - The node-av stream to classify
 *
 * @returns The relay track kind for the stream's media type
 *
 * @see {@link TrackInfo} For the full per-track metadata structure
 *
 * @internal
 */
export function trackKindOf(stream: Stream): TrackKind {
  switch (stream.codecpar.codecType) {
    case AVMEDIA_TYPE_VIDEO:
      return 'video';
    case AVMEDIA_TYPE_AUDIO:
      return 'audio';
    default:
      return 'data';
  }
}

/**
 * Build a relay {@link TrackInfo} descriptor from a node-av stream.
 *
 * Extracts the relay-relevant metadata (kind, codec name, time base) from a
 * node-av stream while carrying the native stream handle opaquely for sinks
 * that need to re-mux it. The codec name is resolved from the stream's codec
 * id and falls back to `'unknown'` when it cannot be determined.
 *
 * @param stream - The node-av stream to describe
 *
 * @param index - Track index to assign; defaults to the stream's own index but
 * may be overridden with a remapped global value when several demuxers are
 * merged into a single track list
 *
 * @returns A relay track descriptor for the stream
 *
 * @see {@link TrackInfo} For the shape of the returned descriptor
 *
 * @see {@link trackKindOf} For the kind classification used here
 *
 * @internal
 */
export function toTrackInfo(stream: Stream, index = stream.index): TrackInfo {
  const tb = stream.timeBase;
  return {
    index,
    kind: trackKindOf(stream),
    codec: avGetCodecName(stream.codecpar.codecId) ?? 'unknown',
    native: stream,
    // Copy into a plain object so consumers never hold a reference to the
    // native rational; absent on sources that do not expose a time base.
    timeBase: tb ? { num: tb.num, den: tb.den } : undefined,
  };
}
