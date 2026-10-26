// ============================================================================
// OmniBuf Core Wire Primitives (TZCNT Prefix-Varints, ZigZag, 4-Bit Wire Types)
// ============================================================================

/**
 * Explicit 4-bit Wire Types (0..15) encoded in the low 4 bits of the field tag:
 * Tag = (FieldNumber << 4) | WireType
 */
export const WireUint = 0 as const; // [Prefix-Varint] (unsigned int: uint32, uint64)
export const WireSint = 1 as const; // [Prefix-Varint] (ZigZag signed int: int32, int64, sint32, sint64, enum)
export const WireBoolFalse = 2 as const; // 0 value bytes in field tags; in WireArray/WireMap headers, bool element/key/value type (1 raw byte 0x00 or 0x01)
export const WireBoolTrue = 3 as const; // 0 value bytes in field tags (true encoded directly in tag); invalid in WireArray/WireMap headers
export const WireFixed32 = 4 as const; // [4 Bytes Little-Endian] (uint32 / fixed32)
export const WireFixed64 = 5 as const; // [8 Bytes Little-Endian] (uint64 / fixed64)
export const WireSfixed32 = 6 as const; // [4 Bytes Little-Endian] (int32 / sfixed32)
export const WireSfixed64 = 7 as const; // [8 Bytes Little-Endian] (int64 / sfixed64)
export const WireFloat32 = 8 as const; // [4 Bytes Little-Endian] (IEEE-754 float32 / float)
export const WireFloat64 = 9 as const; // [8 Bytes Little-Endian] (IEEE-754 float64 / double)
export const WireString = 10 as const; // [ByteLen (Prefix-Varint)][UTF-8 Bytes]
export const WireBytes = 11 as const; // [ByteLen (Prefix-Varint)][Raw Bytes]
export const WireSubMsg = 12 as const; // [ByteLen (Prefix-Varint)][Sub-Packet Bytes]
export const WireArray = 13 as const; // [ByteLen (Prefix-Varint)][ElementType (1B)][Count (Prefix-Varint)][Elements...]
export const WireMap = 14 as const; // [ByteLen (Prefix-Varint)][KeyType (1B)][ValueType (1B)][Count (Prefix-Varint)][Key + Value]...
export const WireExtended = 15 as const; // [ByteLen (Prefix-Varint)][ExtType (1B: 0..255)][Extended Payload...]

export type WireType =
  | typeof WireUint
  | typeof WireSint
  | typeof WireBoolFalse
  | typeof WireBoolTrue
  | typeof WireFixed32
  | typeof WireFixed64
  | typeof WireSfixed32
  | typeof WireSfixed64
  | typeof WireFloat32
  | typeof WireFloat64
  | typeof WireString
  | typeof WireBytes
  | typeof WireSubMsg
  | typeof WireArray
  | typeof WireMap
  | typeof WireExtended;

/**
 * Maximum allowed sub-message / array nesting depth (prevents stack-overflow bombs).
 */
export const MaxNestingDepth = 32;

/**
 * Packs a 4-bit key wire type and 4-bit value wire type into a byte (legacy helper).
 */
export function mapHeaderByte(keyType: number, valType: number): number {
  return ((keyType & 0x0f) << 4) | (valType & 0x0f);
}

/**
 * Parses and validates the `[ElementType (1B)][Count (Prefix-Varint)]` header at the start of a
 * `WireArray` body. Returns `[elemType, count, pos, ok]`.
 */
export function parseArrayHeader(
  body: Uint8Array,
  start = 0,
  end = body.length,
): [elemType: number, count: number, pos: number, ok: boolean] {
  if (end - start < 2) {
    return [0, 0, 0, false];
  }
  const elemType = body[start]!;
  if (elemType > WireExtended || elemType === WireBoolTrue) {
    return [0, 0, 0, false];
  }
  let countNum = 0;
  let cn = 0;
  const cb = body[start + 1]!;
  if ((cb & 1) !== 0) {
    countNum = cb >>> 1;
    cn = 1;
  } else if ((cb & 2) !== 0) {
    if (start + 3 > end) {
      return [0, 0, 0, false];
    }
    countNum = (cb | (body[start + 2]! << 8)) >>> 2;
    cn = 2;
  } else {
    const [count64, cBytes] = decodeVarintBigInt(body, start + 1);
    if (cBytes === 0 || count64 > BigInt(end - (start + 1 + cBytes))) {
      return [0, 0, 0, false];
    }
    countNum = Number(count64);
    cn = cBytes;
  }
  const pos = start + 1 + cn;
  if (pos > end) {
    return [0, 0, 0, false];
  }
  const remaining = end - pos;
  let width = 0;
  switch (elemType) {
    case WireBoolFalse:
      width = 1;
      break;
    case WireFixed32:
    case WireFloat32:
    case WireSfixed32:
      width = 4;
      break;
    case WireFixed64:
    case WireFloat64:
    case WireSfixed64:
      width = 8;
      break;
  }
  if (width > 0) {
    if (remaining % width !== 0 || countNum !== remaining / width) {
      return [0, 0, 0, false];
    }
  } else if (countNum > remaining) {
    return [0, 0, 0, false];
  }
  return [elemType, countNum, pos, true];
}

/**
 * Parses and validates the `[KeyType (1B)][ValueType (1B)][Count (Prefix-Varint)]` header
 * at the start of a `WireMap` body. Returns `[keyWT, valWT, count, pos, ok]`.
 */
