// ============================================================================
// Header-Scanning Field Readers (O(1) Per-Field Skip) & Wire Splicing (Opaque API)
// ============================================================================

import { Encoder } from './encoder.js';
import {
  WireArray,
  WireBoolFalse,
  WireBoolTrue,
  WireBytes,
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
  decodeUTF8,
  decodeVarint,
  decodeVarintAuto,
  decodeVarintBigInt,
  decodeZigZag,
  decodeZigZagAuto,
  decodeZigZagBigInt,
  fastSkipValue,
  float32FromBits,
  float64FromBits,
  locateField,
  nextContainerField,
  parseArrayHeader,
  parseMapHeader,
  roundFloat32Shortest,
  skipValue,
} from './wire.js';

// ============================================================================
// Scalar Readers
// ============================================================================

export function readUint(packet: Uint8Array, fieldNum: number): [value: number, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireUint) return [0, false];
  const [v, n] = decodeVarint(valSlice, 0);
  return [v, n > 0];
}

export function readEnum(packet: Uint8Array, fieldNum: number): [value: number, ok: boolean] {
  return readInt(packet, fieldNum);
}

export function readUintBigInt(packet: Uint8Array, fieldNum: number): [value: bigint, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireUint) return [0n, false];
  const [v, n] = decodeVarintBigInt(valSlice, 0);
  return [v, n > 0];
}

export function readUintAuto(
  packet: Uint8Array,
  fieldNum: number,
): [value: number | bigint, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireUint) return [0, false];
  const [v, n] = decodeVarintAuto(valSlice, 0);
  return [v, n > 0];
}

export function readInt(packet: Uint8Array, fieldNum: number): [value: number, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireSint) return [0, false];
  const [u, n] = decodeVarintBigInt(valSlice, 0);
  if (n === 0) return [0, false];
  return [decodeZigZag(u), true];
}

export function readIntBigInt(packet: Uint8Array, fieldNum: number): [value: bigint, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireSint) return [0n, false];
  const [u, n] = decodeVarintBigInt(valSlice, 0);
  if (n === 0) return [0n, false];
  return [decodeZigZagBigInt(u), true];
}

export function readIntAuto(
  packet: Uint8Array,
  fieldNum: number,
): [value: number | bigint, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireSint) return [0, false];
  const [u, n] = decodeVarintBigInt(valSlice, 0);
  if (n === 0) return [0, false];
  return [decodeZigZagAuto(u), true];
}

export function readBool(packet: Uint8Array, fieldNum: number): [value: boolean, ok: boolean] {
  const { wireType, ok } = locateField(packet, fieldNum);
  if (!ok || (wireType !== WireBoolTrue && wireType !== WireBoolFalse)) {
    return [false, false];
  }
  return [wireType === WireBoolTrue, true];
}

export function readFixed32(packet: Uint8Array, fieldNum: number): [value: number, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireFixed32 || valSlice.length < 4) {
    return [0, false];
  }
  const bits =
    (valSlice[0]! | (valSlice[1]! << 8) | (valSlice[2]! << 16) | (valSlice[3]! << 24)) >>> 0;
  return [bits, true];
}

export function readSfixed32(packet: Uint8Array, fieldNum: number): [value: number, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireSfixed32 || valSlice.length < 4) {
    return [0, false];
  }
  const bits = valSlice[0]! | (valSlice[1]! << 8) | (valSlice[2]! << 16) | (valSlice[3]! << 24) | 0;
  return [bits, true];
}

export function readFloat32(packet: Uint8Array, fieldNum: number): [value: number, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireFloat32 || valSlice.length < 4) {
    return [0, false];
  }
  const bits =
    (valSlice[0]! | (valSlice[1]! << 8) | (valSlice[2]! << 16) | (valSlice[3]! << 24)) >>> 0;
  return [float32FromBits(bits), true];
}

export function readFixed64(packet: Uint8Array, fieldNum: number): [value: bigint, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireFixed64 || valSlice.length < 8) {
    return [0n, false];
  }
  let u64 = 0n;
  for (let i = 7; i >= 0; i--) {
    u64 = (u64 << 8n) | BigInt(valSlice[i]!);
  }
  return [u64, true];
}

export function readFixed64Auto(
  packet: Uint8Array,
  fieldNum: number,
): [value: number | bigint, ok: boolean] {
  const [u64, ok] = readFixed64(packet, fieldNum);
  if (!ok) return [0, false];
  return [u64 <= 9007199254740991n ? Number(u64) : u64, true];
}

export function readSfixed64(packet: Uint8Array, fieldNum: number): [value: bigint, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireSfixed64 || valSlice.length < 8) {
    return [0n, false];
  }
  let u64 = 0n;
  for (let i = 7; i >= 0; i--) {
    u64 = (u64 << 8n) | BigInt(valSlice[i]!);
  }
  return [BigInt.asIntN(64, u64), true];
}

export function readSfixed64Auto(
  packet: Uint8Array,
  fieldNum: number,
): [value: number | bigint, ok: boolean] {
  const [s64, ok] = readSfixed64(packet, fieldNum);
  if (!ok) return [0, false];
  return [s64 >= -9007199254740991n && s64 <= 9007199254740991n ? Number(s64) : s64, true];
}

