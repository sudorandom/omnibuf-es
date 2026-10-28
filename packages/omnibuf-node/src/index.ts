import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Transform, type Readable, type Writable } from 'node:stream';
import {
  DescriptorRegistry,
  fastDecodeShortASCII,
  parseBinaryFileDescriptorSet,
  setStringCodec,
  type FileDescriptorSetJSON,
  type StringCodec,
} from '@omnibuf/core';

export * from '@omnibuf/core';
export * from './conformance.js';
export * from './gen/peer_omnibuf.pb.js';
export {
  type AllTypesSubMsg,
  type TestAllTypes,
  OpaqueAllTypesSubMsg,
  OpaqueTestAllTypes,
  createAllTypesSubMsg,
  createTestAllTypes,
  decodeAllTypesSubMsg,
  decodeTestAllTypes,
  encodeAllTypesSubMsg,
  encodeTestAllTypes,
  marshalAllTypesSubMsgOmniBuf,
  unmarshalAllTypesSubMsgOmniBuf,
  marshalTestAllTypesOmniBuf,
  unmarshalTestAllTypesOmniBuf,
} from './gen/conformance_omnibuf.pb.js';

/**
 * Node.js-optimized `StringCodec` backed by `Buffer.from(str, 'utf8')`, `Buffer.byteLength`,
 * `Buffer.write`, and `Buffer.toString('utf8')`.
 */
export const NodeBufferStringCodec: StringCodec = {
  encode(str: string): Uint8Array {
    if (str.length === 0) return new Uint8Array(0);
    const b = Buffer.from(str, 'utf8');
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  },
  decode(bytes: Uint8Array, start = 0, end = bytes.length): string {
    if (end <= start) return '';
    const ascii = fastDecodeShortASCII(bytes, start, end);
    if (ascii !== null) return ascii;
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start);
    return buf.toString('utf8');
  },
  byteLength(str: string): number {
    return Buffer.byteLength(str, 'utf8');
  },
  encodeInto(str: string, dst: Uint8Array, offset: number): number {
    const buf = Buffer.from(dst.buffer, dst.byteOffset + offset, dst.byteLength - offset);
    return buf.write(str, 0, buf.length, 'utf8');
  },
};

// Automatically install NodeBufferStringCodec when @omnibuf/node is imported
setStringCodec(NodeBufferStringCodec);

/**
 * Encode an OmniBuf packet into a 4-byte little-endian length-prefixed `Buffer` frame.
 */
export function encodeFrame(packet: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(4 + packet.byteLength);
  frame.writeUInt32LE(packet.byteLength >>> 0, 0);
  frame.set(packet, 4);
  return frame;
}

/**
 * Linear-time chunk queue for length-prefixed frame decoding without quadratic Buffer.concat copying.
 */
class FrameBufferQueue {
  private chunks: Uint8Array[] = [];
  private headIndex = 0;
  private headOffset = 0;
  public totalBytes = 0;
  public pendingFrameLen: number | null = null;

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.totalBytes += chunk.byteLength;
  }

  peekUInt32LE(): number {
    const first = this.chunks[this.headIndex]!;
    if (first.byteLength - this.headOffset >= 4) {
      const o = this.headOffset;
      return (
        (first[o]! | (first[o + 1]! << 8) | (first[o + 2]! << 16) | (first[o + 3]! << 24)) >>> 0
      );
    }
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let idx = this.headIndex;
    let off = this.headOffset;
    for (let i = 0; i < 4; i++) {
      let c = this.chunks[idx]!;
      while (off >= c.byteLength) {
        idx++;
        off = 0;
        c = this.chunks[idx]!;
      }
      const byte = c[off++]!;
      if (i === 0) b0 = byte;
      else if (i === 1) b1 = byte;
      else if (i === 2) b2 = byte;
      else b3 = byte;
    }
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }

  consume(len: number, dst?: Uint8Array): void {
    let remaining = len;
    let dstOffset = 0;
    while (remaining > 0) {
      const chunk = this.chunks[this.headIndex]!;
      const avail = chunk.byteLength - this.headOffset;
      const take = remaining < avail ? remaining : avail;
      if (dst) {
        dst.set(chunk.subarray(this.headOffset, this.headOffset + take), dstOffset);
        dstOffset += take;
      }
      this.headOffset += take;
      this.totalBytes -= take;
      remaining -= take;
      if (this.headOffset === chunk.byteLength) {
        this.headIndex++;
        this.headOffset = 0;
      }
    }
    if (this.headIndex === this.chunks.length) {
      this.chunks.length = 0;
      this.headIndex = 0;
    } else if (this.headIndex > 1024 && this.headIndex * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.headIndex);
      this.headIndex = 0;
    }
  }

  get trailingBytes(): number {
    return (this.pendingFrameLen !== null ? 4 : 0) + this.totalBytes;
  }
}

/**
 * Write a 4-byte little-endian length-prefixed frame to a Node.js `Writable` stream.
 */
