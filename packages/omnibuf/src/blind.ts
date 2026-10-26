// ============================================================================
// Field #0 (omnibuf.v1.SchemaMeta) & Schema-Less Inspection (DecodeBlind)
// ============================================================================

import { validateMapTypes, validateValue } from './validation.js';
import { Encoder, mapHeaderByte } from './encoder.js';
import {
  appendSintArrAutoBody,
  appendStringArrBody,
  appendUintArrAutoBody,
  countSubMsgArrElems,
} from './readers.js';
import {
  MaxNestingDepth,
  WireBoolFalse,
  WireBoolTrue,
  WireBytes,
  WireExtended,
  WireFixed32,
  WireFixed64,
  WireFixedArr,
  WireMap,
  WireSint,
  WireSintArr,
  WireString,
  WireStringArr,
  WireSubMsg,
  WireSubMsgArr,
  WireUint,
  WireUintArr,
  decodeUTF8,
  decodeVarintAuto,
  decodeVarintBigInt,
  decodeZigZagAuto,
  float32FromBits,
  float64FromBits,
  nextContainerField,
  readLenSlice,
  roundFloat32Shortest,
} from './wire.js';

/**
 * SchemaMeta is the optional inline schema header encoded as Field #0
 * (`Tag = 0x0B`, `WireSubMsg = 5`) at byte 0 of an OmniBuf message (`omnibuf.v1.SchemaMeta`).
 */
export interface SchemaMeta {
  typeName?: string;
  fields?: Record<number, string>;
  children?: Record<number, SchemaMeta>;
}

/**
 * Base64 encoder for `Uint8Array` (works in both Browser and Node.js without Buffer dependency).
 */
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let out = '';
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      BASE64_CHARS[(n >>> 18) & 63]! +
      BASE64_CHARS[(n >>> 12) & 63]! +
      BASE64_CHARS[(n >>> 6) & 63]! +
      BASE64_CHARS[n & 63]!;
  }
  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += BASE64_CHARS[(n >>> 18) & 63]! + BASE64_CHARS[(n >>> 12) & 63]! + '==';
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      BASE64_CHARS[(n >>> 18) & 63]! +
      BASE64_CHARS[(n >>> 12) & 63]! +
      BASE64_CHARS[(n >>> 6) & 63]! +
      '=';
  }
  return out;
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const clean = b64.replace(/[\r\n\s]/g, '');
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 4 !== 0) {
    throw new Error('omnibuf: invalid base64 string length');
  }
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const byteLen = (clean.length * 3) / 4 - pad;
  const out = new Uint8Array(byteLen);
  let outIdx = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_CHARS.indexOf(clean[i]!);
    const c1 = BASE64_CHARS.indexOf(clean[i + 1]!);
    const isPad2 = clean[i + 2] === '=' && i + 4 === clean.length;
    const isPad3 = clean[i + 3] === '=' && i + 4 === clean.length;
    const c2 = isPad2 ? 0 : BASE64_CHARS.indexOf(clean[i + 2]!);
    const c3 = isPad3 ? 0 : BASE64_CHARS.indexOf(clean[i + 3]!);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0 || (isPad2 && !isPad3)) {
      throw new Error(`omnibuf: invalid base64 character at index ${i}`);
    }
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (outIdx < byteLen) out[outIdx++] = (n >>> 16) & 0xff;
    if (outIdx < byteLen) out[outIdx++] = (n >>> 8) & 0xff;
    if (outIdx < byteLen) out[outIdx++] = n & 0xff;
  }
  return out;
}