export function readFloat64(packet: Uint8Array, fieldNum: number): [value: number, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireFloat64 || valSlice.length < 8) {
    return [0, false];
  }
  let u64 = 0n;
  for (let i = 7; i >= 0; i--) {
    u64 = (u64 << 8n) | BigInt(valSlice[i]!);
  }
  return [float64FromBits(u64), true];
}

export function readStringBytes(
  packet: Uint8Array,
  fieldNum: number,
): [bytes: Uint8Array, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireString || valSlice.length === 0) {
    return [new Uint8Array(0), false];
  }
  const b0 = valSlice[0]!;
  if ((b0 & 1) !== 0) {
    const strLen = b0 >>> 1;
    if (1 + strLen > valSlice.length) {
      return [new Uint8Array(0), false];
    }
    return [valSlice.subarray(1, 1 + strLen), true];
  }
  const [sLen, sn] = decodeVarintBigInt(valSlice, 0);
  if (sn === 0 || sLen > BigInt(valSlice.length - sn)) {
    return [new Uint8Array(0), false];
  }
  return [valSlice.subarray(sn, sn + Number(sLen)), true];
}

export function readString(packet: Uint8Array, fieldNum: number): [value: string, ok: boolean] {
  const [b, ok] = readStringBytes(packet, fieldNum);
  if (!ok) return ['', false];
  return [decodeUTF8(b), true];
}

export function readBytes(packet: Uint8Array, fieldNum: number): [value: Uint8Array, ok: boolean] {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireBytes) {
    return [new Uint8Array(0), false];
  }
  const [bLen, bn] = decodeVarintBigInt(valSlice, 0);
  if (bn === 0 || bLen > BigInt(valSlice.length - bn)) {
    return [new Uint8Array(0), false];
  }
  return [valSlice.subarray(bn, bn + Number(bLen)), true];
}

// ============================================================================
// Sub-Message & Sub-Message Array Readers
// ============================================================================

export function readSubMsg(
  packet: Uint8Array,
  fieldNum: number,
): [subPacket: Uint8Array, ok: boolean] {
  let pos = 0;
  let first: Uint8Array | null = null;
  let chunks: Uint8Array[] | null = null;
  let totalLen = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireSubMsg,
      0,
    );
    if (!valid) return [new Uint8Array(0), false];
    if (!matched) break;
    pos = nextPos;
    if (first === null) {
      first = body;
      totalLen = body.length;
    } else {
      if (chunks === null) {
        chunks = [first];
      }
      chunks.push(body);
      totalLen += body.length;
    }
  }
  if (first === null) {
    return [new Uint8Array(0), false];
  }
  if (chunks === null) {
    return [first, true];
  }
  const merged = new Uint8Array(totalLen);
  let off = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    merged.set(c, off);
    off += c.length;
  }
  return [merged, true];
}

export function readElem(arrPayload: Uint8Array, index: number): [elem: Uint8Array, ok: boolean] {
  if (index < 0) return [new Uint8Array(0), false];
  const [elemType, count, startP, ok] = parseArrayHeader(arrPayload);
  if (!ok || elemType !== WireSubMsg || index >= count) {
    return [new Uint8Array(0), false];
  }
  let pos = startP;
  const n = arrPayload.length;
  for (let i = 0; i < count; i++) {
    if (pos >= n) return [new Uint8Array(0), false];
    let elemLen = 0;
    let en = 0;
    const b0 = arrPayload[pos]!;
    if ((b0 & 1) !== 0) {
      elemLen = b0 >>> 1;
      en = 1;
    } else if ((b0 & 2) !== 0) {
      if (pos + 2 > n) return [new Uint8Array(0), false];
      elemLen = ((b0 | (arrPayload[pos + 1]! << 8)) >>> 2) | 0;
      en = 2;
    } else {
      const [l64, ln] = decodeVarintBigInt(arrPayload, pos);
      if (ln === 0 || l64 > BigInt(n - (pos + ln))) {
        return [new Uint8Array(0), false];
      }
      elemLen = Number(l64);
      en = ln;
    }
    pos += en;
    if (elemLen > n - pos) {
      return [new Uint8Array(0), false];
    }
    if (i === index) {
      return [arrPayload.subarray(pos, pos + elemLen), true];
    }
    pos += elemLen;
  }
  return [new Uint8Array(0), false];
}

export function countSubMsgArrElems(arrPayload: Uint8Array): [count: number, ok: boolean] {
  const [elemType, count, startP, ok] = parseArrayHeader(arrPayload);
  if (!ok || elemType !== WireSubMsg) {
    return [0, false];
  }
  let pos = startP;
  const n = arrPayload.length;
  for (let i = 0; i < count; i++) {
    if (pos >= n) return [0, false];
    const b0 = arrPayload[pos]!;
    if ((b0 & 1) !== 0) {
      pos += 1 + (b0 >>> 1);
      if (pos > n) return [0, false];
      continue;
    }
    if ((b0 & 2) !== 0) {
      if (pos + 2 > n) return [0, false];
      const el = (b0 | (arrPayload[pos + 1]! << 8)) >>> 2;
      pos += 2 + el;
      if (pos > n) return [0, false];
      continue;
    }
    const [el, en] = decodeVarintBigInt(arrPayload, pos);
    if (en === 0 || el > BigInt(n - (pos + en))) {
      return [0, false];
    }
    pos += en + Number(el);
  }
  if (pos !== n) return [0, false];
  return [count, true];
}

