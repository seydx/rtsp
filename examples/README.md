# Examples

A set of runnable examples for [`@seydx/rtsp`](https://github.com/seydx/rtsp). Each file imports directly from the package source under `../src/...`, so they double as living documentation of the public API. Run any example with [`tsx`](https://github.com/privatenumber/tsx):

```bash
tsx examples/<file>.ts
```

Most examples take a camera `rtsp://` URL as the first argument and fall back to a placeholder when none is given (check each file's header for the exact usage and extra optional arguments).

| Example | Description |
| --- | --- |
| [basic-relay.ts](https://github.com/seydx/rtsp/tree/main/examples/basic-relay.ts) | Pull a single RTSP camera and re-serve it as a local RTSP endpoint, opening the upstream lazily on the first viewer. Takes a camera `rtsp://` URL as the first argument. |
| [serve-rtsp.ts](https://github.com/seydx/rtsp/tree/main/examples/serve-rtsp.ts) | Fan one upstream out to many `rtsp://` pullers from a single camera connection. Takes a camera `rtsp://` URL as the first argument (optional `[port] [path]`). |
| [ffmpeg-sink.ts](https://github.com/seydx/rtsp/tree/main/examples/ffmpeg-sink.ts) | Record a relayed source to a container file with `FfmpegSink`, remuxing (copying) streams losslessly. Takes a camera `rtsp://` URL as the first argument (optional `[output] [format]`). |
| [callback-sink.ts](https://github.com/seydx/rtsp/tree/main/examples/callback-sink.ts) | Observe the raw, keyframe-gated packet flow of a source with `CallbackSink`. Takes a camera `rtsp://` URL as the first argument. |
| [backchannel-passthrough.ts](https://github.com/seydx/rtsp/tree/main/examples/backchannel-passthrough.ts) | Two-way audio relay that advertises the camera's own ONVIF talkback codec, forwarding viewer RTP unchanged. Takes a camera `rtsp://` URL as the first argument. |
| [backchannel-transcode.ts](https://github.com/seydx/rtsp/tree/main/examples/backchannel-transcode.ts) | Two-way audio relay that advertises Opus to viewers and transcodes their talkback into the camera's native backchannel codec. Takes a camera `rtsp://` URL as the first argument (optional `[port] [path]`). |
| [multi-source.ts](https://github.com/seydx/rtsp/tree/main/examples/multi-source.ts) | Merge separate video and audio elementary streams into one relay with `MultiSource`, then re-serve them as a single RTSP endpoint. Takes a video `rtsp://` URL as the first argument (optional `[audio_url]`). |
