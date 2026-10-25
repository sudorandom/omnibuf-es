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
 * Write a 4-byte little-endian length-prefixed frame to a Node.js `Writable` stream.
 */
export function writeFrame(stream: Writable, packet: Uint8Array): Promise<void> {
  const frame = encodeFrame(packet);
  return new Promise<void>((resolve, reject) => {
    const ok = stream.write(frame, (err) => {
      if (err) reject(err);
    });
    if (ok) {
      resolve();
    } else {
      stream.once('drain', resolve);
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
  let buffer: Buffer = Buffer.alloc(0);

  for await (const chunk of stream) {
    const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = buffer.length === 0 ? bufChunk : Buffer.concat([buffer, bufChunk]);

    let offset = 0;
    while (buffer.length - offset >= 4) {
      const frameLen = buffer.readUInt32LE(offset);
      if (frameLen > maxFrameBytes) {
        throw new Error(
          `omnibuf/node: frame length ${frameLen} exceeds maxFrameBytes ${maxFrameBytes}`,
        );
      }
      if (buffer.length - offset - 4 < frameLen) {
        break;
      }
      const slice = buffer.subarray(offset + 4, offset + 4 + frameLen);
      const copy = new Uint8Array(slice.length);
      copy.set(slice);
      yield copy;
      offset += 4 + frameLen;
    }

    if (offset > 0) {
      buffer = buffer.subarray(offset);
    }
  }

  if (buffer.length > 0) {
    throw new Error(`omnibuf/node: truncated frame at EOF (${buffer.length} trailing bytes)`);
  }
}

/**
 * Create a Node.js `Transform` stream that wraps incoming `Uint8Array`/`Buffer` packets
 * with a 4-byte little-endian `uint32` length prefix.
 */
export function createFrameEncoderStream(): Transform {
  return new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      callback(null, encodeFrame(chunk));
    },
  });
}

/**
 * Create a Node.js `Transform` stream that deframes 4-byte little-endian length-prefixed chunks
 * into complete OmniBuf packet `Buffer`s.
 */
export function createFrameDecoderStream(options?: { maxFrameBytes?: number }): Transform {
  const maxFrameBytes = options?.maxFrameBytes ?? 16 * 1024 * 1024;
  let buffer: Buffer = Buffer.alloc(0);

  return new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = buffer.length === 0 ? bufChunk : Buffer.concat([buffer, bufChunk]);

      let offset = 0;
      while (buffer.length - offset >= 4) {
        const frameLen = buffer.readUInt32LE(offset);
        if (frameLen > maxFrameBytes) {
          callback(
            new Error(
              `omnibuf/node: frame length ${frameLen} exceeds maxFrameBytes ${maxFrameBytes}`,
            ),
          );
          return;
        }
        if (buffer.length - offset - 4 < frameLen) {
          break;
        }
        const packet = Buffer.from(buffer.subarray(offset + 4, offset + 4 + frameLen));
        this.push(packet);
        offset += 4 + frameLen;
      }

      if (offset > 0) {
        buffer = buffer.subarray(offset);
      }
      callback();
    },
    flush(callback) {
      if (buffer.length > 0) {
        callback(
          new Error(`omnibuf/node: truncated frame at EOF (${buffer.length} trailing bytes)`),
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