function writeSchemaMetaBody(
  enc: Encoder,
  meta: SchemaMeta | null | undefined,
  deterministic: boolean,
): void {
  if (!meta) return;
  // Field #1: type_name (WireString = 3 -> Tag (1 << 4) | 3 = 19 -> 0x27)
  if (meta.typeName && meta.typeName.length > 0) {
    enc.writeByte(0x27);
    enc.writeRawStringPayload(meta.typeName);
  }
  // Field #2: fields map<uint32, string> (WireMap = 9 -> Tag (2 << 4) | 9 = 41 -> 0x53)
  if (meta.fields) {
    const keys = Object.keys(meta.fields).map(Number);
    if (keys.length > 0) {
      if (deterministic) {
        keys.sort((a, b) => a - b);
      }
      enc.writeByte(0x53);
      enc.beginContainer();
      enc.writeByte(mapHeaderByte(WireUint, WireString));
      enc.writeRawVarint(keys.length);
      for (const k of keys) {
        const name = meta.fields[k] ?? '';
        enc.writeRawVarint(k >>> 0);
        enc.writeRawStringPayload(name);
      }
      enc.endContainer();
    }
  }
  // Field #3: children map<uint32, SchemaMeta> (WireMap = 9 -> Tag (3 << 4) | 9 = 57 -> 0x73)
  if (meta.children) {
    const keys = Object.keys(meta.children).map(Number);
    if (keys.length > 0) {
      if (deterministic) {
        keys.sort((a, b) => a - b);
      }
      enc.writeByte(0x73);
      enc.beginContainer();
      enc.writeByte(mapHeaderByte(WireUint, WireSubMsg));
      enc.writeRawVarint(keys.length);
      for (const k of keys) {
        const child = meta.children[k];
        enc.writeRawVarint(k >>> 0);
        enc.beginContainer();
        writeSchemaMetaBody(enc, child, deterministic);
        enc.endContainer();
      }
      enc.endContainer();
    }
  }
}

/**
 * Writes Field #0 (`Tag = 0x0B`, `WireSubMsg = 5`) containing `meta` into `enc`.
 */
export function writeField0SchemaMeta(
  enc: Encoder,
  meta: SchemaMeta | null | undefined,
  deterministic = false,
): void {
  if (!meta) return;
  enc.writeByte(0x0b); // Tag = (0 << 4) | WireSubMsg(5) = 5 -> (5 << 1) | 1 = 0x0B
  enc.beginContainer();
  writeSchemaMetaBody(enc, meta, deterministic);
  enc.endContainer();
}

/**
 * Encodes Field #0 (`Tag = 0x0B`, `WireSubMsg = 5`) containing `meta` as a Uint8Array.
 */
export function encodeField0SchemaMeta(
  meta: SchemaMeta | null | undefined,
  deterministic = true,
): Uint8Array {
  if (!meta) return new Uint8Array(0);
  const enc = new Encoder(128);
  writeField0SchemaMeta(enc, meta, deterministic);
  return enc.finish();
}

/**
 * Merges two `SchemaMeta` definitions (later fields and children override/extend earlier ones).
 */
export function mergeSchemaMeta(
  base: SchemaMeta | null | undefined,
  next: SchemaMeta | null | undefined,
): SchemaMeta | null {
  if (!next) return base ?? null;
  if (!base) {
    const cp: SchemaMeta = {};
    if (next.typeName) cp.typeName = next.typeName;
    if (next.fields && Object.keys(next.fields).length > 0) {
      cp.fields = { ...next.fields };
    }
    if (next.children && Object.keys(next.children).length > 0) {
      cp.children = {};
      for (const [k, c] of Object.entries(next.children)) {
        const mergedChild = mergeSchemaMeta(null, c);
        if (mergedChild) cp.children[Number(k)] = mergedChild;
      }
    }
    return cp;
  }
  const out: SchemaMeta = {
    typeName: next.typeName || base.typeName,
  };
  if (base.fields || next.fields) {
    out.fields = { ...(base.fields ?? {}), ...(next.fields ?? {}) };
  }
  if (base.children || next.children) {
    out.children = { ...(base.children ?? {}) };
    if (next.children) {
      for (const [k, c] of Object.entries(next.children)) {
        const numK = Number(k);
        const mergedChild = mergeSchemaMeta(out.children[numK], c);
        if (mergedChild) out.children[numK] = mergedChild;
      }
    }
  }
  return out;
}