export function subMsgArrLen(packet: Uint8Array, fieldNum: number): number {
  let total = 0;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return 0;
    if (!matched) return total;
    pos = nextPos;
    const [c, ok] = countSubMsgArrElems(body);
    if (!ok) return 0;
    total += c;
  }
}

export function readSubMsgArrElem(
  packet: Uint8Array,
  fieldNum: number,
  index: number,
): [elem: Uint8Array, ok: boolean] {
  if (index < 0) return [new Uint8Array(0), false];
  let remIdx = index;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid || !matched) return [new Uint8Array(0), false];
    pos = nextPos;
    const [c, validArr] = countSubMsgArrElems(body);
    if (!validArr) return [new Uint8Array(0), false];
    if (remIdx < c) {
      return readElem(body, remIdx);
    }
    remIdx -= c;
  }
}

export function readNestedStringBytes(
  packet: Uint8Array,
  subMsgField: number,
  targetField: number,
): [bytes: Uint8Array, ok: boolean] {
  let lastBytes: Uint8Array = new Uint8Array(0);
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      subMsgField,
      WireSubMsg,
      0,
    );
    if (!valid) return [new Uint8Array(0), false];
    if (!matched) return [lastBytes, found];
    pos = nextPos;
    const [b, ok] = readStringBytes(body, targetField);
    if (ok) {
      lastBytes = b;
      found = true;
    }
  }
}

export function readNestedString(
  packet: Uint8Array,
  subMsgField: number,
  targetField: number,
): [value: string, ok: boolean] {
  const [b, ok] = readNestedStringBytes(packet, subMsgField, targetField);
  if (!ok) return ['', false];
  return [decodeUTF8(b), true];
}

export function readArrNestedString(
  packet: Uint8Array,
  arrField: number,
  index: number,
  targetField: number,
): [value: string, ok: boolean] {
  const [elem, ok] = readSubMsgArrElem(packet, arrField, index);
  if (!ok) return ['', false];
  return readString(elem, targetField);
}

// ============================================================================
// Packed & Counted Array Readers
// ============================================================================

export function countedArrLen(packet: Uint8Array, fieldNum: number, expElemWT?: number): number {
  const { valSlice, wireType, ok } = locateField(packet, fieldNum);
  if (!ok || wireType !== WireArray) return 0;
  const [bLen, bn] = decodeVarintBigInt(valSlice, 0);
  if (bn === 0 || bLen < 2n || bLen > BigInt(valSlice.length - bn)) return 0;
  const body = valSlice.subarray(bn, bn + Number(bLen));
  const [elemType, c, , headerOk] = parseArrayHeader(body);
  if (!headerOk) return 0;
  if (expElemWT !== undefined && expElemWT !== WireArray && elemType !== expElemWT) {
    return 0;
  }
  return c;
}

export function appendStringArrBody(dst: string[], body: Uint8Array): [out: string[], ok: boolean] {
  const n = body.length;
  const [elemType, c, startP, ok] = parseArrayHeader(body);
  if (!ok || elemType !== WireString) return [[], false];
  let p = startP;
  for (let i = 0; i < c; i++) {
    if (p >= n) return [[], false];
    const sb = body[p]!;
    let lenNum = 0;
    if ((sb & 1) !== 0) {
      lenNum = sb >>> 1;
      p += 1;
    } else if ((sb & 2) !== 0) {
      if (p + 2 > n) return [[], false];
      lenNum = (sb | (body[p + 1]! << 8)) >>> 2;
      p += 2;
    } else {
      const [sLen, sn] = decodeVarintBigInt(body, p);
      if (sn === 0 || sLen > BigInt(n - (p + sn))) {
        return [[], false];
      }
      p += sn;
      lenNum = Number(sLen);
    }
    if (p + lenNum > n) return [[], false];
    dst.push(decodeUTF8(body, p, p + lenNum));
    p += lenNum;
  }
  if (p !== n) {
    return [[], false];
  }
  return [dst, true];
}

export function appendBytesArrBody(
  dst: Uint8Array[],
  body: Uint8Array,
  zeroCopy = false,
): [out: Uint8Array[], ok: boolean] {
  const [elemType, c, startP, ok] = parseArrayHeader(body);
  if (!ok || elemType !== WireBytes) {
    return [[], false];
  }
  let p = startP;
  for (let i = 0; i < c; i++) {
    const [sLen, sn] = decodeVarintBigInt(body, p);
    if (sn === 0 || sLen > BigInt(body.length - (p + sn))) {
      return [[], false];
    }
    p += sn;
    const lenNum = Number(sLen);
    const sub = body.subarray(p, p + lenNum);
    dst.push(zeroCopy ? sub : sub.slice());
    p += lenNum;
  }
  if (p !== body.length) {
    return [[], false];
  }
  return [dst, true];
}

export function appendBoolArrBody(dst: boolean[], body: Uint8Array): [out: boolean[], ok: boolean] {
  const [elemType, c, startP, ok] = parseArrayHeader(body);
  if (!ok || elemType !== WireBoolFalse || body.length - startP !== c) {
    return [[], false];
  }
  for (let i = 0; i < c; i++) {
    const b = body[startP + i]!;
    if (b !== 0 && b !== 1) return [[], false];
    dst.push(b === 1);
  }
  return [dst, true];
}

