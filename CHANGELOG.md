# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [2.0.0] - 2026-10-18

Version 2 is a rework of the whole library: one shared demux and audio pipeline instead of several near-duplicates, a synchronous in-process transcoding path, video re-encoding (MJPEG to H.264 with hardware acceleration), a stricter RTSP server and a test suite that covers every module. The public surface is smaller and more consistent, which breaks some imports and option names; the migration section lists every change.

### Migration from 1.x

- **`relay.serveRtsp(options)` is gone.** Create the server yourself: `const server = await new RtspServerSink(relay, options).listen()`. `server.shutdown()` stops it and detaches it from the relay.
- **`RtspServerSink` `backchannel`**: an advertised format moved into an object, `backchannel: { advertise: { codec, payloadType, clockRate, channels } }`. `backchannel: true` still advertises the upstream's own format.
- **`RtspServerSink` `audioTranscode` replaced by `transcode`**: `transcode: { audio: { codec, sampleRate, channels, bitRate } }`. Video can be re-encoded too, and an audio track that already matches is now copied instead of re-encoded (set `force: true` for the old behavior), see below.
- **Types**: `BackchannelAdvertise` is now `BackchannelFormat`. `AudioTranscodeTarget` is now `AudioTranscodeOptions`. `ForwardAudioTranscoder` was removed, `RtspServerSink` handles re-encoding itself.
- **Transcoders are synchronous.** `BackchannelTranscoder.start()`, `BackchannelTranscoder.close()`, `RawAudioTranscoder.start()` and `RawAudioTranscoder.close()` return `void` and throw instead of rejecting. Code like `await transcoder.start()` keeps working, but `transcoder.close().catch(...)` and `transcoder.start().then(...)` must drop the promise handling.
- **`AvSource` `timeout` is in milliseconds** (was microseconds), consistent with every other option.
- **`AvReconnectOptions`**: `delayMs` is now `delay`, `maxDelayMs` is now `maxDelay`.
- **Imports**: the transcoders moved to the new `@seydx/rtsp/transcode` entry point (still exported from the root). `@seydx/rtsp/sinks` no longer exports `BackchannelTranscoder`, and `RawAudioTranscoder` is no longer under `sources`.
- **Requirements**: Node.js 24 or newer, `node-av` `^6.2.0-beta.32` as peer dependency. `get-port` is no longer a dependency.

### Added

- `TranscodeSink`: re-encodes tracks on their way into any sink, for example an MJPEG camera recorded as H.264 through an `FfmpegSink`. `RtspServerSink` `transcode` uses it, so both share the same options.
- Video re-encoding to H.264 or HEVC, for example an MJPEG camera, with options for bit rate, GOP size and output size (`width` or `height` alone keeps the aspect ratio).
- Hardware acceleration for the whole video path: one device decodes, scales and encodes, and each stage falls back to software on its own when the device cannot handle it. `transcode.hardware` defaults to the best device, detected once and shared by every transcoder of the process; `false`, `HardwareOptions` or an own `HardwareContext` are accepted too. New `HardwareSetting` type, and `HardwareContext` and `HardwareOptions` are re-exported as types.
- Tracks that already have the requested format are copied instead of re-encoded, unless `force` is set. Low delay AAC never counts as a match.
- `transcode.video` and `transcode.audio` accept a function that decides per track.
- Video encoders get the source frame rate, measured over about the first half second when the source reports none (MJPEG over HTTP), while the timestamps keep their fine clock. Frames that piled up while a live input was probed or its sinks started are skipped, they arrive at whatever pace they are read, and a camera that delivers its frames in groups is measured over whole groups within about 1.5 seconds. Gives a correct H.264 level, working hardware rate control and a keyframe per second by default.
- A hardware decoder that gets stuck mid-stream is replaced by a software decoder at the last keyframe.
- `AvSource` and `MultiSource` `wallclock` option: stamp packets with their arrival time on a 90 kHz clock, for inputs without usable timestamps such as MJPEG over HTTP. Audio keeps its exact sample timeline while it stays close to the wall clock.
- `AvSource` accepts a `Readable` input, like `MultiSource` already did.
- `RtspServerSink` events `backchannel:start` and `backchannel:stop` (after `backchannel.idleTimeout`, default 2s), and a `backchannelFormat` getter.
- `RtspServerSink` forwards viewer talkback to a source that supports it, unchanged when the formats match (with the payload type rewritten if needed) and transcoded otherwise.
- RTSP server: real `RTP-Info` on PLAY, PAUSE support, `404` for unknown paths and tracks, `461` for non-TCP transports, Digest `stale=TRUE` for expired nonces, TCP keepalive, and viewers are disconnected when the upstream ends so they reconnect at once.
- `RtspAuthResult` type: `verify()` now returns `'ok' | 'stale' | 'denied'`.
- `@seydx/rtsp/transcode` entry point.

