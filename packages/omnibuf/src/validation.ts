import { decodeSchemaMeta } from './blind.js';
import {
  MaxNestingDepth,
  WireMap,
  WireSubMsg,
  WireSubMsgArr,
  WireStringArr,
  WireUintArr,
  WireSintArr,
  decodeVarintBigInt,
  readLenSlice,
  skipValue,
} from './wire.js';

/** Validate headers even when an empty map has no entries to inspect. */
export function validateMapTypes(key: number, value: number): void {
  if (![0, 3, 10, 11, 12].includes(key) || ![0, 3, 4, 5, 10, 11, 12].includes(value)) {
    throw new Error(`omnibuf: invalid WireMap types ${key}/${value}`);
  }
}

/** Validate unknown values without allocating decoded arrays or objects. */
export function validateValue(
  data: Uint8Array,
  pos: number,
  wt: number,
  depth = 0,
  limit = MaxNestingDepth,
): number {
  if (wt === WireSubMsg) {
    const [body, end] = readLenSlice(data, pos, 0);
    validateMessage(body, depth + 1, limit);
    return end;
  }
  if (wt === WireSubMsgArr) {
    const [body, end] = readLenSlice(data, pos, 0);
    let p = 0;
    while (p < body.length) {
      const [element, next] = readLenSlice(body, p, 0);
      validateMessage(element, depth + 1, limit);
      p = next;
    }
    return end;
  }
  if (wt === WireStringArr || wt === WireUintArr || wt === WireSintArr || wt === WireMap) {
    const [body, end] = readLenSlice(data, pos, wt === WireMap ? 2 : 1);
    let p = wt === WireMap ? 1 : 0;
    const [count, width] = decodeVarintBigInt(body, p);
    p += width;
    if (!width || count * (wt === WireMap ? 2n : 1n) > BigInt(body.length - p)) {
      throw new Error('omnibuf: invalid container count');
    }
    const key = body[0]! >>> 4,
      value = body[0]! & 15;
    if (wt === WireMap) validateMapTypes(key, value);
    for (let i = 0; i < Number(count); i++) {
      if (wt === WireMap) {
        p = validateValue(body, p, key, depth, limit);
        p = validateValue(body, p, value, depth, limit);
      } else {
        p = skipValue(body, p, wt === WireStringArr ? 3 : 0);
      }
    }
    if (p !== body.length) throw new Error('omnibuf: trailing container bytes');
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
    if (!width) throw new Error('omnibuf: truncated tag');
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