export function appendUint32ArrBody(dst: number[], body: Uint8Array): [out: number[], ok: boolean] {
  const n = body.length;
  const [elemType, c, startP, ok] = parseArrayHeader(body);
  if (!ok || elemType !== WireUint) return [[], false];
  let p = startP;
  for (let i = 0; i < c; i++) {
    if (p >= n) return [[], false];
    const vb = body[p]!;
    if ((vb & 1) !== 0) {
      dst.push(vb >>> 1);
      p += 1;
    } else if ((vb & 2) !== 0) {
      if (p + 2 > n) return [[], false];
      dst.push((vb | (body[p + 1]! << 8)) >>> 2);
      p += 2;
    } else if ((vb & 4) !== 0) {
      if (p + 4 > n) return [[], false];
      dst.push(
        ((vb | (body[p + 1]! << 8) | (body[p + 2]! << 16) | (body[p + 3]! << 24)) >>> 3) >>> 0,
      );
      p += 4;
    } else {
      if (vb !== 0 || p + 9 > n) return [[], false];
      const lo =
        (body[p + 1]! | (body[p + 2]! << 8) | (body[p + 3]! << 16) | (body[p + 4]! << 24)) >>> 0;
      dst.push(lo);
      p += 9;
    }
  }
  if (p !== n) {
    return [[], false];
  }
  return [dst, true];
}

export function appendEnumArrBody(dst: number[], body: Uint8Array): [out: number[], ok: boolean] {
  const [elemType, c, startP, ok] = parseArrayHeader(body);
  if (!ok || elemType !== WireSint) {
    return [[], false];
  }
  let p = startP;
  for (let i = 0; i < c; i++) {
    const [v, vn] = decodeVarintBigInt(body, p);
    if (vn === 0) return [[], false];
    p += vn;
    dst.push(decodeZigZag(v) | 0);
  }
  if (p !== body.length) {
    return [[], false];
  }
  return [dst, true];
}

export function appendUintArrAutoBody(
  dst: (number | bigint)[],
  body: Uint8Array,
): [out: (number | bigint)[], ok: boolean] {
  const [elemType, c, startP, ok] = parseArrayHeader(body);
  if (!ok || elemType !== WireUint) {
    return [[], false];
  }
  let p = startP;
  for (let i = 0; i < c; i++) {
    const [v, vn] = decodeVarintAuto(body, p);
    if (vn === 0) return [[], false];
    p += vn;
    dst.push(v);
  }
  if (p !== body.length) {
    return [[], false];
  }
  return [dst, true];
}

export function appendSintArrAutoBody(
  dst: (number | bigint)[],
  body: Uint8Array,
): [out: (number | bigint)[], ok: boolean] {
  const [elemType, c, startP, ok] = parseArrayHeader(body);
  if (!ok || elemType !== WireSint) {
    return [[], false];
  }
  let p = startP;
  for (let i = 0; i < c; i++) {
    const [v, vn] = decodeVarintBigInt(body, p);
    if (vn === 0) return [[], false];
    p += vn;
    dst.push(decodeZigZagAuto(v));
  }
  if (p !== body.length) {
    return [[], false];
  }
  return [dst, true];
}

export function appendFloat32ArrBody(
  dst: number[],
  body: Uint8Array,
): [out: number[], ok: boolean] {
  const [elemType, c, startP, ok] = parseArrayHeader(body);
  if (!ok || elemType !== WireFloat32 || body.length - startP !== c * 4) {
    return [[], false];
  }
  for (let i = 0; i < c; i++) {
    const off = startP + i * 4;
    const bits =
      (body[off]! | (body[off + 1]! << 8) | (body[off + 2]! << 16) | (body[off + 3]! << 24)) >>> 0;
    dst.push(float32FromBits(bits));
  }
  return [dst, true];
}

export function appendFloat64ArrBody(
  dst: number[],
  body: Uint8Array,
): [out: number[], ok: boolean] {
  const [elemType, c, startP, ok] = parseArrayHeader(body);
  if (!ok || elemType !== WireFloat64 || body.length - startP !== c * 8) {
    return [[], false];
  }
  for (let i = 0; i < c; i++) {
    const off = startP + i * 8;
    let u64 = 0n;
    for (let b = 7; b >= 0; b--) {
      u64 = (u64 << 8n) | BigInt(body[off + b]!);
    }
    dst.push(float64FromBits(u64));
  }
  return [dst, true];
}

export function readStringArr(
  packet: Uint8Array,
  fieldNum: number,
): [value: string[], ok: boolean] {
  const out: string[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    found = true;
    const [, ok] = appendStringArrBody(out, body);
    if (!ok) return [[], false];
  }
}

export function readUint32Arr(
  packet: Uint8Array,
  fieldNum: number,
): [value: number[], ok: boolean] {
  const out: number[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    found = true;
    const [, ok] = appendUint32ArrBody(out, body);
    if (!ok) return [[], false];
  }
}

export function readEnumArr(packet: Uint8Array, fieldNum: number): [value: number[], ok: boolean] {
  const out: number[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    found = true;
    const [, ok] = appendEnumArrBody(out, body);
    if (!ok) return [[], false];
  }
}

export function readSintArr(
  packet: Uint8Array,
  fieldNum: number,
): [value: (number | bigint)[], ok: boolean] {
  const out: (number | bigint)[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    found = true;
    const [, ok] = appendSintArrAutoBody(out, body);
    if (!ok) return [[], false];
  }
}