export function parseMapHeader(
  body: Uint8Array,
  start = 0,
  end = body.length,
): [keyWT: number, valWT: number, count: number, pos: number, ok: boolean] {
  if (end - start < 3) {
    return [0, 0, 0, 0, false];
  }
  const keyWT = body[start]!;
  const valWT = body[start + 1]!;
  const validKey =
    keyWT === WireUint ||
    keyWT === WireSint ||
    keyWT === WireBoolFalse ||
    keyWT === WireFixed32 ||
    keyWT === WireFixed64 ||
    keyWT === WireSfixed32 ||
    keyWT === WireSfixed64 ||
    keyWT === WireString;
  const validVal = valWT <= WireExtended && valWT !== WireBoolTrue;
  if (!validKey || !validVal) {
    return [0, 0, 0, 0, false];
  }
  let countNum = 0;
  let cn = 0;
  const cb = body[start + 2]!;
  if ((cb & 1) !== 0) {
    countNum = cb >>> 1;
    cn = 1;
  } else if ((cb & 2) !== 0) {
    if (start + 4 > end) {
      return [0, 0, 0, 0, false];
    }
    countNum = (cb | (body[start + 3]! << 8)) >>> 2;
    cn = 2;
  } else {
    const [count64, cBytes] = decodeVarintBigInt(body, start + 2);
    if (cBytes === 0 || count64 > BigInt(Math.floor((end - (start + 2 + cBytes)) / 2))) {
      return [0, 0, 0, 0, false];
    }
    countNum = Number(count64);
    cn = cBytes;
  }
  const pos = start + 2 + cn;
  if (pos > end || countNum > (end - pos) >>> 1) {
    return [0, 0, 0, 0, false];
  }
  return [keyWT, valWT, countNum, pos, true];
}

// ============================================================================
// Pluggable UTF-8 String Codec (Tuned by @omnibuf/web and @omnibuf/node)
// ============================================================================

export interface StringCodec {
  encode(str: string): Uint8Array;
  decode(bytes: Uint8Array, start?: number, end?: number): string;
  byteLength(str: string): number;
  encodeInto?(str: string, dst: Uint8Array, offset: number): number;
}

const sharedTextEncoder = new TextEncoder();
const sharedTextDecoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Fast-path pure-JS decoder for short ASCII strings (`<= 64` bytes).
 * Returns `null` if any byte is non-ASCII (`>= 0x80`) or if `end - start > 64`.
 */
export function fastDecodeShortASCII(bytes: Uint8Array, start: number, end: number): string | null {
  const len = end - start;
  if (len <= 0) return '';
  if (len > 64) return null;
  let i = start;
  let out = '';
  while (i + 16 <= end) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    const b3 = bytes[i + 3]!;
    const b4 = bytes[i + 4]!;
    const b5 = bytes[i + 5]!;
    const b6 = bytes[i + 6]!;
    const b7 = bytes[i + 7]!;
    const b8 = bytes[i + 8]!;
    const b9 = bytes[i + 9]!;
    const b10 = bytes[i + 10]!;
    const b11 = bytes[i + 11]!;
    const b12 = bytes[i + 12]!;
    const b13 = bytes[i + 13]!;
    const b14 = bytes[i + 14]!;
    const b15 = bytes[i + 15]!;
    if (
      (b0 | b1 | b2 | b3 | b4 | b5 | b6 | b7 | b8 | b9 | b10 | b11 | b12 | b13 | b14 | b15) >=
      0x80
    ) {
      return null;
    }
    out += String.fromCharCode(
      b0,
      b1,
      b2,
      b3,
      b4,
      b5,
      b6,
      b7,
      b8,
      b9,
      b10,
      b11,
      b12,
      b13,
      b14,
      b15,
    );
    i += 16;
  }
  if (i + 8 <= end) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    const b3 = bytes[i + 3]!;
    const b4 = bytes[i + 4]!;
    const b5 = bytes[i + 5]!;
    const b6 = bytes[i + 6]!;
    const b7 = bytes[i + 7]!;
    if ((b0 | b1 | b2 | b3 | b4 | b5 | b6 | b7) >= 0x80) return null;
    out += String.fromCharCode(b0, b1, b2, b3, b4, b5, b6, b7);
    i += 8;
  }
  const rem = end - i;
  if (rem === 0) return out;
  switch (rem) {
    case 1: {
      const b0 = bytes[i]!;
      if (b0 >= 0x80) return null;
      return out + String.fromCharCode(b0);
    }
    case 2: {
      const b0 = bytes[i]!;
      const b1 = bytes[i + 1]!;
      if ((b0 | b1) >= 0x80) return null;
      return out + String.fromCharCode(b0, b1);
    }
    case 3: {
      const b0 = bytes[i]!;
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      if ((b0 | b1 | b2) >= 0x80) return null;
      return out + String.fromCharCode(b0, b1, b2);
    }
    case 4: {
      const b0 = bytes[i]!;
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      const b3 = bytes[i + 3]!;
      if ((b0 | b1 | b2 | b3) >= 0x80) return null;
      return out + String.fromCharCode(b0, b1, b2, b3);
    }
    case 5: {
      const b0 = bytes[i]!;
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      const b3 = bytes[i + 3]!;
      const b4 = bytes[i + 4]!;
      if ((b0 | b1 | b2 | b3 | b4) >= 0x80) return null;
      return out + String.fromCharCode(b0, b1, b2, b3, b4);
    }
    case 6: {
      const b0 = bytes[i]!;
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      const b3 = bytes[i + 3]!;
      const b4 = bytes[i + 4]!;
      const b5 = bytes[i + 5]!;
      if ((b0 | b1 | b2 | b3 | b4 | b5) >= 0x80) return null;
      return out + String.fromCharCode(b0, b1, b2, b3, b4, b5);
    }
    case 7: {
      const b0 = bytes[i]!;
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      const b3 = bytes[i + 3]!;
      const b4 = bytes[i + 4]!;
      const b5 = bytes[i + 5]!;
      const b6 = bytes[i + 6]!;
      if ((b0 | b1 | b2 | b3 | b4 | b5 | b6) >= 0x80) return null;
      return out + String.fromCharCode(b0, b1, b2, b3, b4, b5, b6);
    }
  }
  return out;
}

