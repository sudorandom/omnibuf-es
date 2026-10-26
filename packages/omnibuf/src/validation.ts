import { decodeSchemaMeta } from './blind.js';
import {
  MaxNestingDepth,
  WireArray,
  WireBoolFalse,
  WireBoolTrue,
  WireExtended,
  WireFixed32,
  WireFixed64,
  WireFloat32,
  WireFloat64,
  WireMap,
  WireSfixed32,
  WireSfixed64,
  WireSint,
  WireString,
  WireSubMsg,
  WireUint,
  decodeVarintBigInt,
  parseArrayHeader,
  readLenSlice,
  skipValue,
} from './wire.js';

/** Validate headers even when an empty map has no entries to inspect. */
export function validateMapTypes(key: number, value: number): void {
  const validKey =
    key === WireUint ||
    key === WireSint ||
    key === WireBoolFalse ||
    key === WireFixed32 ||
    key === WireFixed64 ||
    key === WireSfixed32 ||
    key === WireSfixed64 ||
    key === WireString;
  const validVal = value <= WireExtended && value !== WireBoolTrue;
  if (!validKey || !validVal) {
    throw new Error(`omnibuf: invalid WireMap types ${key}/${value}`);
  }
}

function validateContainerEntry(
  body: Uint8Array,
  p: number,
  wt: number,
  depth: number,
  limit: number,
): number {
  if (wt === WireBoolFalse) {
    if (p >= body.length || (body[p]! !== 0 && body[p]! !== 1)) {
      throw new Error(`omnibuf: invalid bool byte in container at ${p}`);
    }
    return p + 1;
  }
  if (wt === WireSubMsg) {
    const [sub, nextP] = readLenSlice(body, p, 0);
    validateMessage(sub, depth + 1, limit);
    return nextP;
  }
  if (wt === WireArray || wt === WireMap) {
    return validateValue(body, p, wt, depth + 1, limit);
  }
  return skipValue(body, p, wt);
}

/** Validate unknown values without allocating decoded arrays or objects. */
export function validateValue(
  data: Uint8Array,
  pos: number,
  wt: number,
  depth = 0,
  limit = MaxNestingDepth,
): number {
  if (depth > limit) throw new Error(`omnibuf: nesting depth exceeds ${limit}`);
  if (wt === WireSubMsg) {
    const [body, end] = readLenSlice(data, pos, 0);
    validateMessage(body, depth + 1, limit);
    return end;
  }
  if (wt === WireArray) {
    const [body, end] = readLenSlice(data, pos, 2);
    const [elemType, count, startP, ok] = parseArrayHeader(body);
    if (!ok) {
      throw new Error('omnibuf: invalid WireArray header');
    }
    let p = startP;
    if (elemType === WireBoolFalse) {
      if (body.length - p !== count) {
        throw new Error('omnibuf: invalid WireArray bool length');
      }
      for (let i = 0; i < count; i++) {
        const b = body[p + i]!;
        if (b !== 0 && b !== 1) {
          throw new Error('omnibuf: invalid WireArray bool byte');
        }
      }
      return end;
    }
    if (elemType === WireFixed32 || elemType === WireSfixed32 || elemType === WireFloat32) {
      if (body.length - p !== count * 4) {
        throw new Error('omnibuf: invalid WireArray 32-bit element byte length');
      }
      return end;
    }
    if (elemType === WireFixed64 || elemType === WireSfixed64 || elemType === WireFloat64) {
      if (body.length - p !== count * 8) {
        throw new Error('omnibuf: invalid WireArray 64-bit element byte length');
      }
      return end;
    }
    for (let i = 0; i < count; i++) {
      p = validateContainerEntry(body, p, elemType, depth, limit);
    }
    if (p !== body.length) throw new Error('omnibuf: trailing WireArray bytes');
    return end;
  }
  if (wt === WireMap) {
    const [body, end] = readLenSlice(data, pos, 3);
    const key = body[0]!;
    const value = body[1]!;
    validateMapTypes(key, value);
    const [count, width] = decodeVarintBigInt(body, 2);
    let p = 2 + width;
    if (!width || count > BigInt(Math.floor((body.length - p) / 2))) {
      throw new Error('omnibuf: invalid WireMap count');
    }
    for (let i = 0; i < Number(count); i++) {
      p = validateContainerEntry(body, p, key, depth, limit);
      p = validateContainerEntry(body, p, value, depth, limit);
    }
    if (p !== body.length) throw new Error('omnibuf: trailing WireMap bytes');
    return end;
  }
  // Unknown extensions remain skippable without interpreting their subtype.
  return skipValue(data, pos, wt);
}

export function validateMessage(data: Uint8Array, depth = 0, limit = MaxNestingDepth): void {
  if (depth > limit) throw new Error(`omnibuf: nesting depth exceeds ${limit}`);
  let pos = 0;
  while (pos < data.length) {
    const [tag, width] = decodeVarintBigInt(data, pos);
    if (!width || tag >> 4n > 536870911n) throw new Error('omnibuf: invalid or truncated tag');
    pos += width;
    const wt = Number(tag & 15n);
    if (tag >> 4n === 0n) {
      if (wt !== WireSubMsg) throw new Error('omnibuf: invalid Field #0 wire type');
      const [body, end] = readLenSlice(data, pos, 0);
      decodeSchemaMeta(body, depth + 1, limit);
      pos = end;
    } else {
      pos = validateValue(data, pos, wt, depth, limit);
    }
  }
}