export function readFloat32Arr(
  packet: Uint8Array,
  fieldNum: number,
): [value: number[], ok: boolean] {
  const out: number[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    found = true;
    const [, ok] = appendFloat32ArrBody(out, body);
    if (!ok) return [[], false];
  }
}

export function readFloat64Arr(
  packet: Uint8Array,
  fieldNum: number,
): [value: number[], ok: boolean] {
  const out: number[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    found = true;
    const [, ok] = appendFloat64ArrBody(out, body);
    if (!ok) return [[], false];
  }
}

export function readBytesArr(
  packet: Uint8Array,
  fieldNum: number,
): [value: Uint8Array[], ok: boolean] {
  const out: Uint8Array[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    found = true;
    const [, ok] = appendBytesArrBody(out, body, false);
    if (!ok) return [[], false];
  }
}

export function readBoolArr(packet: Uint8Array, fieldNum: number): [value: boolean[], ok: boolean] {
  const out: boolean[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    found = true;
    const [, ok] = appendBoolArrBody(out, body);
    if (!ok) return [[], false];
  }
}

export function readUintArr(
  packet: Uint8Array,
  fieldNum: number,
): [value: (number | bigint)[], ok: boolean] {
  const out: (number | bigint)[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    found = true;
    const [, ok] = appendUintArrAutoBody(out, body);
    if (!ok) return [[], false];
  }
}

export function readFixed32Arr(
  packet: Uint8Array,
  fieldNum: number,
): [value: number[], ok: boolean] {
  const out: number[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    const [elemType, c, startP, ok] = parseArrayHeader(body);
    if (!ok || elemType !== WireFixed32 || body.length - startP !== c * 4) {
      return [[], false];
    }
    found = true;
    for (let i = 0; i < c; i++) {
      const off = startP + i * 4;
      out.push(
        (body[off]! | (body[off + 1]! << 8) | (body[off + 2]! << 16) | (body[off + 3]! << 24)) >>>
          0,
      );
    }
  }
}

export function readSfixed32Arr(
  packet: Uint8Array,
  fieldNum: number,
): [value: number[], ok: boolean] {
  const out: number[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    const [elemType, c, startP, ok] = parseArrayHeader(body);
    if (!ok || elemType !== WireSfixed32 || body.length - startP !== c * 4) {
      return [[], false];
    }
    found = true;
    for (let i = 0; i < c; i++) {
      const off = startP + i * 4;
      out.push(
        body[off]! | (body[off + 1]! << 8) | (body[off + 2]! << 16) | (body[off + 3]! << 24) | 0,
      );
    }
  }
}

export function readFixed64Arr(
  packet: Uint8Array,
  fieldNum: number,
): [value: (number | bigint)[], ok: boolean] {
  const out: (number | bigint)[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    const [elemType, c, startP, ok] = parseArrayHeader(body);
    if (!ok || elemType !== WireFixed64 || body.length - startP !== c * 8) {
      return [[], false];
    }
    found = true;
    for (let i = 0; i < c; i++) {
      const off = startP + i * 8;
      let u64 = 0n;
      for (let b = 7; b >= 0; b--) {
        u64 = (u64 << 8n) | BigInt(body[off + b]!);
      }
      out.push(u64 <= 9007199254740991n ? Number(u64) : u64);
    }
  }
}

export function readSfixed64Arr(
  packet: Uint8Array,
  fieldNum: number,
): [value: (number | bigint)[], ok: boolean] {
  const out: (number | bigint)[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    const [elemType, c, startP, ok] = parseArrayHeader(body);
    if (!ok || elemType !== WireSfixed64 || body.length - startP !== c * 8) {
      return [[], false];
    }
    found = true;
    for (let i = 0; i < c; i++) {
      const off = startP + i * 8;
      let u64 = 0n;
      for (let b = 7; b >= 0; b--) {
        u64 = (u64 << 8n) | BigInt(body[off + b]!);
      }
      const s64 = BigInt.asIntN(64, u64);
      out.push(s64 >= -9007199254740991n && s64 <= 9007199254740991n ? Number(s64) : s64);
    }
  }
}

export function readSubMsgMerged<T>(
  packet: Uint8Array,
  fieldNum: number,
  decodeFn: (sub: Uint8Array, target?: T, merge?: boolean, startPos?: number, endPos?: number) => T,
): [value: T | null, ok: boolean] {
  let out: T | undefined;
  let found = false;
  let pos = 0;
  const n = packet.length;
  const useRange = decodeFn.length >= 4;
  while (pos < n) {
    let fnum = 0;
    let wt = 0;
    const b0 = packet[pos]!;
    if ((b0 & 1) !== 0) {
      fnum = b0 >>> 5;
      wt = (b0 >>> 1) & 0x0f;
      pos += 1;
    } else if ((b0 & 2) !== 0) {
      if (pos + 2 > n) return [null, false];
      const u16 = (b0 | (packet[pos + 1]! << 8)) >>> 2;
      fnum = u16 >>> 4;
      wt = u16 & 0x0f;
      pos += 2;
    } else {
      const [tag, tn] = decodeVarintBigInt(packet, pos);
      if (tn === 0 || tag >> 4n > 536870911n) return [null, false];
      fnum = Number(tag >> 4n);
      wt = Number(tag & 0x0fn);
      pos += tn;
    }

    if (fnum === fieldNum) {
      if (wt !== WireSubMsg || pos >= n) return [null, false];
      let lenNum = 0;
      const lb = packet[pos]!;
      if ((lb & 1) !== 0) {
        lenNum = lb >>> 1;
        pos += 1;
      } else if ((lb & 2) !== 0) {
        if (pos + 2 > n) return [null, false];
        lenNum = (lb | (packet[pos + 1]! << 8)) >>> 2;
        pos += 2;
      } else {
        const [bLen, bBytes] = decodeVarintBigInt(packet, pos);
        if (bBytes === 0 || bLen > BigInt(n - (pos + bBytes))) return [null, false];
        lenNum = Number(bLen);
        pos += bBytes;
      }
      if (pos + lenNum > n) return [null, false];
      out = useRange
        ? decodeFn(packet, out, found, pos, pos + lenNum)
        : decodeFn(packet.subarray(pos, pos + lenNum), out, found);
      found = true;
      pos += lenNum;
      continue;
    }

    try {
      pos = skipValue(packet, pos, wt);
    } catch {
      return [null, false];
    }
  }
  return [out ?? null, found];
}