export function decodeSchemaMeta(data: Uint8Array, depth = 0, limit = MaxNestingDepth): SchemaMeta {
  if (depth > limit) {
    throw new Error(
      `omnibuf: SchemaMeta nesting depth ${depth} exceeds MaxNestingDepth (${MaxNestingDepth})`,
    );
  }
  const meta: SchemaMeta = {};
  let pos = 0;
  const n = data.length;

  while (pos < n) {
    const [tag, tn] = decodeVarintBigInt(data, pos);
    if (tn === 0) {
      throw new Error(`omnibuf: truncated tag in Field #0 SchemaMeta at ${pos}`);
    }
    pos += tn;
    const fnum = Number(tag >> 4n);
    const wt = Number(tag & 0x0fn);

    switch (fnum) {
      case 1: {
        if (wt !== WireString) {
          throw new Error(`omnibuf: SchemaMeta field #1 (type_name) must be WireString, got ${wt}`);
        }
        const [s, nextPos] = readLenSlice(data, pos, 0);
        meta.typeName = decodeUTF8(s);
        pos = nextPos;
        break;
      }
      case 2: {
        if (wt !== WireMap) {
          throw new Error(`omnibuf: SchemaMeta field #2 (fields) must be WireMap, got ${wt}`);
        }
        const [body, nextPos] = readLenSlice(data, pos, 2);
        pos = nextPos;
        if (body[0] !== mapHeaderByte(WireUint, WireString)) {
          throw new Error(
            `omnibuf: SchemaMeta fields map must have MapType 0x03, got 0x${body[0]!.toString(16)}`,
          );
        }
        const [count, cn] = decodeVarintBigInt(body, 1);
        if (cn === 0 || count * 2n > BigInt(body.length - (1 + cn))) {
          throw new Error(`omnibuf: SchemaMeta fields count ${count} exceeds body`);
        }
        if (!meta.fields) meta.fields = {};
        let p = 1 + cn;
        const c = Number(count);
        for (let i = 0; i < c; i++) {
          const [k64, kn] = decodeVarintBigInt(body, p);
          if (kn === 0 || k64 === 0n || k64 > 0xffffffffn) {
            throw new Error(`omnibuf: invalid SchemaMeta field number ${k64} at ${p}`);
          }
          p += kn;
          const [nameBytes, nextP] = readLenSlice(body, p, 0);
          meta.fields[Number(k64)] = decodeUTF8(nameBytes);
          p = nextP;
        }
        if (p !== body.length) {
          throw new Error(
            `omnibuf: SchemaMeta fields map trailing bytes (parsed ${p}, body ${body.length})`,
          );
        }
        break;
      }
      case 3: {
        if (wt !== WireMap) {
          throw new Error(`omnibuf: SchemaMeta field #3 (children) must be WireMap, got ${wt}`);
        }
        const [body, nextPos] = readLenSlice(data, pos, 2);
        pos = nextPos;
        if (body[0] !== mapHeaderByte(WireUint, WireSubMsg)) {
          throw new Error(
            `omnibuf: SchemaMeta children map must have MapType 0x05, got 0x${body[0]!.toString(16)}`,
          );
        }
        const [count, cn] = decodeVarintBigInt(body, 1);
        if (cn === 0 || count * 2n > BigInt(body.length - (1 + cn))) {
          throw new Error(`omnibuf: SchemaMeta children count ${count} exceeds body`);
        }
        if (!meta.children) meta.children = {};
        let p = 1 + cn;
        const c = Number(count);
        for (let i = 0; i < c; i++) {
          const [k64, kn] = decodeVarintBigInt(body, p);
          if (kn === 0 || k64 === 0n || k64 > 0xffffffffn) {
            throw new Error(`omnibuf: invalid SchemaMeta child field number ${k64} at ${p}`);
          }
          p += kn;
          const [childBytes, nextP] = readLenSlice(body, p, 0);
          const childMeta = decodeSchemaMeta(childBytes, depth + 1, limit);
          const numK = Number(k64);
          meta.children[numK] = mergeSchemaMeta(meta.children[numK], childMeta) ?? childMeta;
          p = nextP;
        }
        if (p !== body.length) {
          throw new Error(
            `omnibuf: SchemaMeta children map trailing bytes (parsed ${p}, body ${body.length})`,
          );
        }
        break;
      }
      default: {
        if (fnum === 0) {
          throw new Error(`omnibuf: invalid field #0 inside SchemaMeta`);
        }
        pos = validateValue(data, pos, wt, depth, limit);
        break;
      }
    }
  }
  return meta;
}