### Changed

- Talkback transcoding and raw audio transcoding run synchronously in-process. The localhost UDP loopback, the synthetic SDP and the `get-port` dependency are gone, which also removes the port collisions between concurrent transcoders that 1.0.5 worked around.
- `RtspServerSink` packetizes every track once, whatever the number of viewers, and frames interleaved packets once per channel.
- `MultiSource` reads its inputs concurrently with a bounded queue, fails as a whole when one input fails, and stops its readers when the consumer leaves early.
- `AvSource` reconnects with exponential backoff, checks that a reopened input still has the same stream layout, and restarts a loop after a pass that ended in a read error (mpjpeg reports the end of a file that way).
- `RawAudioTranscoder.close()` flushes the audio the encoder still holds.
- `installNativeLogging` also drops the harmless swscale warning about full-range pixel formats that every MJPEG source triggers, the per-frame notes about a single quantization table from the RTP JPEG packetizer and depacketizer, and the CUDA probe errors of the hardware detection on machines without an NVIDIA driver.
- Documentation rewritten in the style of node-av.

### Fixed

- `relay.pipe()` during a running `stop()` attached to the stopping stream and never started; it now starts a fresh stream once the stop finished. Concurrent `stop()` calls share one teardown.
- A source whose `open()` finished after `stop()` was left open; it is closed now.
- The stall watchdog uses a monotonic clock, so system clock changes no longer trigger or hide stalls.
- A DESCRIBE racing a stream close could wait forever for an SDP that was never published.
- A session that closed while its DESCRIBE was pending stayed referenced until the stream ended.
- Credentials in `AvSource` URLs are masked in log output.
- `TrackInfo.native` stays valid until the source closes. A looping or reconnecting `AvSource` used to free the streams sinks were initialized with.

## [1.0.5] - 2026-07-12

### Added

- `Relay` `stallTimeout` option: a silent-stall watchdog for wedged live sources. A camera whose session "starts" but never sends a frame — or a network link that freezes mid-stream — delivers no packet, no end-of-stream, and no error, so the pump loop would wait forever and every consumer sees a dead stream. With a positive `stallTimeout` the relay watches the gap since the last packet; if it exceeds the timeout it aborts the pull, emits `error`, and stops, so a consumer (or reconnecting client) can restart it and force a fresh upstream session. Reset by every packet, so a healthy stream never trips it; measured only while running. Defaults to `0` (disabled).

### Changed

- On a per-sink queue overflow, `SinkChannel` now skips forward to the newest keyframe already buffered instead of always dropping the whole backlog and re-gating on the next arriving keyframe. When an upstream burst (e.g. a stalled camera flushing several seconds of frames at once) fills the queue, the consumer resumes at a clean GOP with no output gap rather than stalling until the next IDR arrives. Only when the kept tail would not relieve the pressure does it fall back to the full flush. The overflow warning now also reports the queue depth and the time since the last successful write, to distinguish a genuine slow consumer from a source-side burst.

### Fixed

