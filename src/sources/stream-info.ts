import { AVMEDIA_TYPE_AUDIO, AVMEDIA_TYPE_VIDEO } from 'node-av/constants';
import { avGetCodecName } from 'node-av/lib';

import type { Stream } from 'node-av/lib';
import type { TrackInfo, TrackKind } from '../types.js';

/**
 * Map a node-av stream onto a relay track kind.
 *
 * @param stream - The stream to classify
 *
 * @returns `video`, `audio`, or `data` for everything else
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
 * Describe a node-av stream as a relay track.
 *
 * @param stream - The stream to describe
 *
 * @param index - Track index to expose, defaults to the stream's own index
 *
 * @returns The track description, carrying the native stream for AV-backed sinks
 *
 * @internal
 */
export function toTrackInfo(stream: Stream, index = stream.index): TrackInfo {
  const timeBase = stream.timeBase;
  return {
    index,
    kind: trackKindOf(stream),
    codec: avGetCodecName(stream.codecpar.codecId) ?? 'unknown',
    native: stream,
    timeBase: { num: timeBase.num, den: timeBase.den },
  };
}