/**
 * Decodes and merges all Field #0 (`Tag = 0x0B`, `WireSubMsg = 5`) SchemaMeta blocks in `packet`.
 */
export function readField0SchemaMeta(packet: Uint8Array): [meta: SchemaMeta | null, ok: boolean] {
  let merged: SchemaMeta | null = null;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(packet, pos, 0, WireSubMsg, 0);
    if (!valid) return [null, false];
    if (!matched) return [merged, merged !== null];
    pos = nextPos;
    try {
      const m = decodeSchemaMeta(body, 0);
      merged = mergeSchemaMeta(merged, m);
    } catch {
      return [null, false];
    }
  }
}

export interface DecodeBlindOptions {
  /**
   * When true, `WireBytes` fields are returned as standard Base64 strings (matching Go's `encoding/json` output).
   * When false (default), `WireBytes` fields are returned as `Uint8Array`.
   */
  bytesAsBase64?: boolean;
  /**
   * When true (default), `WireFixed32` values are rounded to their shortest 32-bit IEEE-754 decimal representation.
   */
  roundFloat32?: boolean;
}

/**
 * Decodes any OmniBuf packet without a compile-time schema.
 * If Field #0 (`Tag = 0x0B`, `WireSubMsg = 5`, `omnibuf.v1.SchemaMeta`) is present, its field names
 * (and any nested children schemas) are used to decode human-readable keys.
 * Otherwise, synthetic field names (`"field_1"`, `"field_2"`, ...) are used.
 */
export function decodeBlind(
  packet: Uint8Array,
  options?: DecodeBlindOptions,
): Record<string, unknown> {
  return decodeBlindWithSchema(packet, null, 0, options ?? {});
}