const defaultStringCodec: StringCodec = {
  encode(str: string): Uint8Array {
    if (str.length === 0) return new Uint8Array(0);
    return sharedTextEncoder.encode(str);
  },
  decode(bytes: Uint8Array, start = 0, end = bytes.length): string {
    if (end <= start) return '';
    const ascii = fastDecodeShortASCII(bytes, start, end);
    if (ascii !== null) return ascii;
    const sub = start === 0 && end === bytes.length ? bytes : bytes.subarray(start, end);
    return sharedTextDecoder.decode(sub);
  },
  byteLength(str: string): number {
    let len = 0;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code < 0x80) {
        len += 1;
      } else if (code < 0x800) {
        len += 2;
      } else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        i + 1 < str.length &&
        str.charCodeAt(i + 1) >= 0xdc00 &&
        str.charCodeAt(i + 1) <= 0xdfff
      ) {
        len += 4;
        i++;
      } else {
        len += 3;
      }
    }
    return len;
  },
  encodeInto(str: string, dst: Uint8Array, offset: number): number {
    if (str.length === 0) return 0;
    const res = sharedTextEncoder.encodeInto(str, dst.subarray(offset));
    return res.written ?? 0;
  },
};

let activeStringCodec: StringCodec = defaultStringCodec;

export function setStringCodec(codec: StringCodec): void {
  activeStringCodec = codec;
}

export function getStringCodec(): StringCodec {
  return activeStringCodec;
}

export function encodeUTF8(str: string): Uint8Array {
  return activeStringCodec.encode(str);
}

export function decodeUTF8(bytes: Uint8Array, start = 0, end = bytes.length): string {
  if (end <= start) return '';
  if (end - start <= 64) {
    const ascii = fastDecodeShortASCII(bytes, start, end);
    if (ascii !== null) return ascii;
  }
  return activeStringCodec.decode(bytes, start, end);
}

// ============================================================================
// ZigZag Signed Integer Mapping
// ============================================================================

/**
 * Maps a signed integer (number or bigint) to an unsigned 64-bit bigint via ZigZag encoding:
 * u = (n << 1) ^ (n >> 63)
 */
export function encodeZigZag(n: number | bigint): bigint {
  const b = BigInt.asIntN(64, typeof n === 'bigint' ? n : BigInt(Math.trunc(n)));
  return BigInt.asUintN(64, (b << 1n) ^ (b >> 63n));
}

/**
 * Fast-path ZigZag encoding for 32-bit signed integers that fit in safe number range.
 */
export function encodeZigZagNumber(n: number | bigint): number | bigint {
  if (typeof n === 'number' && n >= -268435456 && n <= 268435455) {
    const i = n | 0;
    return ((i << 1) ^ (i >> 31)) >>> 0;
  }
  return encodeZigZag(n);
}

/**
 * Maps a ZigZag-encoded unsigned integer back to a signed 64-bit bigint:
 * n = (u >> 1) ^ -(u & 1)
 */
export function decodeZigZagBigInt(u: number | bigint): bigint {
  const b = BigInt.asUintN(64, typeof u === 'bigint' ? u : BigInt(Math.trunc(u)));
  return BigInt.asIntN(64, (b >> 1n) ^ -(b & 1n));
}

/**
 * Maps a ZigZag-encoded unsigned integer back to a signed JS number (when safe)
 * or bigint (when outside Number.MAX_SAFE_INTEGER).
 */
export function decodeZigZag(u: number | bigint): number {
  if (typeof u === 'number' && u <= 0xffffffff) {
    return (u >>> 1) ^ -(u & 1);
  }
  const b = decodeZigZagBigInt(u);
  return Number(b);
}

/**
 * Decodes a ZigZag value returning a JS number when within safe integer bounds,
 * or a bigint when outside [-9007199254740991, 9007199254740991].
 */
export function decodeZigZagAuto(u: number | bigint): number | bigint {
  if (typeof u === 'number' && u <= 0xffffffff) {
    const res = (u >>> 1) ^ -(u & 1);
    return res === 0 ? 0 : res;
  }
  const b = decodeZigZagBigInt(u);
  if (b >= -9007199254740991n && b <= 9007199254740991n) {
    const n = Number(b);
    return n === 0 ? 0 : n;
  }
  return b;
}

// ============================================================================
// Prefix-Varint (TZCNT) Encoding & Decoding
// ============================================================================

const MAX_1B_VARINT = 127;
const MAX_2B_VARINT = 16383;
const MAX_4B_VARINT = 536870911;

/**
 * Returns the encoded byte width (1, 2, 4, or 9) of a Prefix-Varint.
 */
export function varintByteLength(v: number | bigint): number {
  if (typeof v === 'number') {
    if (v >= 0 && v <= MAX_1B_VARINT) return 1;
    if (v >= 0 && v <= MAX_2B_VARINT) return 2;
    if (v >= 0 && v <= MAX_4B_VARINT) return 4;
    return 9;
  }
  const u = BigInt.asUintN(64, v);
  if (u <= 127n) return 1;
  if (u <= 16383n) return 2;
  if (u <= 536870911n) return 4;
  return 9;
}