export function writeFrame(stream: Writable, packet: Uint8Array): Promise<void> {
  const frame = encodeFrame(packet);
  return new Promise<void>((resolve, reject) => {
    let writeDone = false;
    let drainDone = false;
    let settled = false;

    const cleanup = () => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const maybeResolve = () => {
      if (settled || !writeDone || !drainDone) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onDrain = () => {
      drainDone = true;
      maybeResolve();
    };

    stream.once('error', onError);

    const ok = stream.write(frame, (err) => {
      if (err) {
        if (!settled) {
          settled = true;
          stream.removeListener('drain', onDrain);
          setImmediate(() => stream.removeListener('error', onError));
          reject(err);
        }
        return;
      }
      writeDone = true;
      maybeResolve();
    });

    if (ok) {
      drainDone = true;
      maybeResolve();
    } else {
      stream.once('drain', onDrain);
    }
  });
}

/**
 * Async generator yielding complete length-prefixed `Uint8Array` frames from a Node.js `Readable` stream.
 */
export async function* readFrames(
  stream: Readable,
  options?: { maxFrameBytes?: number },
): AsyncGenerator<Uint8Array, void, unknown> {
  const maxFrameBytes = options?.maxFrameBytes ?? 16 * 1024 * 1024;
  const queue = new FrameBufferQueue();

  for await (const chunk of stream) {
    const bufChunk =
      chunk instanceof Uint8Array ? chunk : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    queue.push(bufChunk);

    while (true) {
      if (queue.pendingFrameLen === null) {
        if (queue.totalBytes < 4) break;
        const frameLen = queue.peekUInt32LE();
        if (frameLen > maxFrameBytes) {
          throw new Error(
            `omnibuf/node: frame length ${frameLen} exceeds maxFrameBytes ${maxFrameBytes}`,
          );
        }
        queue.consume(4);
        queue.pendingFrameLen = frameLen;
      }
      if (queue.totalBytes < queue.pendingFrameLen) {
        break;
      }
      const frameLen = queue.pendingFrameLen;
      queue.pendingFrameLen = null;
      const copy = new Uint8Array(frameLen);
      queue.consume(frameLen, copy);
      yield copy;
    }
  }

  if (queue.trailingBytes > 0) {
    throw new Error(`omnibuf/node: truncated frame at EOF (${queue.trailingBytes} trailing bytes)`);
  }
}

/**
 * Create a Node.js `Transform` stream that wraps incoming `Uint8Array`/`Buffer` packets
 * with a 4-byte little-endian `uint32` length prefix.
 */
export function createFrameEncoderStream(): Transform {
  return new Transform({
    writableObjectMode: true,
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      callback(null, encodeFrame(chunk));
    },
  });
}

/**
 * Create a Node.js `Transform` stream that deframes 4-byte little-endian length-prefixed chunks
 * into complete OmniBuf packet `Buffer`s.
 * Uses `readableObjectMode: true` so zero-length packets are preserved and each read yields one packet.
 */
export function createFrameDecoderStream(options?: { maxFrameBytes?: number }): Transform {
  const maxFrameBytes = options?.maxFrameBytes ?? 16 * 1024 * 1024;
  const queue = new FrameBufferQueue();

  return new Transform({
    readableObjectMode: true,
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      queue.push(bufChunk);

      while (true) {
        if (queue.pendingFrameLen === null) {
          if (queue.totalBytes < 4) break;
          const frameLen = queue.peekUInt32LE();
          if (frameLen > maxFrameBytes) {
            callback(
              new Error(
                `omnibuf/node: frame length ${frameLen} exceeds maxFrameBytes ${maxFrameBytes}`,
              ),
            );
            return;
          }
          queue.consume(4);
          queue.pendingFrameLen = frameLen;
        }
        if (queue.totalBytes < queue.pendingFrameLen) {
          break;
        }
        const frameLen = queue.pendingFrameLen;
        queue.pendingFrameLen = null;
        const packet = frameLen === 0 ? Buffer.alloc(0) : Buffer.allocUnsafe(frameLen);
        queue.consume(frameLen, packet);
        this.push(packet);
      }

      callback();
    },
    flush(callback) {
      if (queue.trailingBytes > 0) {
        callback(
          new Error(`omnibuf/node: truncated frame at EOF (${queue.trailingBytes} trailing bytes)`),
        );
        return;
      }
      callback();
    },
  });
}

/**
 * Read an OmniBuf packet from disk (supporting `.obuf` raw binary and `.hex` hex-encoded files).
 */
export async function readPacketFile(filePath: string): Promise<Uint8Array> {
  if (filePath.endsWith('.hex')) {
    const text = await readFile(filePath, 'utf8');
    const clean = text.replace(/\s+/g, '');
    return new Uint8Array(Buffer.from(clean, 'hex'));
  }
  const buf = await readFile(filePath);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Synchronously read an OmniBuf packet from disk (supporting `.obuf` raw binary and `.hex` hex-encoded files).
 */
export function readPacketFileSync(filePath: string): Uint8Array {
  if (filePath.endsWith('.hex')) {
    const text = readFileSync(filePath, 'utf8');
    const clean = text.replace(/\s+/g, '');
    return new Uint8Array(Buffer.from(clean, 'hex'));
  }
  const buf = readFileSync(filePath);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Write an OmniBuf packet to disk.
 */
export async function writePacketFile(filePath: string, packet: Uint8Array): Promise<void> {
  await writeFile(filePath, packet);
}

/**
 * Synchronously write an OmniBuf packet to disk.
 */
export function writePacketFileSync(filePath: string, packet: Uint8Array): void {
  writeFileSync(filePath, packet);
}

/**
 * Load a `FileDescriptorSet` from `.fds.json`, `.fds.pb`, or `.fds.pb.gz` and return a `DescriptorRegistry`.
 */
export function loadDescriptorRegistrySync(filePath: string): DescriptorRegistry {
  if (filePath.endsWith('.json')) {
    const text = readFileSync(filePath, 'utf8');
    const fds = JSON.parse(text) as FileDescriptorSetJSON;
    return new DescriptorRegistry(fds);
  }
  let raw = readFileSync(filePath);
  if (filePath.endsWith('.gz') || (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b)) {
    raw = gunzipSync(raw);
  }
  const fds = parseBinaryFileDescriptorSet(
    new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
  );
  return new DescriptorRegistry(fds);
}