function decodeBlindWithSchema(
  data: Uint8Array,
  inherited: SchemaMeta | null | undefined,
  depth: number,
  options: DecodeBlindOptions,
  target?: Record<string, unknown>,
): Record<string, unknown> {
  if (depth > MaxNestingDepth) {
    throw new Error(`omnibuf: nesting depth ${depth} exceeds MaxNestingDepth (${MaxNestingDepth})`);
  }
  const n = data.length;
  if (n === 0) {
    return target ?? {};
  }

  let activeSchema: SchemaMeta | null = inherited ? mergeSchemaMeta(null, inherited) : null;
  let pos = 0;
  const out: Record<string, unknown> = target ?? {};
  // Wire names and map keys are arbitrary strings, including __proto__.
  const own = (key: string) => (Object.hasOwn(out, key) ? out[key] : undefined);
  const roundF32 = options.roundFloat32 !== false;

  while (pos < n) {
    const [tag, tn] = decodeVarintBigInt(data, pos);
    if (tn === 0 || tag >> 4n > 0xffffffffn) {
      throw new Error(`omnibuf: truncated tag at ${pos}`);
    }
    pos += tn;
    const fieldNum = Number(tag >> 4n);
    const wt = Number(tag & 0x0fn);

    if (fieldNum === 0) {
      if (wt !== WireSubMsg) {
        throw new Error(`omnibuf: Field #0 must have WireSubMsg wire type (5), got ${wt}`);
      }
      const [f0Body, nextPos] = readLenSlice(data, pos, 0);
      pos = nextPos;
      const parsedMeta = decodeSchemaMeta(f0Body, depth + 1);
      activeSchema = mergeSchemaMeta(activeSchema, parsedMeta);
      continue;
    }

    const name = activeSchema?.fields?.[fieldNum] || `field_${fieldNum}`;
    const childSchema = activeSchema?.children?.[fieldNum] ?? null;
    if (!Object.hasOwn(out, name)) setOwn(out, name, undefined);

    switch (wt) {
      case WireUint: {
        const [v, vn] = decodeVarintAuto(data, pos);
        if (vn === 0) {
          throw new Error(`omnibuf: truncated WireUint at ${pos}`);
        }
        pos += vn;
        out[name] = v;
        break;
      }
      case WireSint: {
        const [v, vn] = decodeVarintBigInt(data, pos);
        if (vn === 0) {
          throw new Error(`omnibuf: truncated WireSint at ${pos}`);
        }
        pos += vn;
        out[name] = decodeZigZagAuto(v);
        break;
      }
      case WireBoolFalse:
        out[name] = false;
        break;
      case WireBoolTrue:
        out[name] = true;
        break;
      case WireString: {
        const [s, nextPos] = readLenSlice(data, pos, 0);
        out[name] = decodeUTF8(s);
        pos = nextPos;
        break;
      }
      case WireBytes: {
        const [b, nextPos] = readLenSlice(data, pos, 0);
        out[name] = options.bytesAsBase64 ? uint8ArrayToBase64(b) : b.slice();
        pos = nextPos;
        break;
      }
      case WireSubMsg: {
        const [subBytes, nextPos] = readLenSlice(data, pos, 0);
        const prev = own(name);
        const targetSub =
          prev && typeof prev === 'object' && !Array.isArray(prev) && !(prev instanceof Uint8Array)
            ? (prev as Record<string, unknown>)
            : undefined;
        out[name] = decodeBlindWithSchema(subBytes, childSchema, depth + 1, options, targetSub);
        pos = nextPos;
        break;
      }
      case WireStringArr: {
        const [body, nextPos] = readLenSlice(data, pos, 1);
        const prev = Array.isArray(out[name]) ? (out[name] as string[]) : [];
        const [arr, ok] = appendStringArrBody(prev, body);
        if (!ok) {
          throw new Error(`omnibuf: invalid WireStringArr at ${pos}`);
        }
        out[name] = arr;
        pos = nextPos;
        break;
      }
      case WireUintArr: {
        const [body, nextPos] = readLenSlice(data, pos, 1);
        const prev = Array.isArray(out[name]) ? (out[name] as (number | bigint)[]) : [];
        const [arr, ok] = appendUintArrAutoBody(prev, body);
        if (!ok) {
          throw new Error(`omnibuf: invalid WireUintArr at ${pos}`);
        }
        out[name] = arr;
        pos = nextPos;
        break;
      }
      case WireSintArr: {
        const [body, nextPos] = readLenSlice(data, pos, 1);
        const prev = Array.isArray(out[name]) ? (out[name] as (number | bigint)[]) : [];
        const [arr, ok] = appendSintArrAutoBody(prev, body);
        if (!ok) {
          throw new Error(`omnibuf: invalid WireSintArr at ${pos}`);
        }
        out[name] = arr;
        pos = nextPos;
        break;
      }
      case WireFixedArr: {
        const [body, nextPos] = readLenSlice(data, pos, 1);
        const elemType = body[0]!;
        if (elemType === WireFixed32) {
          if ((body.length - 1) % 4 !== 0) {
            throw new Error(`omnibuf: invalid WireFixedArr(Fixed32) at ${pos}`);
          }
          const prev = Array.isArray(out[name]) ? (out[name] as number[]) : [];
          const c = (body.length - 1) / 4;
          for (let i = 0; i < c; i++) {
            const off = 1 + i * 4;
            const bits =
              (body[off]! |
                (body[off + 1]! << 8) |
                (body[off + 2]! << 16) |
                (body[off + 3]! << 24)) >>>
              0;
            const f32 = float32FromBits(bits);
            prev.push(roundF32 ? roundFloat32Shortest(f32) : f32);
          }
          out[name] = prev;
        } else if (elemType === WireFixed64) {
          if ((body.length - 1) % 8 !== 0) {
            throw new Error(`omnibuf: invalid WireFixedArr(Fixed64) at ${pos}`);
          }
          const prev = Array.isArray(out[name]) ? (out[name] as number[]) : [];
          const c = (body.length - 1) / 8;
          for (let i = 0; i < c; i++) {
            const off = 1 + i * 8;
            let u64 = 0n;
            for (let b = 7; b >= 0; b--) {
              u64 = (u64 << 8n) | BigInt(body[off + b]!);
            }
            prev.push(float64FromBits(u64));
          }
          out[name] = prev;
        } else {
          throw new Error(`omnibuf: invalid WireFixedArr ElemType ${elemType}`);
        }
        pos = nextPos;
        break;
      }
      case WireExtended: {
        const [body] = readLenSlice(data, pos, 1);
        throw new Error(
          `omnibuf: unrecognized WireExtended subtype 0x${body[0]!.toString(16).padStart(2, '0')}`,
        );
      }
      case WireSubMsgArr: {
        const [arrPayload, nextPos] = readLenSlice(data, pos, 0);
        const [elemCount, ok] = countSubMsgArrElems(arrPayload);
        if (!ok) {
          throw new Error(`omnibuf: corrupt WireSubMsgArr element framing at ${pos}`);
        }
        const elems: Record<string, unknown>[] = Array.isArray(out[name])
          ? (out[name] as Record<string, unknown>[])
          : [];
        let p = 0;
        for (let i = 0; i < elemCount; i++) {
          const [el, en] = decodeVarintBigInt(arrPayload, p);
          p += en;
          const elNum = Number(el);
          const elemMap = decodeBlindWithSchema(
            arrPayload.subarray(p, p + elNum),
            childSchema,
            depth + 1,
            options,
          );
          elems.push(elemMap);
          p += elNum;
        }
        out[name] = elems;
        pos = nextPos;
        break;
      }
      case WireMap: {
        const [body, nextPos] = readLenSlice(data, pos, 2);
        const mapType = body[0]!;
        const keyWT = mapType >>> 4;
        const valWT = mapType & 0x0f;
        validateMapTypes(keyWT, valWT);
        const [count, cn] = decodeVarintBigInt(body, 1);
        if (cn === 0 || count * 2n > BigInt(body.length - (1 + cn))) {
          throw new Error(`omnibuf: WireMap count ${count} exceeds body (${body.length} B)`);
        }
        const prev = out[name];
        const m: Record<string, unknown> =
          prev && typeof prev === 'object' && !Array.isArray(prev) && !(prev instanceof Uint8Array)
            ? (prev as Record<string, unknown>)
            : {};
        let p = 1 + cn;
        const c = Number(count);
        for (let i = 0; i < c; i++) {
          const [k, nextP] = decodeMapKeyBlind(body, p, keyWT);
          const [v, nextP2] = decodeMapValBlind(body, nextP, valWT, childSchema, depth, options);
          p = nextP2;
          setOwn(m, k, v);
        }
        if (p !== body.length) {
          throw new Error(`omnibuf: WireMap trailing bytes (parsed ${p}, body ${body.length})`);
        }
        out[name] = m;
        pos = nextPos;
        break;
      }
      case WireFixed32: {
        if (n - pos < 4) {
          throw new Error(`omnibuf: truncated WireFixed32 at ${pos}`);
        }
        const bits =
          (data[pos]! | (data[pos + 1]! << 8) | (data[pos + 2]! << 16) | (data[pos + 3]! << 24)) >>>
          0;
        const f32 = float32FromBits(bits);
        out[name] = roundF32 ? roundFloat32Shortest(f32) : f32;
        pos += 4;
        break;
      }
      case WireFixed64: {
        if (n - pos < 8) {
          throw new Error(`omnibuf: truncated WireFixed64 at ${pos}`);
        }
        let u64 = 0n;
        for (let b = 7; b >= 0; b--) {
          u64 = (u64 << 8n) | BigInt(data[pos + b]!);
        }
        out[name] = float64FromBits(u64);
        pos += 8;
        break;
      }
      default:
        throw new Error(`omnibuf: unsupported wire type ${wt}`);
    }
  }

  return out;
}