/**
 * Writes a Prefix-Varint at `dst[pos]` and returns the new position.
 * Caller must ensure `dst` has at least 9 bytes available from `pos`.
 */
export function writeVarintAt(dst: Uint8Array, pos: number, v: number | bigint): number {
  if (typeof v === 'number' && v >= 0 && v <= 9007199254740991) {
    if (v <= MAX_4B_VARINT) {
      const u32 = v >>> 0;
      if (u32 <= MAX_1B_VARINT) {
        dst[pos] = ((u32 << 1) | 1) & 0xff;
        return pos + 1;
      }
      if (u32 <= MAX_2B_VARINT) {
        const u16 = ((u32 << 2) | 2) & 0xffff;
        dst[pos] = u16 & 0xff;
        dst[pos + 1] = (u16 >>> 8) & 0xff;
        return pos + 2;
      }
      const w32 = ((u32 << 3) | 4) >>> 0;
      dst[pos] = w32 & 0xff;
      dst[pos + 1] = (w32 >>> 8) & 0xff;
      dst[pos + 2] = (w32 >>> 16) & 0xff;
      dst[pos + 3] = (w32 >>> 24) & 0xff;
      return pos + 4;
    }
    const lo = v >>> 0;
    const hi = Math.floor(v / 0x100000000) >>> 0;
    dst[pos] = 0x00;
    dst[pos + 1] = lo & 0xff;
    dst[pos + 2] = (lo >>> 8) & 0xff;
    dst[pos + 3] = (lo >>> 16) & 0xff;
    dst[pos + 4] = (lo >>> 24) & 0xff;
    dst[pos + 5] = hi & 0xff;
    dst[pos + 6] = (hi >>> 8) & 0xff;
    dst[pos + 7] = (hi >>> 16) & 0xff;
    dst[pos + 8] = (hi >>> 24) & 0xff;
    return pos + 9;
  }

  const u = BigInt.asUintN(64, typeof v === 'bigint' ? v : BigInt(Math.trunc(v)));
  if (u <= 127n) {
    dst[pos] = Number((u << 1n) | 1n);
    return pos + 1;
  }
  if (u <= 16383n) {
    const u16 = Number((u << 2n) | 2n);
    dst[pos] = u16 & 0xff;
    dst[pos + 1] = (u16 >>> 8) & 0xff;
    return pos + 2;
  }
  if (u <= 536870911n) {
    const w32 = Number((u << 3n) | 4n) >>> 0;
    dst[pos] = w32 & 0xff;
    dst[pos + 1] = (w32 >>> 8) & 0xff;
    dst[pos + 2] = (w32 >>> 16) & 0xff;
    dst[pos + 3] = (w32 >>> 24) & 0xff;
    return pos + 4;
  }
  dst[pos] = 0x00;
  let rem = u;
  for (let i = 1; i <= 8; i++) {
    dst[pos + i] = Number(rem & 0xffn);
    rem >>= 8n;
  }
  return pos + 9;
}

/**
 * Appends a Prefix-Varint to a Uint8Array and returns a new Uint8Array.
 */
export function appendVarint(dst: Uint8Array, v: number | bigint): Uint8Array {
  const width = varintByteLength(v);
  const out = new Uint8Array(dst.length + width);
  out.set(dst, 0);
  writeVarintAt(out, dst.length, v);
  return out;
}

/**
 * Decodes a Prefix-Varint from `b` starting at `pos` (default 0).
 * Returns `[value, bytesRead]`. If truncated, returns `[0, 0]`.
 */
export function decodeVarint(
  b: Uint8Array,
  pos = 0,
  end = b.length,
): [value: number, bytesRead: number] {
  const rem = end - pos;
  if (rem <= 0) return [0, 0];
  const b0 = b[pos]!;
  if ((b0 & 1) !== 0) {
    return [b0 >>> 1, 1];
  }
  if (rem < 2) return [0, 0];
  if ((b0 & 2) !== 0) {
    const u16 = b0 | (b[pos + 1]! << 8);
    return [u16 >>> 2, 2];
  }
  if ((b0 & 4) !== 0) {
    if (rem < 4) return [0, 0];
    const u32 = (b0 | (b[pos + 1]! << 8) | (b[pos + 2]! << 16) | (b[pos + 3]! << 24)) >>> 0;
    return [u32 >>> 3, 4];
  }
  if (b0 !== 0 || rem < 9) return [0, 0];
  const lo = (b[pos + 1]! | (b[pos + 2]! << 8) | (b[pos + 3]! << 16) | (b[pos + 4]! << 24)) >>> 0;
  const hi = (b[pos + 5]! | (b[pos + 6]! << 8) | (b[pos + 7]! << 16) | (b[pos + 8]! << 24)) >>> 0;
  return [hi * 0x100000000 + lo, 9];
}

/**
 * Decodes a Prefix-Varint from `b` starting at `pos` as an exact 64-bit unsigned `bigint`.
 * Returns `[value, bytesRead]`. If truncated, returns `[0n, 0]`.
 */
