#!/usr/bin/env node
import { parseBinaryFileDescriptorSet } from '@omnibuf/core';
import { generateFileCode } from '../generator.js';

/**
 * Minimal binary decoder/encoder for `google.protobuf.compiler.CodeGeneratorRequest`
 * and `CodeGeneratorResponse` so `protoc-gen-omnibuf-es` works standalone with `protoc` and `buf`.
 */
function readPbVarint(b: Uint8Array, pos: number): [ bigint, number ] {
  let result = 0n;
  let shift = 0n;
  while (pos < b.length) {
    const byte = b[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [ result, pos ];
    shift += 7n;
  }
  throw new Error('protoc-gen-omnibuf-es: unexpected EOF in varint');
}

function writePbVarint(out: number[], val: number): void {
  let v = val >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function writePbStringField(out: number[], fieldNum: number, str: string): void {
  const bytes = new TextEncoder().encode(str);
  writePbVarint(out, (fieldNum << 3) | 2);
  writePbVarint(out, bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i]);
  }
}

function encodeCodeGeneratorResponse(files: Array<{ name: string; content: string }>): Uint8Array {
  const out: number[] = [];
  // feature = FEATURE_PROTO3_OPTIONAL (1), field 2, varint
  writePbVarint(out, (2 << 3) | 0);
  writePbVarint(out, 1);

  for (const f of files) {
    const fileBuf: number[] = [];
    writePbStringField(fileBuf, 1, f.name);
    writePbStringField(fileBuf, 15, f.content);
    writePbVarint(out, (15 << 3) | 2);
    writePbVarint(out, fileBuf.length);
    for (let i = 0; i < fileBuf.length; i++) {
      out.push(fileBuf[i]);
    }
  }
  return new Uint8Array(out);
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const reqBytes = new Uint8Array(Buffer.concat(chunks));

  const filesToGenerate = new Set<string>();
  const protoFileSlices: Uint8Array[] = [];

  let pos = 0;
  while (pos < reqBytes.length) {
    const [tag, p1] = readPbVarint(reqBytes, pos);
    pos = p1;
    const fieldNum = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (wt === 2 && fieldNum === 1) {
      const [len, p2] = readPbVarint(reqBytes, pos);
      const name = new TextDecoder().decode(reqBytes.subarray(p2, p2 + Number(len)));
      filesToGenerate.add(name);
      pos = p2 + Number(len);
    } else if (wt === 2 && fieldNum === 15) {
      // Field 15 in CodeGeneratorRequest is repeated FileDescriptorProto proto_file.
      // Wrap it as Field 1 of a FileDescriptorSet so parseBinaryFileDescriptorSet can parse it.
      const [len, p2] = readPbVarint(reqBytes, pos);
      const sub = reqBytes.subarray(p2, p2 + Number(len));
      pos = p2 + Number(len);
      const wrapped: number[] = [];
      writePbVarint(wrapped, (1 << 3) | 2);
      writePbVarint(wrapped, sub.length);
      const fdsBuf = new Uint8Array(wrapped.length + sub.length);
      fdsBuf.set(wrapped, 0);
      fdsBuf.set(sub, wrapped.length);
      protoFileSlices.push(fdsBuf);
    } else if (wt === 0) {
      const [, p2] = readPbVarint(reqBytes, pos);
      pos = p2;
    } else if (wt === 2) {
      const [len, p2] = readPbVarint(reqBytes, pos);
      pos = p2 + Number(len);
    } else if (wt === 1) {
      pos += 8;
    } else if (wt === 5) {
      pos += 4;
    }
  }

  const combinedLen = protoFileSlices.reduce((acc, s) => acc + s.length, 0);
  const combinedFdsBytes = new Uint8Array(combinedLen);
  let offset = 0;
  for (const s of protoFileSlices) {
    combinedFdsBytes.set(s, offset);
    offset += s.length;
  }

  const fds = parseBinaryFileDescriptorSet(combinedFdsBytes);
  const allFiles = fds.file ?? [];
  const generated = [];
  for (const file of allFiles) {
    if (filesToGenerate.size === 0 || (file.name && filesToGenerate.has(file.name))) {
      generated.push(generateFileCode(file, allFiles));
    }
  }

  const respBytes = encodeCodeGeneratorResponse(generated);
  process.stdout.write(respBytes);
}

main().catch((err) => {
  process.stderr.write(`protoc-gen-omnibuf-es error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