function decodeMapKeyBlind(
  body: Uint8Array,
  p: number,
  keyWT: number,
): [key: string, nextPos: number] {
  switch (keyWT) {
    case WireString: {
      const [kBytes, nextP] = readLenSlice(body, p, 0);
      return [decodeUTF8(kBytes), nextP];
    }
    case WireUint: {
      const [v, vn] = decodeVarintBigInt(body, p);
      if (vn === 0) {
        throw new Error(`omnibuf: truncated WireMap uint key at ${p}`);
      }
      return [v.toString(), p + vn];
    }
    case WireSint: {
      const [v, vn] = decodeVarintBigInt(body, p);
      if (vn === 0) {
        throw new Error(`omnibuf: truncated WireMap sint key at ${p}`);
      }
      return [decodeZigZagAuto(v).toString(), p + vn];
    }
    case WireFixed32: {
      if (body.length - p < 4) {
        throw new Error(`omnibuf: truncated WireMap fixed32 key at ${p}`);
      }
      const u32 =
        (body[p]! | (body[p + 1]! << 8) | (body[p + 2]! << 16) | (body[p + 3]! << 24)) >>> 0;
      return [u32.toString(), p + 4];
    }
    case WireFixed64: {
      if (body.length - p < 8) {
        throw new Error(`omnibuf: truncated WireMap fixed64 key at ${p}`);
      }
      let u64 = 0n;
      for (let b = 7; b >= 0; b--) {
        u64 = (u64 << 8n) | BigInt(body[p + b]!);
      }
      return [u64.toString(), p + 8];
    }
    case WireBoolTrue:
    case WireBoolFalse: {
      if (body.length - p < 1) {
        throw new Error(`omnibuf: truncated WireMap bool key at ${p}`);
      }
      const b = body[p]!;
      if (b !== 0 && b !== 1) {
        throw new Error(`omnibuf: invalid WireMap bool key ${b} at ${p}`);
      }
      return [b === 1 ? 'true' : 'false', p + 1];
    }
    default:
      throw new Error(`omnibuf: invalid WireMap key wire type ${keyWT}`);
  }
}

