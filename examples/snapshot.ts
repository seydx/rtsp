/**
 * Snapshot
 *
 * Saves the next frame of an MJPEG camera as a JPEG file. The frame comes from
 * the relay's shared upstream, so the same camera connection can serve RTSP
 * viewers at the same time. MJPEG frames are complete JPEG images and are
 * written as they arrive, without re-encoding.
 *
 * Usage: tsx examples/snapshot.ts <mjpeg_url> [output]
 *
 * Examples:
 *   tsx examples/snapshot.ts http://camera.local/video.mjpg
 *   tsx examples/snapshot.ts http://camera.local/mjpeg garden.jpg
 */

import { writeFile } from 'node:fs/promises';

import { AvSource, grabFrame, Relay } from '../src/index.js';

const input = process.argv[2] ?? 'http://camera.local/video.mjpg';
const output = process.argv[3] ?? 'snapshot.jpg';

const relay = new Relay({ source: new AvSource(input, { format: 'mpjpeg', wallclock: true }), logger: console });

const jpeg = await grabFrame(relay, { timeout: 10_000 });
await writeFile(output, jpeg);
console.log(`saved ${jpeg.length} bytes to ${output}`);

await relay.stop();