export function decodeVarintBigInt(
  b: Uint8Array,
  pos = 0,
  end = b.length,
): [value: bigint, bytesRead: number] {
  const rem = end - pos;
  if (rem <= 0) return [0n, 0];
  const b0 = b[pos]!;
  if ((b0 & 1) !== 0) {
    return [BigInt(b0 >>> 1), 1];
  }
  if (rem < 2) return [0n, 0];
  if ((b0 & 2) !== 0) {
    const u16 = b0 | (b[pos + 1]! << 8);
    return [BigInt(u16 >>> 2), 2];
  }
  if ((b0 & 4) !== 0) {
    if (rem < 4) return [0n, 0];
    const u32 = (b0 | (b[pos + 1]! << 8) | (b[pos + 2]! << 16) | (b[pos + 3]! << 24)) >>> 0;
    return [BigInt(u32 >>> 3), 4];
  }
  if (b0 !== 0 || rem < 9) return [0n, 0];
  let u64 = 0n;
  for (let i = 8; i >= 1; i--) {
    u64 = (u64 << 8n) | BigInt(b[pos + i]!);
  }
  return [u64, 9];
}

/**
 * Decodes a Prefix-Varint returning a JS `number` when within safe integer bounds (`<= 2^53 - 1`),
 * or a `bigint` when larger. Returns `[value, bytesRead]`.
 */
export function decodeVarintAuto(
  b: Uint8Array,
  pos = 0,
  end = b.length,
): [value: number | bigint, bytesRead: number] {
  const rem = end - pos;
  if (rem <= 0) return [0, 0];
  const b0 = b[pos]!;
  if ((b0 & 1) !== 0) {
    return [b0 >>> 1, 1];
  }
  if (rem < 2) return [0, 0];
  if ((b0 & 2) !== 0) {
    return [(b0 | (b[pos + 1]! << 8)) >>> 2, 2];
  }
  if ((b0 & 4) !== 0) {
    if (rem < 4) return [0, 0];
    const u32 = (b0 | (b[pos + 1]! << 8) | (b[pos + 2]! << 16) | (b[pos + 3]! << 24)) >>> 0;
    return [u32 >>> 3, 4];
  }
  if (b0 !== 0 || rem < 9) return [0, 0];
  const lo = (b[pos + 1]! | (b[pos + 2]! << 8) | (b[pos + 3]! << 16) | (b[pos + 4]! << 24)) >>> 0;
  const hi = (b[pos + 5]! | (b[pos + 6]! << 8) | (b[pos + 7]! << 16) | (b[pos + 8]! << 24)) >>> 0;
  if (hi <= 0x1fffff) {
    return [hi * 0x100000000 + lo, 9];
  }
  return [(BigInt(hi) << 32n) | BigInt(lo), 9];
}

/**
 * Decodes a Prefix-Varint at `b[pos]` and returns `[value, nextPos]`.
 */
export function readVarintAt(b: Uint8Array, pos: number): [value: number, nextPos: number] {
  const [v, n] = decodeVarint(b, pos);
  return [v, pos + n];
}

/**
 * Encodes a length (0..16383) as an explicit 2-byte Prefix-Varint
 * (TZCNT=1: uint16(v<<2)|2) for single-pass sub-message and container length backpatching.
 */
export function putOverlong2BVarint(dst: Uint8Array, pos: number, v: number): void {
  const u16 = ((v << 2) | 2) & 0xffff;
  dst[pos] = u16 & 0xff;
  dst[pos + 1] = (u16 >>> 8) & 0xff;
}

/**
 * Backpatches the container byte length at `dst[lenPos:lenPos+2]` for the common fast path
 * (`subLen <= 16383`). If `subLen > 16383`, expands the reserved 2-byte slot to a 4-byte
 * or 9-byte Prefix-Varint by shifting the container body right.
 */
export function backpatchContainerLen(
  dst: Uint8Array,
  lenPos: number,
  endPos = dst.length,
): Uint8Array {
  const subLen = endPos - (lenPos + 2);
  if (subLen >= 0 && subLen <= MAX_2B_VARINT) {
    const u16 = ((subLen << 2) | 2) & 0xffff;
    dst[lenPos] = u16 & 0xff;
    dst[lenPos + 1] = (u16 >>> 8) & 0xff;
    return dst.subarray(0, endPos);
  }
  if (subLen <= MAX_4B_VARINT) {
    const out = new Uint8Array(endPos + 2);
    out.set(dst.subarray(0, lenPos), 0);
    out.set(dst.subarray(lenPos + 2, endPos), lenPos + 4);
    const w32 = ((subLen << 3) | 4) >>> 0;
    out[lenPos] = w32 & 0xff;
    out[lenPos + 1] = (w32 >>> 8) & 0xff;
    out[lenPos + 2] = (w32 >>> 16) & 0xff;
    out[lenPos + 3] = (w32 >>> 24) & 0xff;
    return out;
  }
  const out = new Uint8Array(endPos + 7);
  out.set(dst.subarray(0, lenPos), 0);
  out.set(dst.subarray(lenPos + 2, endPos), lenPos + 9);
  writeVarintAt(out, lenPos, BigInt(subLen));
  return out;
}

// ============================================================================
// O(1) Field Skipping & Header-Hop Field Lookup (LocateField)
// ============================================================================

/**
 * Advances `pos` past a field value of wire type `wt` in O(1) time without allocating errors.
 * Returns the next position, or `-1` if truncated or invalid.
 */