function decodeMapValBlind(
  body: Uint8Array,
  p: number,
  valWT: number,
  childSchema: SchemaMeta | null,
  depth: number,
  options: DecodeBlindOptions,
): [val: unknown, nextPos: number] {
  switch (valWT) {
    case WireUint: {
      const [v, vn] = decodeVarintAuto(body, p);
      if (vn === 0) {
        throw new Error(`omnibuf: truncated WireMap uint value at ${p}`);
      }
      return [v, p + vn];
    }
    case WireSint: {
      const [v, vn] = decodeVarintBigInt(body, p);
      if (vn === 0) {
        throw new Error(`omnibuf: truncated WireMap sint value at ${p}`);
      }
      return [decodeZigZagAuto(v), p + vn];
    }
    case WireString: {
      const [vBytes, nextP] = readLenSlice(body, p, 0);
      return [decodeUTF8(vBytes), nextP];
    }
    case WireBytes: {
      const [vBytes, nextP] = readLenSlice(body, p, 0);
      return [options.bytesAsBase64 ? uint8ArrayToBase64(vBytes) : vBytes.slice(), nextP];
    }
    case WireSubMsg: {
      const [vBytes, nextP] = readLenSlice(body, p, 0);
      const subMap = decodeBlindWithSchema(vBytes, childSchema, depth + 1, options);
      return [subMap, nextP];
    }
    case WireFixed32: {
      if (body.length - p < 4) {
        throw new Error(`omnibuf: truncated WireMap fixed32 value at ${p}`);
      }
      const bits =
        (body[p]! | (body[p + 1]! << 8) | (body[p + 2]! << 16) | (body[p + 3]! << 24)) >>> 0;
      const f32 = float32FromBits(bits);
      return [options.roundFloat32 !== false ? roundFloat32Shortest(f32) : f32, p + 4];
    }
    case WireFixed64: {
      if (body.length - p < 8) {
        throw new Error(`omnibuf: truncated WireMap fixed64 value at ${p}`);
      }
      let u64 = 0n;
      for (let b = 7; b >= 0; b--) {
        u64 = (u64 << 8n) | BigInt(body[p + b]!);
      }
      return [float64FromBits(u64), p + 8];
    }
    case WireBoolTrue:
    case WireBoolFalse: {
      if (body.length - p < 1) {
        throw new Error(`omnibuf: truncated WireMap bool value at ${p}`);
      }
      const b = body[p]!;
      if (b !== 0 && b !== 1) {
        throw new Error(`omnibuf: invalid WireMap bool value ${b} at ${p}`);
      }
      return [b === 1, p + 1];
    }
    default:
      throw new Error(`omnibuf: invalid WireMap value wire type ${valWT}`);
  }
}