export function readSubMsgArrDecoded<T>(
  packet: Uint8Array,
  fieldNum: number,
  decodeFn: (sub: Uint8Array) => T,
): [value: T[], ok: boolean] {
  const out: T[] = [];
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(
      packet,
      pos,
      fieldNum,
      WireArray,
      2,
    );
    if (!valid) return [[], false];
    if (!matched) return [out, found];
    pos = nextPos;
    const [count, ok] = countSubMsgArrElems(body);
    if (!ok) return [[], false];
    found = true;
    let [, , p] = parseArrayHeader(body);
    for (let i = 0; i < count; i++) {
      const [el, en] = decodeVarintBigInt(body, p);
      p += en;
      const elNum = Number(el);
      out.push(decodeFn(body.subarray(p, p + elNum)));
      p += elNum;
    }
  }
}

function readMapEntryPayload(
  body: Uint8Array,
  p: number,
  wt: number,
  scalarKind: string,
  decodeSubMsg?: (sub: Uint8Array) => any,
): [val: any, nextPos: number] {
  switch (wt) {
    case WireString: {
      const [len, ln] = decodeVarintBigInt(body, p);
      if (ln === 0 || len > BigInt(body.length - (p + ln))) {
        throw new Error('omnibuf: truncated map string');
      }
      const s = decodeUTF8(body, p + ln, p + ln + Number(len));
      return [s, p + ln + Number(len)];
    }
    case WireBytes: {
      const [len, ln] = decodeVarintBigInt(body, p);
      if (ln === 0 || len > BigInt(body.length - (p + ln))) {
        throw new Error('omnibuf: truncated map bytes');
      }
      const b = body.subarray(p + ln, p + ln + Number(len)).slice();
      return [b, p + ln + Number(len)];
    }
    case WireBoolFalse: {
      if (p >= body.length || (body[p]! !== 0 && body[p]! !== 1)) {
        throw new Error('omnibuf: invalid map bool');
      }
      return [body[p]! === 1, p + 1];
    }
    case WireUint: {
      const [v, vn] = decodeVarintAuto(body, p);
      if (vn === 0) throw new Error('omnibuf: truncated map uint');
      if (scalarKind === 'bool') return [v !== 0 && v !== 0n, p + vn];
      if (scalarKind === 'uint32') {
        return [Number(BigInt(v) & 0xffffffffn) >>> 0, p + vn];
      }
      return [v, p + vn];
    }
    case WireSint: {
      const [v, vn] = decodeVarintBigInt(body, p);
      if (vn === 0) throw new Error('omnibuf: truncated map sint');
      const s = decodeZigZagAuto(v);
      if (scalarKind === 'int32' || scalarKind === 'sint32' || scalarKind === 'enum') {
        return [Number(s) | 0, p + vn];
      }
      return [s, p + vn];
    }
    case WireFixed32: {
      if (body.length - p < 4) throw new Error('omnibuf: truncated map fixed32');
      const bits =
        (body[p]! | (body[p + 1]! << 8) | (body[p + 2]! << 16) | (body[p + 3]! << 24)) >>> 0;
      return [bits, p + 4];
    }
    case WireSfixed32: {
      if (body.length - p < 4) throw new Error('omnibuf: truncated map sfixed32');
      const bits = body[p]! | (body[p + 1]! << 8) | (body[p + 2]! << 16) | (body[p + 3]! << 24) | 0;
      return [bits, p + 4];
    }
    case WireFloat32: {
      if (body.length - p < 4) throw new Error('omnibuf: truncated map float32');
      const bits =
        (body[p]! | (body[p + 1]! << 8) | (body[p + 2]! << 16) | (body[p + 3]! << 24)) >>> 0;
      return [roundFloat32Shortest(float32FromBits(bits)), p + 4];
    }
    case WireFixed64: {
      if (body.length - p < 8) throw new Error('omnibuf: truncated map fixed64');
      let u64 = 0n;
      for (let b = 7; b >= 0; b--) {
        u64 = (u64 << 8n) | BigInt(body[p + b]!);
      }
      return [u64 <= 9007199254740991n ? Number(u64) : u64, p + 8];
    }
    case WireSfixed64: {
      if (body.length - p < 8) throw new Error('omnibuf: truncated map sfixed64');
      let u64 = 0n;
      for (let b = 7; b >= 0; b--) {
        u64 = (u64 << 8n) | BigInt(body[p + b]!);
      }
      const s64 = BigInt.asIntN(64, u64);
      return [s64 >= -9007199254740991n && s64 <= 9007199254740991n ? Number(s64) : s64, p + 8];
    }
    case WireFloat64: {
      if (body.length - p < 8) throw new Error('omnibuf: truncated map float64');
      let u64 = 0n;
      for (let b = 7; b >= 0; b--) {
        u64 = (u64 << 8n) | BigInt(body[p + b]!);
      }
      return [float64FromBits(u64), p + 8];
    }
    case WireSubMsg: {
      const [len, ln] = decodeVarintBigInt(body, p);
      if (ln === 0 || len > BigInt(body.length - (p + ln))) {
        throw new Error('omnibuf: truncated map submsg');
      }
      const sub = body.subarray(p + ln, p + ln + Number(len));
      return [decodeSubMsg ? decodeSubMsg(sub) : sub, p + ln + Number(len)];
    }
    default:
      throw new Error(`omnibuf: unsupported map wire type ${wt}`);
  }
}

