import { Demuxer, Muxer } from 'node-av/api';
import { ffmpegPath, isFfmpegAvailable } from 'node-av/ffmpeg';
import { avGetCodecName } from 'node-av/lib';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isRtcp } from '../../util/rtp.js';

import type { Socket } from 'node:net';

export const hasFfmpeg = isFfmpegAvailable();

/**
 * Run ffmpeg with a hard deadline and reject with its stderr tail.
 *
 * execFile's timeout sends SIGTERM, which ffmpeg ignores while blocked on a
 * stalled socket read, so a broken stream would hang the test without any
 * diagnostics.
 */
export function runFfmpeg(args: string[], timeoutMs = 25_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${signal ?? code}, stderr tail:\n${stderr.slice(-4000)}`));
    });
  });
}

const VIDEO = ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15'];
const AUDIO = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
const X264 = ['-c:v', 'libx264', '-g', '15', '-pix_fmt', 'yuv420p'];

const CLIPS = {
  // h264 + aac in mp4
  av: { file: 'av.mp4', args: (t: string) => [...VIDEO, ...AUDIO, '-t', t, ...X264, '-c:a', 'aac', '-shortest'] },
  // h264 only in mp4
  video: { file: 'video.mp4', args: (t: string) => [...VIDEO, '-t', t, ...X264] },
  // raw annex-b h264 without container timing
  h264: { file: 'video.h264', args: (t: string) => [...VIDEO, '-t', t, ...X264, '-bsf:v', 'h264_mp4toannexb', '-f', 'h264'] },
  // raw adts aac
  adts: { file: 'audio.aac', args: (t: string) => [...AUDIO, '-t', t, '-c:a', 'aac', '-f', 'adts'] },
  // multipart jpeg as served by mjpeg cameras
  mjpeg: { file: 'video.mjpeg', args: (t: string) => [...VIDEO, '-t', t, '-c:v', 'mjpeg', '-q:v', '5', '-f', 'mpjpeg'] },
  // mjpeg in a container that ends cleanly, mpjpeg reports its end as an error
  mjpegmkv: { file: 'mjpeg.mkv', args: (t: string) => [...VIDEO, '-t', t, '-c:v', 'mjpeg', '-q:v', '5'] },
  // 8 kHz mono mu-law
  mulaw: { file: 'mulaw.wav', args: (t: string) => ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', t, '-ac', '1', '-c:a', 'pcm_mulaw'] },
  // 16 kHz mono aac with global config, as cameras advertise it over RTP
  aac: { file: 'audio.m4a', args: (t: string) => ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', t, '-ac', '1', '-c:a', 'aac', '-b:a', '32k'] },
  // 48 kHz stereo opus, as browsers send it
  opus: { file: 'audio.ogg', args: (t: string) => ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', t, '-ac', '2', '-c:a', 'libopus', '-b:a', '32k'] },
} as const;

export type ClipKind = keyof typeof CLIPS;

/**
 * Generated media files in a temporary directory, created on first use.
 */
export class Fixtures {
  private readonly clips = new Map<string, Promise<string>>();

  private constructor(readonly dir: string) {}

  static async create(): Promise<Fixtures> {
    return new Fixtures(await mkdtemp(join(tmpdir(), 'seydx-rtsp-')));
  }

  clip(kind: ClipKind, seconds = 2): Promise<string> {
    const key = `${kind}-${seconds}`;
    let pending = this.clips.get(key);
    if (!pending) {
      const path = join(this.dir, `${seconds}s-${CLIPS[kind].file}`);
      pending = runFfmpeg([...CLIPS[kind].args(String(seconds)), path]).then(() => path);
      this.clips.set(key, pending);
    }
    return pending;
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/**
 * Codec type and name of every stream in a file.
 */
export async function probe(file: string): Promise<{ type: number; codec: string | null }[]> {
  const demuxer = await Demuxer.open(file);
  try {
    return demuxer.streams.map((stream) => ({ type: stream.codecpar.codecType, codec: avGetCodecName(stream.codecpar.codecId) }));
  } finally {
    await demuxer.close();
  }
}

/**
 * Packetize the first stream of a file into RTP, without RTCP.
 */
export async function toRtp(file: string, payloadType?: number): Promise<Buffer[]> {
  const demuxer = await Demuxer.open(file);
  const rtp: Buffer[] = [];
  const muxer = await Muxer.open(
    {
      write: (buffer: Buffer) => {
        if (!isRtcp(buffer)) rtp.push(Buffer.from(buffer));
        return buffer.length;
      },
    },
    { format: 'rtp', maxPacketSize: 1200, options: payloadType === undefined ? {} : { payload_type: payloadType } } as never,
  );
  try {
    muxer.addStream(demuxer.streams[0]);
    for await (const packet of demuxer.packets()) {
      if (!packet) continue;
      await muxer.writePacket(packet, 0);
      packet.free();
    }
  } finally {
    await muxer.close();
    await demuxer.close();
  }
  return rtp;
}

/**
 * Build a minimal RTP packet.
 */
export function buildRtp(payloadType: number, sequence: number, timestamp: number, payload: Buffer, ssrc = 0x1234abcd): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = payloadType & 0x7f;
  header.writeUInt16BE(sequence & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

export interface RtspResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * A bare RTSP client over TCP for asserting exact server responses.
 */
export class RtspTestClient {
  frames = 0;
  closed = false;

  private buffer: Buffer = Buffer.alloc(0);
  private cseq = 0;
  private waiting?: (response: RtspResponse) => void;
  private readonly closedPromise: Promise<void>;

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => undefined);
    this.closedPromise = new Promise((resolve) =>
      socket.on('close', () => {
        this.closed = true;
        resolve();
      }),
    );
  }

  static connect(port: number, host = '127.0.0.1'): Promise<RtspTestClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, host, () => {
        socket.off('error', reject);
        resolve(new RtspTestClient(socket));
      });
      socket.once('error', reject);
    });
  }

  request(method: string, uri: string, headers: Record<string, string> = {}): Promise<RtspResponse> {
    const lines = [`${method} ${uri} RTSP/1.0`, `CSeq: ${++this.cseq}`, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)];
    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      void this.closedPromise.then(() => reject(new Error(`connection closed before the ${method} response`)));
      this.socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
  }

  waitClosed(): Promise<void> {
    return this.closedPromise;
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length === 0) return;
      if (this.buffer[0] === 0x24) {
        if (this.buffer.length < 4) return;
        const end = 4 + this.buffer.readUInt16BE(2);
        if (this.buffer.length < end) return;
        this.frames++;
        this.buffer = this.buffer.subarray(end);
        continue;
      }
      const headEnd = this.buffer.indexOf('\r\n\r\n');
      if (headEnd === -1) return;
      const [statusLine, ...lines] = this.buffer.subarray(0, headEnd).toString().split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon !== -1) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const length = Number(headers['content-length'] ?? 0);
      if (this.buffer.length < headEnd + 4 + length) return;
      const body = this.buffer.subarray(headEnd + 4, headEnd + 4 + length).toString();
      this.buffer = this.buffer.subarray(headEnd + 4 + length);
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting?.({ status: Number(statusLine.split(' ')[1]), headers, body });
    }
  }
}

/**
 * Wait until a condition holds or fail after a timeout.
 */
export async function until(condition: () => boolean, timeoutMs = 5000, message = 'condition'): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