- `RawAudioTranscoder` and `BackchannelTranscoder` could fail to start when two of them (or two processes) opened their synthetic RTP input at the same time: `get-port`'s default scan starts at the same low port in every process, so the picked "free" UDP port correlated and `openSDP`'s bind clashed. They now seed `get-port` with a random preferred port to decorrelate concurrent openers, and `RawAudioTranscoder` retries on a fresh port if the bind still clashes.

## [1.0.4] - 2026-07-11

### Added

- `RawAudioTranscoder`: normalizes raw framed elementary audio — bare coded frames with no container, one buffer per frame — into a demuxable stream (AAC-LC/ADTS by default) that plugs straight into an `AvSource`/`MultiSource` input. Supports an explicit decoder implementation (`from.decoder`) and an out-of-band codec config announced via a synthetic SDP. The motivating case is a device that delivers raw AAC-ELD, which cannot be expressed in ADTS at all (audio object type 39 does not fit the 2-bit ADTS profile field), so feeding it to the plain `aac` demuxer produced only decoder garbage; ELD additionally decodes only via `libfdk_aac`.
- `buildAacEldConfig(sampleRate, channels, frameLength)`: builds the hex AudioSpecificConfig for raw AAC-ELD (e.g. `f8f03000` for 16 kHz mono, 480-sample frames) for use as `RawAudioTranscoder`'s codec config.

### Fixed

- `BackchannelTranscoder` now passes the resolved `from.codec` to the decoder it creates, so the option really selects the decoder *implementation* (e.g. `libfdk_aac`) instead of only influencing the generated SDP.

## [1.0.3] - 2026-07-10

### Changed

- `RtspServerSink` no longer detaches from the relay the instant the last client disconnects: it now lingers for a grace period (new `detachDelay` option, default 5s) so a quickly retrying client — the normal pattern of pulling clients that reconnect after a read timeout — finds the muxers and SDP still warm and gets its DESCRIBE answered immediately instead of restarting the whole upstream warm-up from zero. The relay's `idleTimeout` starts counting only once the sink actually detaches. Set `detachDelay: 0` for the previous immediate-detach behavior.

### Fixed

- A DESCRIBE racing the detach triggered by the last client leaving could be handed the SDP promise the in-flight teardown was about to reject (or a stale pre-teardown SDP of a sink closing under it). `activate()` now waits out an in-flight detach and re-attaches with fresh state.
- Sessions whose socket already died no longer log a `DESCRIBE failed — upstream unavailable` warning when a later teardown rejects the SDP they were waiting on; one real failure no longer produces a warn burst per zombie DESCRIBE.

## [1.0.2] - 2026-07-10

### Fixed

- Audio transcoding (`audioTranscode`) died silently at the first `loop`/`reconnect` reopen on Linux: node-av's `Decoder` compared each packet against the *live* stream index of the demuxer it was created from — freed memory once that demuxer was closed — and dropped every subsequent packet without an error. Fixed upstream in node-av 6.2.0-beta.5 (stream index snapshotted at decoder creation); the dependency is bumped accordingly. macOS was unaffected only by allocator luck.
- Test suite: run vitest with the `forks` pool instead of `threads`. node-av's async completions can be lost inside `worker_threads`, stalling the worker's event loop mid-test, and a test-timeout `worker.terminate()` during an in-flight native call aborted the whole process (`SIGABRT` / exit 134 on CI). Process isolation removes both failure modes; library code is unaffected.
- `AvSource` now keeps packet timestamps continuous across `loop` and `reconnect` reopens: each pass is shifted to continue exactly where the previous one ended, instead of restarting at the input's own clock (zero for looped files). Previously, any consumer spanning a loop boundary — an RTSP viewer, a recording muxer, the audio transcoder — received a non-monotonic stream (cycling DTS, stalled players, `Non-monotonic DTS` floods in pulling ffmpeg clients).

## [1.0.1] - 2026-07-10

### Added

- `RtspServerSink` `sdpTimeout` option (default 10s): tracks that produce no RTP header within the deadline are excluded from the DESCRIBE SDP so the remaining tracks can be served; if no track produces a header at all, pending DESCRIBEs fail with `503 Service Unavailable` instead of hanging. Surviving tracks keep their original SDP streamids. Set `0` to disable.