export function fastSkipValue(packet: Uint8Array, pos: number, wt: number): number {
  const n = packet.length;
  switch (wt) {
    case WireUint:
    case WireSint: {
      if (pos >= n) return -1;
      const vb = packet[pos]!;
      if ((vb & 1) !== 0) {
        pos += 1;
      } else if ((vb & 2) !== 0) {
        pos += 2;
      } else if ((vb & 4) !== 0) {
        pos += 4;
      } else if (vb === 0) {
        pos += 9;
      } else {
        return -1;
      }
      return pos <= n ? pos : -1;
    }
    case WireBoolFalse:
    case WireBoolTrue:
      return pos <= n ? pos : -1;
    case WireString:
    case WireBytes:
    case WireSubMsg:
    case WireArray:
    case WireMap:
    case WireExtended: {
      if (pos >= n) return -1;
      const minLen = wt === WireMap ? 3 : wt === WireArray ? 2 : wt === WireExtended ? 1 : 0;
      const lb = packet[pos]!;
      if ((lb & 1) !== 0) {
        const lenNum = lb >>> 1;
        if (lenNum < minLen) return -1;
        pos += 1 + lenNum;
        return pos <= n ? pos : -1;
      }
      if ((lb & 2) !== 0) {
        if (pos + 2 > n) return -1;
        const u16 = lb | (packet[pos + 1]! << 8);
        const lenNum = u16 >>> 2;
        if (lenNum < minLen) return -1;
        pos += 2 + lenNum;
        return pos <= n ? pos : -1;
      }
      const [bLen, bn] = decodeVarintBigInt(packet, pos);
      if (bn === 0 || bLen < BigInt(minLen)) return -1;
      const rem = BigInt(n - (pos + bn));
      if (bLen > rem) return -1;
      pos += bn + Number(bLen);
      return pos <= n ? pos : -1;
    }
    case WireFixed32:
    case WireSfixed32:
    case WireFloat32:
      pos += 4;
      return pos <= n ? pos : -1;
    case WireFixed64:
    case WireSfixed64:
    case WireFloat64:
      pos += 8;
      return pos <= n ? pos : -1;
    default:
      return -1;
  }
}

/**
 * Advances `pos` past a single field payload of the given 4-bit `wireType` (0..15),
 * performing full bounds and structural alignment validation in O(1) time.
 */
function isValidArrayHeaderAt(body: Uint8Array, start: number, end: number): boolean {
  if (end - start < 2) return false;
  const elemType = body[start]!;
  if (elemType > WireExtended || elemType === WireBoolTrue) return false;
  let countNum = 0;
  let cn = 0;
  const cb = body[start + 1]!;
  if ((cb & 1) !== 0) {
    countNum = cb >>> 1;
    cn = 1;
  } else if ((cb & 2) !== 0) {
    if (start + 3 > end) return false;
    countNum = (cb | (body[start + 2]! << 8)) >>> 2;
    cn = 2;
  } else {
    const [count64, cBytes] = decodeVarintBigInt(body, start + 1, end);
    if (cBytes === 0 || count64 > BigInt(end - (start + 1 + cBytes))) return false;
    countNum = Number(count64);
    cn = cBytes;
  }
  const pos = start + 1 + cn;
  if (pos > end) return false;
  const remaining = end - pos;
  switch (elemType) {
    case WireBoolFalse:
      return countNum === remaining;
    case WireFixed32:
    case WireFloat32:
    case WireSfixed32:
      return (remaining & 3) === 0 && countNum === remaining >>> 2;
    case WireFixed64:
    case WireFloat64:
    case WireSfixed64:
      return (remaining & 7) === 0 && countNum === remaining >>> 3;
    default:
      return countNum <= remaining;
  }
}

function isValidMapHeaderAt(body: Uint8Array, start: number, end: number): boolean {
  if (end - start < 3) return false;
  const keyWT = body[start]!;
  const valWT = body[start + 1]!;
  const validKey =
    keyWT === WireUint ||
    keyWT === WireSint ||
    keyWT === WireBoolFalse ||
    keyWT === WireFixed32 ||
    keyWT === WireFixed64 ||
    keyWT === WireSfixed32 ||
    keyWT === WireSfixed64 ||
    keyWT === WireString;
  const validVal = valWT <= WireExtended && valWT !== WireBoolTrue;
  if (!validKey || !validVal) return false;
  let countNum = 0;
  let cn = 0;
  const cb = body[start + 2]!;
  if ((cb & 1) !== 0) {
    countNum = cb >>> 1;
    cn = 1;
  } else if ((cb & 2) !== 0) {
    if (start + 4 > end) return false;
    countNum = (cb | (body[start + 3]! << 8)) >>> 2;
    cn = 2;
  } else {
    const [count64, cBytes] = decodeVarintBigInt(body, start + 2, end);
    if (cBytes === 0 || count64 > BigInt(Math.floor((end - (start + 2 + cBytes)) / 2)))
      return false;
    countNum = Number(count64);
    cn = cBytes;
  }
  const pos = start + 2 + cn;
  return pos <= end && countNum <= (end - pos) >>> 1;
}

export function skipValue(b: Uint8Array, pos: number, wireType: number): number {
  const n = b.length;
  if (pos < 0 || pos > n) {
    throw new Error(`omnibuf: position ${pos} out of bounds`);
  }
  if (wireType === WireArray || wireType === WireMap || wireType === WireExtended) {
    if (pos >= n) {
      throw new Error('omnibuf: invalid container length');
    }
    let lenNum = 0;
    let ln = 0;
    const lb = b[pos]!;
    if ((lb & 1) !== 0) {
      lenNum = lb >>> 1;
      ln = 1;
    } else if ((lb & 2) !== 0) {
      if (pos + 2 > n) {
        throw new Error('omnibuf: invalid container length');
      }
      lenNum = (lb | (b[pos + 1]! << 8)) >>> 2;
      ln = 2;
    } else {
      const [bLen, lBytes] = decodeVarintBigInt(b, pos);
      if (lBytes === 0 || bLen < 1n || bLen > BigInt(n - pos - lBytes)) {
        throw new Error('omnibuf: invalid container length');
      }
      lenNum = Number(bLen);
      ln = lBytes;
    }
    if (lenNum < 1 || pos + ln + lenNum > n) {
      throw new Error('omnibuf: invalid container length');
    }
    const end = pos + ln + lenNum;
    if (wireType === WireArray) {
      if (!isValidArrayHeaderAt(b, pos + ln, end)) {
        throw new Error('omnibuf: invalid array header');
      }
    } else if (wireType === WireMap) {
      if (!isValidMapHeaderAt(b, pos + ln, end)) {
        throw new Error('omnibuf: invalid map header');
      }
    }
    return end;
  }
  const nextPos = fastSkipValue(b, pos, wireType);
  if (nextPos < 0) {
    throw new Error(`omnibuf: truncated or invalid wireType ${wireType} at ${pos}`);
  }
  return nextPos;
}

