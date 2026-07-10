# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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