### Changed

- `ForwardAudioTranscoder.write()` now returns the number of packets actually muxed (previously `void`). Existing callers that ignore the result are unaffected.

### Fixed

- SDP generation no longer completes while a transcoded or bitstream-filtered track is still buffering: the track's pending header is only cleared once a packet was actually muxed, so the DESCRIBE SDP can no longer carry unresolved codec parameters (e.g. an `m=application RTP/AVP 3` line) that made clients fail SETUP.

## [1.0.0] - 2026-07-09

### Breaking Changes

- `MultiSource` now fails fast: when one input dies mid-stream, the remaining inputs are aborted and the error surfaces immediately (previously the source kept running without the failed input and only reported the error once every input had ended).
- `RtspServerSink` no longer serves `data` tracks or tracks without a native stream handle; they are skipped with a log message. `init()` throws if the upstream carries no RTP-servable (video/audio) track at all.
- Digest authentication issues a fresh, time-limited nonce per challenge (5-minute TTL) instead of one static nonce per server lifetime. Standards-compliant clients (ffmpeg, VLC, cameras) are unaffected; captured `Authorization` headers can no longer be replayed indefinitely.
- A DESCRIBE for an upstream that fails to start now receives `503 Service Unavailable` instead of hanging until the client times out.

### Changed

- `Relay.stop()` is now safe to call while a start is in flight: the pending open is aborted and awaited, the relay can never transition to `running` afterwards, and a deliberate stop no longer emits `error`.
- Emitting `error` on `Relay` (or any library emitter) without a registered listener no longer throws — a missing error listener cannot crash the process anymore.
- `MediaPacket.pts`/`dts` are now populated for AV-backed packets (`AV_NOPTS_VALUE` maps to `undefined`); previously they were always `undefined`.
- The RTSP session serializes request handling, so pipelined requests are answered strictly in request order.
- `ForwardAudioTranscoder` tolerates corrupt audio: undecodable packets and failing frames are dropped with a warning instead of tearing down the whole RTSP server sink.
- The relay tears down to idle when every attached sink dies during startup, instead of pumping the upstream with no consumers.

### Added

- `AvSource` `reconnect` option (`true` or `AvReconnectOptions { delayMs, maxDelayMs, maxRetries }`): reopens the input with exponential backoff after read failures and unexpected end-of-stream, so a camera reboot or network blip no longer ends the relay.
- `Relay` `sink:error` event carrying the failing sink and its error whenever a sink fails to initialize or write, complementing the existing `sink:removed`.
- `BackchannelTranscoder` `onError` callback; the relay uses it to discard a failed talkback pipeline and rebuild it on the next inbound packet instead of pushing into a dead pipeline forever.
- RTSP server hardening: per-viewer socket backpressure (slow viewers exceeding 8 MiB of buffered media are dropped), request parser size limits (16 KiB head / 64 KiB body), an idle reaper for non-playing sessions, and a persistent TCP server error handler.

### Fixed

- Process crash via unhandled rejection when `autoStart` was set and the source failed to open, or when a sink's `init()` threw after `pipe()`.
- Use-after-free risk in `BackchannelTranscoder.close()`: the blocked demuxer read is now interrupted and the background loop awaited before any native stage is freed.
- Native resource leak when `BackchannelTranscoder.start()` failed partway through building its pipeline.
- Abort-listener leak in `MultiSource.packets()` that grew unbounded on the long-lived relay signal.
- Hanging DESCRIBE: the pending SDP promise is now rejected when the sink is torn down before the SDP resolves (failed upstream start, reconnect race).
- `AvSource.close()` no longer waits out a pending reconnect/pacing delay; teardown aborts those waits immediately.
- Slow-viewer memory growth: media written to a stalled RTSP client is bounded by the new backpressure limit instead of buffering without limit.

## [0.0.1] - 2026-06-17

- Initial release