/**
 * Serializes a blind-decoded object to JSON with deterministic lexicographically sorted object keys,
 * exact 64-bit `bigint` numeric emission, and base64-encoded `Uint8Array` values.
 * If the object contains `NaN` or `Infinity` (which cannot be represented in standard JSON),
 * returns `"{}"` when `fallbackOnNonFinite` is true.
 */
export function stringifyBlindJSON(
  value: unknown,
  indent?: number,
  fallbackOnNonFinite = false,
): string {
  let hasNonFinite = false;
  const step =
    typeof indent === 'number' && indent > 0 ? ' '.repeat(Math.min(10, Math.floor(indent))) : '';

  function serialize(val: unknown, currentIndent: string): string {
    if (typeof val === 'bigint') {
      return val.toString();
    }
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) {
        hasNonFinite = true;
        return 'null';
      }
      if (Object.is(val, -0)) {
        return '-0';
      }
      return JSON.stringify(val);
    }
    if (typeof val === 'boolean') {
      return val ? 'true' : 'false';
    }
    if (typeof val === 'string') {
      return JSON.stringify(val);
    }
    if (val === null || val === undefined) {
      return 'null';
    }
    if (val instanceof Uint8Array) {
      return JSON.stringify(uint8ArrayToBase64(val));
    }
    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      if (!step) {
        const parts: string[] = new Array(val.length);
        for (let i = 0; i < val.length; i++) {
          parts[i] = serialize(val[i], '');
        }
        return `[${parts.join(',')}]`;
      }
      const nextIndent = currentIndent + step;
      const parts: string[] = new Array(val.length);
      for (let i = 0; i < val.length; i++) {
        parts[i] = `${nextIndent}${serialize(val[i], nextIndent)}`;
      }
      return `[\n${parts.join(',\n')}\n${currentIndent}]`;
    }
    if (typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      if (keys.length === 0) return '{}';
      if (!step) {
        const parts: string[] = [];
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i]!;
          const v = obj[k];
          if (v === undefined) continue;
          parts.push(`${JSON.stringify(k)}:${serialize(v, '')}`);
        }
        return `{${parts.join(',')}}`;
      }
      const nextIndent = currentIndent + step;
      const parts: string[] = [];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        const v = obj[k];
        if (v === undefined) continue;
        parts.push(`${nextIndent}${JSON.stringify(k)}: ${serialize(v, nextIndent)}`);
      }
      return `{\n${parts.join(',\n')}\n${currentIndent}}`;
    }
    return 'null';
  }

  const out = serialize(value, '');
  if (hasNonFinite && fallbackOnNonFinite) {
    return '{}';
  }
  return out;
}

/**
 * Decodes an OmniBuf packet without a schema and returns the formatted JSON string.
 */
export function decodeBlindJSON(
  packet: Uint8Array,
  options?: { indent?: number; fallbackOnNonFinite?: boolean },
): string {
  const m = decodeBlind(packet, { bytesAsBase64: true, roundFloat32: true });
  return stringifyBlindJSON(m, options?.indent, options?.fallbackOnNonFinite ?? true);
}

function setOwn(object: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