export interface LocateFieldResult {
  valSlice: Uint8Array;
  valPos: number;
  wireType: number;
  ok: boolean;
}

const NOT_FOUND: LocateFieldResult = {
  valSlice: new Uint8Array(0),
  valPos: 0,
  wireType: 0,
  ok: false,
};

/**
 * Locates `targetField` inside `packet` by hopping across field headers in O(1) time per field
 * using TZCNT length prefixes (without parsing inside preceding strings, sub-messages, or arrays).
 * Scans all field headers in the message and returns the last matching occurrence ("last write wins").
 */
export function locateField(packet: Uint8Array, targetField: number): LocateFieldResult {
  let pos = 0;
  const n = packet.length;
  let lastPos = -1;
  let lastWT = 0;

  while (pos < n) {
    let fnum = 0;
    let wt = 0;
    const b0 = packet[pos]!;
    if ((b0 & 1) !== 0) {
      fnum = b0 >>> 5;
      wt = (b0 >>> 1) & 0x0f;
      pos += 1;
    } else if ((b0 & 2) !== 0) {
      if (pos + 2 > n) return NOT_FOUND;
      const u16 = (b0 | (packet[pos + 1]! << 8)) >>> 2;
      fnum = u16 >>> 4;
      wt = u16 & 0x0f;
      pos += 2;
    } else {
      const [tag, tn] = decodeVarintBigInt(packet, pos);
      if (tn === 0 || tag >> 4n > 536870911n) {
        return NOT_FOUND;
      }
      fnum = Number(tag >> 4n);
      wt = Number(tag & 0x0fn);
      pos += tn;
    }

    if (fnum === targetField) {
      lastPos = pos;
      lastWT = wt;
    }

    const nextPos = fastSkipValue(packet, pos, wt);
    if (nextPos < 0) {
      return NOT_FOUND;
    }
    pos = nextPos;
  }

  if (lastPos < 0) {
    return NOT_FOUND;
  }
  return {
    valSlice: packet.subarray(lastPos),
    valPos: lastPos,
    wireType: lastWT,
    ok: true,
  };
}

export interface NextContainerResult {
  body: Uint8Array;
  nextPos: number;
  matched: boolean;
  valid: boolean;
}

/**
 * Scans `packet` starting at `pos` for the next occurrence of `targetField`.
 * Validates `wt === expWT` and `byteLen >= minLen`, returning the container body slice.
 */
export function nextContainerField(
  packet: Uint8Array,
  pos: number,
  targetField: number,
  expWT: number,
  minLen: number,
): NextContainerResult {
  const n = packet.length;
  while (pos < n) {
    let fnum = 0;
    let wt = 0;
    const b0 = packet[pos]!;
    if ((b0 & 1) !== 0) {
      fnum = b0 >>> 5;
      wt = (b0 >>> 1) & 0x0f;
      pos += 1;
    } else if ((b0 & 2) !== 0) {
      if (pos + 2 > n) {
        return { body: new Uint8Array(0), nextPos: 0, matched: false, valid: false };
      }
      const u16 = (b0 | (packet[pos + 1]! << 8)) >>> 2;
      fnum = u16 >>> 4;
      wt = u16 & 0x0f;
      pos += 2;
    } else {
      const [tag, tn] = decodeVarintBigInt(packet, pos);
      if (tn === 0 || tag >> 4n > 536870911n) {
        return { body: new Uint8Array(0), nextPos: 0, matched: false, valid: false };
      }
      fnum = Number(tag >> 4n);
      wt = Number(tag & 0x0fn);
      pos += tn;
    }

    if (fnum === targetField) {
      if (wt !== expWT || pos >= n) {
        return { body: new Uint8Array(0), nextPos: 0, matched: false, valid: false };
      }
      let lenNum = 0;
      let bn = 0;
      const lb = packet[pos]!;
      if ((lb & 1) !== 0) {
        lenNum = lb >>> 1;
        bn = 1;
      } else if ((lb & 2) !== 0) {
        if (pos + 2 > n) {
          return { body: new Uint8Array(0), nextPos: 0, matched: false, valid: false };
        }
        lenNum = (lb | (packet[pos + 1]! << 8)) >>> 2;
        bn = 2;
      } else {
        const [bLen, bBytes] = decodeVarintBigInt(packet, pos);
        const rem = BigInt(n - (pos + bBytes));
        if (bBytes === 0 || bLen < BigInt(minLen) || bLen > rem) {
          return { body: new Uint8Array(0), nextPos: 0, matched: false, valid: false };
        }
        lenNum = Number(bLen);
        bn = bBytes;
      }
      if (lenNum < minLen || pos + bn + lenNum > n) {
        return { body: new Uint8Array(0), nextPos: 0, matched: false, valid: false };
      }
      pos += bn;
      return {
        body: packet.subarray(pos, pos + lenNum),
        nextPos: pos + lenNum,
        matched: true,
        valid: true,
      };
    }

    try {
      pos = skipValue(packet, pos, wt);
    } catch {
      return { body: new Uint8Array(0), nextPos: 0, matched: false, valid: false };
    }
  }
  return { body: new Uint8Array(0), nextPos: n, matched: false, valid: true };
}

