# Examples

Runnable examples for [`@seydx/rtsp`](https://github.com/seydx/rtsp). Each file imports from the package source under `../src`, so they double as living documentation of the public API. Run any example with [`tsx`](https://github.com/privatenumber/tsx):

```bash
tsx examples/<file>.ts
```

Most examples take an input URL as the first argument and fall back to a placeholder when none is given. The header of each file lists its usage and optional arguments.

| Example | Description |
| --- | --- |
| [basic-relay.ts](https://github.com/seydx/rtsp/tree/main/examples/basic-relay.ts) | Pull one RTSP camera and serve it again as a local RTSP endpoint, connecting to the camera only while someone watches. |
| [serve-rtsp.ts](https://github.com/seydx/rtsp/tree/main/examples/serve-rtsp.ts) | Fan one upstream out to many RTSP viewers with reconnect, stall detection, optional auth and lifecycle logging. Optional `[port] [path]`. |
| [mjpeg-to-h264.ts](https://github.com/seydx/rtsp/tree/main/examples/mjpeg-to-h264.ts) | Serve an MJPEG camera as H.264 over RTSP, re-encoded with hardware acceleration when available. Optional `[port] [path]`. |
| [transcode-sink.ts](https://github.com/seydx/rtsp/tree/main/examples/transcode-sink.ts) | Record a camera as scaled H.264 with AAC, decoded, scaled and encoded on the GPU when available. Optional `[output] [height] [--software]`. |
| [ffmpeg-sink.ts](https://github.com/seydx/rtsp/tree/main/examples/ffmpeg-sink.ts) | Record a relayed source into a container file without re-encoding. Optional `[output] [format]`. |
| [callback-sink.ts](https://github.com/seydx/rtsp/tree/main/examples/callback-sink.ts) | Observe the keyframe-gated packet flow of a source in a callback. |
| [backchannel-passthrough.ts](https://github.com/seydx/rtsp/tree/main/examples/backchannel-passthrough.ts) | Two-way audio relay that advertises the camera's own talkback codec and forwards viewer audio unchanged. |
| [backchannel-transcode.ts](https://github.com/seydx/rtsp/tree/main/examples/backchannel-transcode.ts) | Two-way audio relay that advertises PCMA to viewers and converts their talkback to the camera's codec. Optional `[port] [path]`. |
| [multi-source.ts](https://github.com/seydx/rtsp/tree/main/examples/multi-source.ts) | Merge separate video and audio inputs into one RTSP stream. Optional `[audio_url]`. |
| [raw-audio.ts](https://github.com/seydx/rtsp/tree/main/examples/raw-audio.ts) | Turn bare audio frames into an AAC stream and serve it next to a camera's video. |