export function readTypedMap<V = any>(
  packet: Uint8Array,
  fieldNum: number,
  keyType: string,
  valType: string,
  decodeSubMsg?: (sub: Uint8Array) => V,
): [value: Record<string, V>, ok: boolean] {
  const out: Record<string, V> = {};
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(packet, pos, fieldNum, WireMap, 3);
    if (!valid) return [{}, false];
    if (!matched) return [out, found];
    pos = nextPos;
    const [keyWT, valWT, c, startP, ok] = parseMapHeader(body);
    if (!ok) {
      return [{}, false];
    }
    found = true;
    let p = startP;
    for (let i = 0; i < c; i++) {
      const [kVal, p1] = readMapEntryPayload(body, p, keyWT, keyType);
      const [vVal, p2] = readMapEntryPayload(body, p1, valWT, valType, decodeSubMsg);
      p = p2;
      Object.defineProperty(out, String(kVal), {
        value: vVal,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    if (p !== body.length) {
      return [{}, false];
    }
  }
}

// ============================================================================
// Zero-Allocation Map Lookup (LookupMapStringUint)
// ============================================================================

export function lookupMapStringUint(
  packet: Uint8Array,
  fieldNum: number,
  targetKey: string,
): [value: number | bigint, ok: boolean] {
  let lastVal: number | bigint = 0;
  let found = false;
  let pos = 0;
  while (true) {
    const { body, nextPos, matched, valid } = nextContainerField(packet, pos, fieldNum, WireMap, 3);
    if (!valid) return [0, false];
    if (!matched) return [lastVal, found];
    pos = nextPos;
    const [keyWT, valWT, c, startP, ok] = parseMapHeader(body);
    if (!ok || keyWT !== WireString || valWT !== WireUint) {
      return [0, false];
    }
    let p = startP;
    for (let i = 0; i < c; i++) {
      const [kLen, kn] = decodeVarintBigInt(body, p);
      if (kn === 0 || kLen > BigInt(body.length - (p + kn))) {
        return [0, false];
      }
      p += kn;
      const kLenNum = Number(kLen);
      const k = decodeUTF8(body, p, p + kLenNum);
      p += kLenNum;
      const [v, vn] = decodeVarintAuto(body, p);
      if (vn === 0) return [0, false];
      p += vn;
      if (k === targetKey) {
        lastVal = v;
        found = true;
      }
    }
    if (p !== body.length) {
      return [0, false];
    }
  }
}

// ============================================================================
// Opaque API Runtime Support: Oneof Resolution & Zero-Decode Wire Splicing
// ============================================================================

/**
 * Scans top-level field headers in `packet` to determine which member of a `oneof` group
 * is selected ("last valid write wins"). If `targetField` is the active member, returns
 * the suffix slice of `packet` starting at the beginning of `targetField`'s final uninterrupted
 * streak; otherwise returns `null`.
 */
export function activeOneofSlice(
  packet: Uint8Array,
  targetField: number,
  oneofSpecs: readonly (readonly [fieldNum: number, wireMask: number])[],
): Uint8Array | null {
  let pos = 0;
  const n = packet.length;
  let activeField = -1;
  let streakStart = 0;

  while (pos < n) {
    const fieldStart = pos;
    let fnum = 0;
    let wt = 0;
    const b0 = packet[pos]!;
    if ((b0 & 1) !== 0) {
      fnum = b0 >>> 5;
      wt = (b0 >>> 1) & 0x0f;
      pos += 1;
    } else if ((b0 & 2) !== 0) {
      if (pos + 2 > n) return null;
      const u16 = (b0 | (packet[pos + 1]! << 8)) >>> 2;
      fnum = u16 >>> 4;
      wt = u16 & 0x0f;
      pos += 2;
    } else {
      const [tag, tn] = decodeVarintBigInt(packet, pos);
      if (tn === 0 || tag >> 4n > 536870911n) {
        return null;
      }
      fnum = Number(tag >> 4n);
      wt = Number(tag & 0x0fn);
      pos += tn;
    }

    for (let i = 0; i < oneofSpecs.length; i++) {
      const spec = oneofSpecs[i]!;
      if (spec[0] === fnum && ((spec[1] >>> wt) & 1) !== 0) {
        if (activeField !== fnum) {
          activeField = fnum;
          streakStart = fieldStart;
        }
        break;
      }
    }

    const nextPos = fastSkipValue(packet, pos, wt);
    if (nextPos < 0) {
      return null;
    }
    pos = nextPos;
  }

  if (activeField !== targetField) {
    return null;
  }
  return packet.subarray(streakStart);
}

const sharedSpliceEncoder = new Encoder(8192);
let sharedSpliceInUse = false;

/**
 * Splices unmodified contiguous byte ranges from `raw` and invokes `appendDirty`
 * only for fields whose bit is set in `dirtyMask`, avoiding any decoding of untouched fields.
 */
export function spliceFields(
  raw: Uint8Array,
  dirtyMask: number | bigint,
  maxField: number,
  appendDirty: (enc: Encoder, fieldNum: number) => void,
  enc?: Encoder,
): Uint8Array {
  if (maxField <= 30) {
    const mask32 = typeof dirtyMask === 'bigint' ? Number(dirtyMask & 0x7fffffffn) : dirtyMask | 0;
    if (mask32 === 0) {
      return raw.slice();
    }
    const useShared = enc === undefined && !sharedSpliceInUse;
    if (useShared) sharedSpliceInUse = true;
    const activeEnc = enc ?? (useShared ? sharedSpliceEncoder : new Encoder(raw.length + 64));
    const startPos = useShared ? activeEnc.beginMessage(raw.length + 128) : (activeEnc.reset(), 0);
    try {
      const n = raw.length;
      let pos = 0;
      let cleanStart = 0;
      let emitted32 = 0;

      while (pos < n) {
        const fieldStart = pos;
        let tag = 0;
        const b0 = raw[pos]!;
        if ((b0 & 1) !== 0) {
          tag = b0 >>> 1;
          pos += 1;
        } else if ((b0 & 2) !== 0) {
          if (pos + 2 > n) throw new Error('omnibuf: invalid tag while splicing');
          tag = ((b0 | (raw[pos + 1]! << 8)) >>> 2) >>> 0;
          pos += 2;
        } else {
          const [t64, width] = decodeVarintBigInt(raw, pos);
          if (!width || t64 >> 4n > 536870911n)
            throw new Error('omnibuf: invalid tag while splicing');
          tag = Number(t64);
          pos += width;
        }
        const fnum = tag <= 0x7fffffff ? tag >>> 4 : Math.floor(tag / 16);
        const wt = tag & 0x0f;
        pos = skipValue(raw, pos, wt);
        const fieldEnd = pos;

        const bit = fnum >= 1 && fnum <= maxField ? 1 << fnum : 0;
        if ((mask32 & bit) !== 0) {
          if (cleanStart < fieldStart) {
            activeEnc.writeRaw(raw.subarray(cleanStart, fieldStart));
          }
          if ((emitted32 & bit) === 0) {
            appendDirty(activeEnc, fnum);
            emitted32 |= bit;
          }
          cleanStart = fieldEnd;
        } else {
          emitted32 |= bit;
        }
      }

      if (cleanStart < n) {
        activeEnc.writeRaw(raw.subarray(cleanStart, n));
      }

      const rem = mask32 & ~emitted32;
      if (rem !== 0) {
        for (let fnum = 1; fnum <= maxField; fnum++) {
          if ((rem & (1 << fnum)) !== 0) {
            appendDirty(activeEnc, fnum);
          }
        }
      }

      return useShared ? activeEnc.endMessage(startPos) : activeEnc.finish();
    } finally {
      if (useShared) sharedSpliceInUse = false;
    }
  }

  const mask = typeof dirtyMask === 'bigint' ? dirtyMask : BigInt(dirtyMask >>> 0);
  if (mask === 0n) {
    return raw.slice();
  }
  const activeEnc = enc ?? new Encoder(raw.length + 64);
  activeEnc.reset();
  const n = raw.length;
  let pos = 0;
  let cleanStart = 0;
  let emitted = 0n;

  while (pos < n) {
    const fieldStart = pos;
    const [tag, width] = decodeVarintBigInt(raw, pos);
    if (!width || tag >> 4n > 536870911n) throw new Error('omnibuf: invalid tag while splicing');
    const fnum = Number(tag >> 4n);
    const wt = Number(tag & 15n);
    pos = skipValue(raw, pos + width, wt);
    const fieldEnd = pos;

    const bit = fnum >= 1 && fnum <= maxField ? 1n << BigInt(fnum) : 0n;
    if ((mask & bit) !== 0n) {
      if (cleanStart < fieldStart) {
        activeEnc.writeRaw(raw.subarray(cleanStart, fieldStart));
      }
      if ((emitted & bit) === 0n) {
        appendDirty(activeEnc, fnum);
        emitted |= bit;
      }
      cleanStart = fieldEnd;
    } else {
      emitted |= bit;
    }
  }

  if (cleanStart < n) {
    activeEnc.writeRaw(raw.subarray(cleanStart, n));
  }

  const rem = mask & ~emitted;
  if (rem !== 0n) {
    for (let fnum = 1; fnum <= maxField; fnum++) {
      if ((rem & (1n << BigInt(fnum))) !== 0n) {
        appendDirty(activeEnc, fnum);
      }
    }
  }

  return activeEnc.finish();
}
