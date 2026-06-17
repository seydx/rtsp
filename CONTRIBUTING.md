# Contributing

## Setup

```bash
git clone https://github.com/YOUR_USERNAME/rtsp.git
cd rtsp
npm install
npm run build
```

**Requirements:** Node.js 22+.

All codec, demuxing and muxing work is delegated to [node-av](https://github.com/seydx/node-av), which ships prebuilt FFmpeg binaries — there is no native build step in this project.

## Development

```bash
npm run build               # Clean + bundle (Vite) + emit type declarations
npm run type-check          # Type-check the library
npm run type-check:examples # Type-check the examples against the source
npm run test                # Run the test suite (Vitest)
npm run test:watch          # Watch mode
npm run lint                # ESLint (type-checked + JSDoc rules)
npm run lint:fix            # ESLint with auto-fix
npm run format              # Prettier
npm run docs:dev            # Build and serve the documentation site locally
```

## Architecture

The design is small: one orchestrator and two open contracts.

- `src/relay.ts` — `Relay` holds one `Source` and fans its packets out to many `Sink`s.
- `src/types.ts` — the `Source` / `Sink` / `MediaPacket` contracts.
- `src/sources/` — `AvSource`, `MultiSource`.
- `src/sinks/` — `CallbackSink`, `FfmpegSink`, and `rtsp-server/` (the multi-client RTSP server).

A packet is owned by exactly one holder; the relay frees each packet after `write()` resolves, so a sink must not retain a packet past the returned promise.

## Pull Requests

1. Create a branch from `main`.
2. Make your changes and add tests for any new feature or bugfix.
3. Verify: `npm run lint && npm run type-check && npm run type-check:examples && npm run test`.
4. Open a PR with a clear description of what changed and why.

## Conventions

- ESM with `.js` extensions in imports.
- Prettier: 2-space indent, single quotes, semicolons, max line length 170.
- Tests live next to the code in `__tests__/` directories and run on Vitest.
- JSDoc on every public class, method, and interface property; cross-link related types with `@see {@link ...}`.
- Class member order: properties, constructor, getters, public methods, private methods.
- Mark internal-only API with `@internal`.
- Inline comments explain why, not what — no decorative section dividers.
- The documentation must build clean: `npm run docs:build` ends with `Found 0 errors and 0 warnings`.