/**
 * Reads a length-prefixed slice `[ByteLen (Prefix-Varint)][Payload]` at `data[pos]`,
 * enforcing `byteLen >= minLen` and bounds within `data`.
 */
export function readLenSlice(
  data: Uint8Array,
  pos: number,
  minLen = 0,
  end = data.length,
): [body: Uint8Array, nextPos: number] {
  const n = end;
  if (pos >= n) {
    throw new Error(`omnibuf: truncated length varint at ${pos}`);
  }
  const b0 = data[pos]!;
  if ((b0 & 1) !== 0) {
    const lenNum = b0 >>> 1;
    pos += 1;
    if (lenNum < minLen || pos + lenNum > n) {
      throw new Error(`omnibuf: invalid byteLen ${lenNum} at ${pos}`);
    }
    return [data.subarray(pos, pos + lenNum), pos + lenNum];
  }
  if ((b0 & 2) !== 0) {
    if (pos + 2 > n) {
      throw new Error(`omnibuf: truncated length varint at ${pos}`);
    }
    const lenNum = (b0 | (data[pos + 1]! << 8)) >>> 2;
    pos += 2;
    if (lenNum < minLen || pos + lenNum > n) {
      throw new Error(`omnibuf: invalid byteLen ${lenNum} at ${pos}`);
    }
    return [data.subarray(pos, pos + lenNum), pos + lenNum];
  }
  const [bLen, bn] = decodeVarintBigInt(data, pos, n);
  if (bn === 0) {
    throw new Error(`omnibuf: truncated length varint at ${pos}`);
  }
  pos += bn;
  const rem = BigInt(n - pos);
  if (bLen < BigInt(minLen) || bLen > rem) {
    throw new Error(`omnibuf: invalid byteLen ${bLen} at ${pos}`);
  }
  const lenNum = Number(bLen);
  return [data.subarray(pos, pos + lenNum), pos + lenNum];
}

// ============================================================================
// IEEE-754 Float32 Shortest Decimal Representation (Ryū 32-bit matching Go)
// ============================================================================

const f32ScratchBuf = new ArrayBuffer(8);
const f32ScratchView = new DataView(f32ScratchBuf);

export function float32Bits(v: number): number {
  f32ScratchView.setFloat32(0, v, true);
  return f32ScratchView.getUint32(0, true);
}

export function float32FromBits(bits: number): number {
  f32ScratchView.setUint32(0, bits >>> 0, true);
  return f32ScratchView.getFloat32(0, true);
}

export function float64Bits(v: number): bigint {
  f32ScratchView.setFloat64(0, v, true);
  return f32ScratchView.getBigUint64(0, true);
}

export function float64FromBits(bits: bigint): number {
  f32ScratchView.setBigUint64(0, BigInt.asUintN(64, bits), true);
  return f32ScratchView.getFloat64(0, true);
}

export function readFloat32At(buf: Uint8Array, pos: number): number {
  const bits =
    (buf[pos]! | (buf[pos + 1]! << 8) | (buf[pos + 2]! << 16) | (buf[pos + 3]! << 24)) >>> 0;
  f32ScratchView.setUint32(0, bits, true);
  return f32ScratchView.getFloat32(0, true);
}

export function readFloat64At(buf: Uint8Array, pos: number): number {
  const lo =
    (buf[pos]! | (buf[pos + 1]! << 8) | (buf[pos + 2]! << 16) | (buf[pos + 3]! << 24)) >>> 0;
  const hi =
    (buf[pos + 4]! | (buf[pos + 5]! << 8) | (buf[pos + 6]! << 16) | (buf[pos + 7]! << 24)) >>> 0;
  f32ScratchView.setUint32(0, lo, true);
  f32ScratchView.setUint32(4, hi, true);
  return f32ScratchView.getFloat64(0, true);
}

/**
 * Formats a 32-bit IEEE-754 float value as a JS number whose decimal representation
 * is the shortest string that rounds back to the exact same 32-bit float via `Math.fround`
 * (matching Go's `strconv.FormatFloat(float64(f32), 'g', -1, 32)`).
 */
export function roundFloat32Shortest(f32: number): number {
  if (!Number.isFinite(f32) || f32 === 0) {
    return f32;
  }
  const target = Math.fround(f32);
  const abs = Math.abs(target);
  if (abs >= 0.1 && abs < 100) {
    if ((target | 0) === target) {
      return target;
    }
    const r4 = Math.round(target * 1e4) / 1e4;
    if (Math.fround(r4) === target) {
      const r2 = Math.round(target * 1e2) / 1e2;
      if (Math.fround(r2) === target) {
        const r1 = Math.round(target * 10) / 10;
        if (Math.fround(r1) === target) return r1;
        return r2;
      }
      const r3 = Math.round(target * 1e3) / 1e3;
      if (Math.fround(r3) === target) return r3;
      return r4;
    }
  }
  for (let p = 1; p <= 9; p++) {
    const candidate = Number(target.toPrecision(p));
    if (Math.fround(candidate) === target) {
      return candidate;
    }
  }
  return target;
}
