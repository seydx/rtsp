// Core relay
export { Relay } from './relay.js';
export type { RelayOptions, RelayEvents, RelayState } from './relay.js';

// Shared contracts and types
export type { Logger, Source, Sink, StreamInfo, TrackInfo, TrackKind, MediaPacket, BackchannelInfo, BackchannelSource } from './types.js';
export { supportsBackchannel } from './types.js';

// Sources
export { AvSource } from './sources/av.js';
export type { AvInput, AvSourceOptions } from './sources/av.js';

export { MultiSource } from './sources/multi.js';
export type { MultiSourceInput } from './sources/multi.js';

// Sinks
export { CallbackSink } from './sinks/callback.js';
export type { CallbackSinkHandlers } from './sinks/callback.js';

export { FfmpegSink } from './sinks/ffmpeg.js';
export type { FfmpegSinkOptions, FfmpegOutput } from './sinks/ffmpeg.js';

export { RtspServerSink, RtspAuth, BackchannelTranscoder } from './sinks/rtsp-server/index.js';
export type {
  RtspServerSinkOptions,
  RtspServerEvents,
  RtspAuthConfig,
  BackchannelAdvertise,
  BackchannelTranscoderOptions,
  BackchannelInput,
  BackchannelTarget,
} from './sinks/rtsp-server/index.js';

// Packet helpers
export { wrapAvPacket, requireAvPacket } from './av-packet.js';
