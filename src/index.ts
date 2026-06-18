// Core relay
export { Relay } from './relay.js';
export type { RelayEvents, RelayOptions, RelayState } from './relay.js';

// Shared contracts and types
export { supportsBackchannel } from './types.js';
export type { BackchannelInfo, BackchannelSource, Logger, MediaPacket, Sink, Source, StreamInfo, TrackInfo, TrackKind } from './types.js';

// FFmpeg (node-av) log bridging
export { installNativeLogging } from './native-logging.js';
export type { NativeLoggingHandle, NativeLoggingOptions } from './native-logging.js';

// Sources
export { AvSource } from './sources/av.js';
export type { AvInput, AvSourceOptions } from './sources/av.js';

export { MultiSource } from './sources/multi.js';
export type { MultiSourceInput } from './sources/multi.js';

// Sinks
export { CallbackSink } from './sinks/callback.js';
export type { CallbackSinkHandlers } from './sinks/callback.js';

export { FfmpegSink } from './sinks/ffmpeg.js';
export type { FfmpegOutput, FfmpegSinkOptions } from './sinks/ffmpeg.js';

export { BackchannelTranscoder, RtspAuth, RtspServerSink } from './sinks/rtsp-server/index.js';
export type {
  BackchannelAdvertise,
  BackchannelInput,
  BackchannelTarget,
  BackchannelTranscoderOptions,
  RtspAuthConfig,
  RtspServerEvents,
  RtspServerSinkOptions,
} from './sinks/rtsp-server/index.js';

// Packet helpers
export { requireAvPacket, wrapAvPacket } from './av-packet.js';

// node-av type re-exports
export type { AVCodecID, IOOutputCallbacks, IRational, Packet, Stream } from 'node-av';
