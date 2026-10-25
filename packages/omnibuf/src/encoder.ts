// ============================================================================
// Single-Pass OmniBuf Forward Encoder with 2-Byte Length Backpatching
// ============================================================================

import {
  MaxNestingDepth,
  WireBoolFalse,
  WireBoolTrue,
  WireBytes,
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
  encodeZigZag,
  encodeZigZagNumber,
  getStringCodec,
  writeVarintAt,
} from './wire.js';

/**
 * Encodes the 1-byte WireMap type header: `(KeyWireType << 4) | ValWireType`.
 */
export function mapHeaderByte(keyWT: number, valWT: number): number {
  return ((keyWT & 0x0f) << 4) | (valWT & 0x0f);
}

/**
 * Encoder encodes OmniBuf messages into a reusable contiguous byte buffer in a single forward pass.
 */
export class Encoder {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;
  private readonly lenStack = new Int32Array(MaxNestingDepth * 2 + 8);
  private depth = 0;

  constructor(initialCapacity = 512) {
    const cap = Math.max(64, initialCapacity);
    this.buf = new Uint8Array(cap);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  /**
   * Clears the encoder buffer for zero-allocation reuse.
   */
  reset(): void {
    this.pos = 0;
    this.depth = 0;
  }

  /**
   * Begins a new message in the slab buffer, allocating a fresh 8KB slab if remaining capacity is low.
   */
  beginMessage(minRemaining = 1024): number {
    this.depth = 0;
    if (this.buf.length - this.pos < minRemaining || this.buf.length > 16384) {
      this.buf = new Uint8Array(8192);
      this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      this.pos = 0;
    }
    return this.pos;
  }

  /**
   * Returns a slice view `[startPos, this.pos)` of the encoded message in the slab.
   */
  endMessage(startPos: number): Uint8Array {
    return this.buf.subarray(startPos, this.pos);
  }

  /**
   * Returns a subarray view of the encoded packet bytes (valid until the next write/reset).
   */
  bytesView(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  /**
   * Returns a standalone copy of the encoded packet bytes.
   */
  bytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  /**
   * Alias for `bytes()`.
   */
  finish(): Uint8Array {
    return this.bytes();
  }

  /**
   * Ensures at least `additional` bytes are available in the backing buffer.
   */
  ensureCapacity(additional: number): void {
    const needed = this.pos + additional;
    if (needed <= this.buf.length) return;
    let nextCap = this.buf.length * 2;
    while (nextCap < needed) {
      nextCap *= 2;
    }
    const nextBuf = new Uint8Array(nextCap);
    nextBuf.set(this.buf.subarray(0, this.pos), 0);
    this.buf = nextBuf;
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  /**
   * Appends pre-encoded raw bytes (such as a pre-encoded Field #0 SchemaMeta block).
   */
  writeRaw(raw: Uint8Array): void {
    this.ensureCapacity(raw.length);
    this.buf.set(raw, this.pos);
    this.pos += raw.length;
  }

  /**
   * Appends a single byte.
   */
  writeByte(b: number): void {
    this.ensureCapacity(1);
    this.buf[this.pos++] = b & 0xff;
  }

  /**
   * Appends a Prefix-Varint (TZCNT) value without a tag.
   */
  writeRawVarint(v: number | bigint): void {
    if (this.pos + 9 > this.buf.length) {
      this.ensureCapacity(9);
    }
    if (typeof v === 'number' && v >= 0 && v <= 536870911) {
      const iv = Math.trunc(v);
      const buf = this.buf;
      const p = this.pos;
      if (iv <= 127) {
        buf[p] = (iv << 1) | 1;
        this.pos = p + 1;
        return;
      }
      if (iv <= 16383) {
        const u16 = (iv << 2) | 2;
        buf[p] = u16 & 0xff;
        buf[p + 1] = (u16 >>> 8) & 0xff;
        this.pos = p + 2;
        return;
      }
      const w32 = ((iv << 3) | 4) >>> 0;
      buf[p] = w32 & 0xff;
      buf[p + 1] = (w32 >>> 8) & 0xff;
      buf[p + 2] = (w32 >>> 16) & 0xff;
      buf[p + 3] = (w32 >>> 24) & 0xff;
      this.pos = p + 4;
      return;
    }
    this.pos = writeVarintAt(this.buf, this.pos, v);
  }

  /**
   * Appends a raw string payload `[ByteLen (Prefix-Varint)][UTF-8 Bytes]` without a tag.
   */
  writeRawStringPayload(s: string): void {
    const n = s.length;
    if (n === 0) {
      this.ensureCapacity(1);
      this.buf[this.pos++] = 0x01; // Prefix-Varint(0)
      return;
    }
    if (n <= 42) {
      // Single-pass UTF-8 fast path: max byte length is 42 * 3 = 126 <= 127 (1-byte Prefix-Varint)
      if (this.pos + 1 + n * 3 > this.buf.length) {
        this.ensureCapacity(1 + n * 3);
      }
      const buf = this.buf;
      const lenPos = this.pos;
      let p = lenPos + 1;
      for (let i = 0; i < n; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) {
          buf[p++] = c;
        } else if (c < 0x800) {
          buf[p++] = 0xc0 | (c >> 6);
          buf[p++] = 0x80 | (c & 0x3f);
        } else if (
          c >= 0xd800 &&
          c <= 0xdbff &&
          i + 1 < n &&
          s.charCodeAt(i + 1) >= 0xdc00 &&
          s.charCodeAt(i + 1) <= 0xdfff
        ) {
          const cp = 0x10000 + (((c & 0x3ff) << 10) | (s.charCodeAt(++i) & 0x3ff));
          buf[p++] = 0xf0 | (cp >> 18);
          buf[p++] = 0x80 | ((cp >> 12) & 0x3f);
          buf[p++] = 0x80 | ((cp >> 6) & 0x3f);
          buf[p++] = 0x80 | (cp & 0x3f);
        } else if (c >= 0xd800 && c <= 0xdfff) {
          buf[p++] = 0xef;
          buf[p++] = 0xbf;
          buf[p++] = 0xbd;
        } else {
          buf[p++] = 0xe0 | (c >> 12);
          buf[p++] = 0x80 | ((c >> 6) & 0x3f);
          buf[p++] = 0x80 | (c & 0x3f);
        }
      }
      const byteLen = p - (lenPos + 1);
      buf[lenPos] = (byteLen << 1) | 1;
      this.pos = p;
      return;
    }
    const codec = getStringCodec();
    if (codec.encodeInto) {
      const byteLen = codec.byteLength(s);
      this.ensureCapacity(9 + byteLen);
      this.pos = writeVarintAt(this.buf, this.pos, byteLen);
      const written = codec.encodeInto(s, this.buf, this.pos);
      this.pos += written;
      return;
    }
    const utf8 = codec.encode(s);
    this.ensureCapacity(9 + utf8.length);
    this.pos = writeVarintAt(this.buf, this.pos, utf8.length);
    this.buf.set(utf8, this.pos);
    this.pos += utf8.length;
  }

  /**
   * Appends a raw bytes payload `[ByteLen (Prefix-Varint)][Raw Bytes]` without a tag.
   */
  writeRawBytesPayload(b: Uint8Array): void {
    this.ensureCapacity(9 + b.length);
    this.pos = writeVarintAt(this.buf, this.pos, b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  /**
   * Appends a raw 4-byte little-endian uint32 without a tag.
   */
  writeRawFixed32(v: number): void {
    this.ensureCapacity(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }

  /**
   * Appends a raw 4-byte little-endian IEEE-754 float32 without a tag.
   */
  writeRawFloat32(v: number): void {
    this.ensureCapacity(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  /**
   * Appends a raw 8-byte little-endian uint64/int64 without a tag.
   */
  writeRawFixed64(v: number | bigint): void {
    this.ensureCapacity(8);
    const u =
      typeof v === 'bigint' ? BigInt.asUintN(64, v) : BigInt.asUintN(64, BigInt(Math.trunc(v)));
    this.view.setBigUint64(this.pos, u, true);
    this.pos += 8;
  }

  /**
   * Appends a raw 8-byte little-endian IEEE-754 float64 without a tag.
   */
  writeRawFloat64(v: number): void {
    this.ensureCapacity(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  /**
   * Writes a field tag `(fieldNum << 4) | wireType` as a Prefix-Varint.
   */
  writeTag(fieldNum: number, wireType: number): void {
    if (!Number.isInteger(fieldNum) || fieldNum < 0 || fieldNum > 0xffffffff) {
      throw new Error(`omnibuf: invalid field number ${fieldNum}`);
    }
    const tag = fieldNum * 16 + (wireType & 0x0f);
    if (tag <= 127) {
      this.ensureCapacity(1);
      this.buf[this.pos++] = ((tag << 1) | 1) & 0xff;
      return;
    }
    if (tag <= 16383) {
      this.ensureCapacity(2);
      const u16 = ((tag << 2) | 2) & 0xffff;
      this.buf[this.pos++] = u16 & 0xff;
      this.buf[this.pos++] = (u16 >>> 8) & 0xff;
      return;
    }
    this.writeRawVarint(tag);
  }

  /**
   * Reserves a 2-byte Prefix-Varint container length slot on `lenStack`.
   */
  beginContainer(): void {
    this.ensureCapacity(2);
    this.lenStack[this.depth++] = this.pos;
    this.buf[this.pos++] = 0;
    this.buf[this.pos++] = 0;
  }

  /**
   * Backpatches the most recently opened container length slot.
   * Expands to 4-byte or 9-byte Prefix-Varint if the container exceeds 16,383 bytes.
   */
  endContainer(): void {
    this.depth--;
    const lenPos = this.lenStack[this.depth]!;
    const subLen = this.pos - (lenPos + 2);
    if (subLen <= 16383) {
      const u16 = ((subLen << 2) | 2) & 0xffff;
      this.buf[lenPos] = u16 & 0xff;
      this.buf[lenPos + 1] = (u16 >>> 8) & 0xff;
      return;
    }
    if (subLen <= 536870911) {
      this.ensureCapacity(2);
      this.buf.copyWithin(lenPos + 4, lenPos + 2, this.pos);
      const w32 = ((subLen << 3) | 4) >>> 0;
      this.buf[lenPos] = w32 & 0xff;
      this.buf[lenPos + 1] = (w32 >>> 8) & 0xff;
      this.buf[lenPos + 2] = (w32 >>> 16) & 0xff;
      this.buf[lenPos + 3] = (w32 >>> 24) & 0xff;
      this.pos += 2;
      return;
    }
    this.ensureCapacity(7);
    this.buf.copyWithin(lenPos + 9, lenPos + 2, this.pos);
    writeVarintAt(this.buf, lenPos, BigInt(subLen));
    this.pos += 7;
  }

  // ==========================================================================
  // Scalar Writers
  // ==========================================================================

  /**
   * Writes an unsigned integer field (`WireUint = 0`).
   */
  writeUint(fieldNum: number, v: number | bigint): void {
    if (
      fieldNum >= 1 &&
      fieldNum <= 1023 &&
      typeof v === 'number' &&
      v >= 0 &&
      v <= 9007199254740991
    ) {
      if (this.pos + 11 > this.buf.length) {
        this.ensureCapacity(11);
      }
      const buf = this.buf;
      let p = this.pos;
      const tag = fieldNum << 4;
      if (tag <= 127) {
        buf[p++] = (tag << 1) | 1;
      } else {
        const t16 = (tag << 2) | 2;
        buf[p++] = t16 & 0xff;
        buf[p++] = (t16 >>> 8) & 0xff;
      }
      if (v <= 536870911) {
        const iv = v >>> 0;
        if (iv <= 127) {
          buf[p++] = (iv << 1) | 1;
        } else if (iv <= 16383) {
          const u16 = (iv << 2) | 2;
          buf[p++] = u16 & 0xff;
          buf[p++] = (u16 >>> 8) & 0xff;
        } else {
          const w32 = ((iv << 3) | 4) >>> 0;
          buf[p++] = w32 & 0xff;
          buf[p++] = (w32 >>> 8) & 0xff;
          buf[p++] = (w32 >>> 16) & 0xff;
          buf[p++] = (w32 >>> 24) & 0xff;
        }
      } else {
        const lo = v >>> 0;
        const hi = Math.floor(v / 0x100000000) >>> 0;
        buf[p++] = 0x00;
        buf[p++] = lo & 0xff;
        buf[p++] = (lo >>> 8) & 0xff;
        buf[p++] = (lo >>> 16) & 0xff;
        buf[p++] = (lo >>> 24) & 0xff;
        buf[p++] = hi & 0xff;
        buf[p++] = (hi >>> 8) & 0xff;
        buf[p++] = (hi >>> 16) & 0xff;
        buf[p++] = (hi >>> 24) & 0xff;
      }
      this.pos = p;
      return;
    }
    this.writeTag(fieldNum, WireUint);
    this.writeRawVarint(v);
  }

  /**
   * Writes a ZigZag-encoded signed integer field (`WireSint = 12`).
   */
  writeInt(fieldNum: number, v: number | bigint): void {
    if (
      fieldNum >= 1 &&
      fieldNum <= 1023 &&
      typeof v === 'number' &&
      v >= -268435456 &&
      v <= 268435455
    ) {
      if (this.pos + 6 > this.buf.length) {
        this.ensureCapacity(6);
      }
      const buf = this.buf;
      let p = this.pos;
      const tag = (fieldNum << 4) | WireSint;
      if (tag <= 127) {
        buf[p++] = (tag << 1) | 1;
      } else {
        const t16 = (tag << 2) | 2;
        buf[p++] = t16 & 0xff;
        buf[p++] = (t16 >>> 8) & 0xff;
      }
      const iv = ((v << 1) ^ (v >> 31)) >>> 0;
      if (iv <= 127) {
        buf[p++] = (iv << 1) | 1;
      } else if (iv <= 16383) {
        const u16 = (iv << 2) | 2;
        buf[p++] = u16 & 0xff;
        buf[p++] = (u16 >>> 8) & 0xff;
      } else {
        const w32 = ((iv << 3) | 4) >>> 0;
        buf[p++] = w32 & 0xff;
        buf[p++] = (w32 >>> 8) & 0xff;
        buf[p++] = (w32 >>> 16) & 0xff;
        buf[p++] = (w32 >>> 24) & 0xff;
      }
      this.pos = p;
      return;
    }
    this.writeTag(fieldNum, WireSint);
    this.writeRawVarint(encodeZigZagNumber(v));
  }

  /**
   * Writes a boolean field using 0 payload bytes (`WireBoolTrue = 2` or `WireBoolFalse = 1`).
   */
  writeBool(fieldNum: number, v: boolean): void {
    const wt = v ? WireBoolTrue : WireBoolFalse;
    if (fieldNum >= 1 && fieldNum <= 7) {
      if (this.pos + 1 > this.buf.length) {
        this.ensureCapacity(1);
      }
      this.buf[this.pos++] = (((fieldNum << 4) | wt) << 1) | 1;
      return;
    }
    this.writeTag(fieldNum, wt);
  }

  /**
   * Writes a 4-byte little-endian uint32/int32 field (`WireFixed32 = 10`).
   */
  writeFixed32(fieldNum: number, v: number): void {
    this.writeTag(fieldNum, WireFixed32);
    this.writeRawFixed32(v);
  }

  /**
   * Writes a 4-byte IEEE-754 float32 field (`WireFixed32 = 10`).
   */
  writeFloat32(fieldNum: number, v: number): void {
    if (fieldNum >= 1 && fieldNum <= 7) {
      if (this.pos + 5 > this.buf.length) {
        this.ensureCapacity(5);
      }
      this.buf[this.pos++] = (((fieldNum << 4) | WireFixed32) << 1) | 1;
      this.view.setFloat32(this.pos, v, true);
      this.pos += 4;
      return;
    }
    this.writeTag(fieldNum, WireFixed32);
    this.writeRawFloat32(v);
  }

  /**
   * Writes an 8-byte little-endian uint64/int64 field (`WireFixed64 = 11`).
   */
  writeFixed64(fieldNum: number, v: number | bigint): void {
    this.writeTag(fieldNum, WireFixed64);
    this.writeRawFixed64(v);
  }

  /**
   * Writes an 8-byte IEEE-754 float64 field (`WireFixed64 = 11`).
   */
  writeFloat64(fieldNum: number, v: number): void {
    if (fieldNum >= 1 && fieldNum <= 7) {
      if (this.pos + 9 > this.buf.length) {
        this.ensureCapacity(9);
      }
      this.buf[this.pos++] = (((fieldNum << 4) | WireFixed64) << 1) | 1;
      this.view.setFloat64(this.pos, v, true);
      this.pos += 8;
      return;
    }
    this.writeTag(fieldNum, WireFixed64);
    this.writeRawFloat64(v);
  }

  /**
   * Writes a UTF-8 string field (`WireString = 3`).
   */
  writeString(fieldNum: number, s: string): void {
    this.writeTag(fieldNum, WireString);
    this.writeRawStringPayload(s);
  }

  /**
   * Writes a raw byte slice field (`WireBytes = 4`).
   */
  writeBytes(fieldNum: number, b: Uint8Array): void {
    this.writeTag(fieldNum, WireBytes);
    this.writeRawBytesPayload(b);
  }

  // ==========================================================================
  // Packed & Length-Prefixed Array Writers
  // ==========================================================================

  /**
   * Writes a repeated string array (`WireStringArr = 6`) with an outer backpatched 2B length prefix.
   */
  writeStringArr(fieldNum: number, items: readonly string[]): void {
    this.writeTag(fieldNum, WireStringArr);
    this.beginContainer();
    this.writeRawVarint(items.length);
    for (let i = 0; i < items.length; i++) {
      this.writeRawStringPayload(items[i]!);
    }
    this.endContainer();
  }

  /**
   * Writes a repeated bytes array (`WireStringArr = 6`) with an outer backpatched 2B length prefix.
   */
  writeBytesArr(fieldNum: number, items: readonly Uint8Array[]): void {
    this.writeTag(fieldNum, WireStringArr);
    this.beginContainer();
    this.writeRawVarint(items.length);
    for (let i = 0; i < items.length; i++) {
      this.writeRawBytesPayload(items[i]!);
    }
    this.endContainer();
  }

  /**
   * Writes a packed unsigned integer array (`WireUintArr = 7`) with an outer backpatched 2B length prefix.
   */
  writeUint32Arr(fieldNum: number, items: ArrayLike<number>): void {
    this.writeTag(fieldNum, WireUintArr);
    this.beginContainer();
    this.writeRawVarint(items.length);
    for (let i = 0; i < items.length; i++) {
      this.writeRawVarint(items[i]! >>> 0);
    }
    this.endContainer();
  }

  /**
   * Writes a packed unsigned integer array (`WireUintArr = 7`) supporting `number | bigint` elements.
   */
  writeUintArr(fieldNum: number, items: ArrayLike<number | bigint>): void {
    this.writeTag(fieldNum, WireUintArr);
    this.beginContainer();
    this.writeRawVarint(items.length);
    for (let i = 0; i < items.length; i++) {
      const v = items[i]!;
      this.writeRawVarint(typeof v === 'bigint' ? BigInt.asUintN(64, v) : v);
    }
    this.endContainer();
  }

  /**
   * Writes a packed boolean array (`WireUintArr = 7`) with 0/1 Prefix-Varint elements.
   */
  writeBoolArr(fieldNum: number, items: readonly boolean[]): void {
    this.writeTag(fieldNum, WireUintArr);
    this.beginContainer();
    this.writeRawVarint(items.length);
    for (let i = 0; i < items.length; i++) {
      this.writeRawVarint(items[i] ? 1 : 0);
    }
    this.endContainer();
  }

  /**
   * Writes a packed ZigZag signed integer array (`WireSintArr = 13`) with an outer backpatched 2B length prefix.
   */
  writeSintArr(fieldNum: number, items: ArrayLike<number | bigint>): void {
    this.writeTag(fieldNum, WireSintArr);
    this.beginContainer();
    this.writeRawVarint(items.length);
    for (let i = 0; i < items.length; i++) {
      const v = items[i]!;
      this.writeRawVarint(typeof v === 'bigint' ? encodeZigZag(v) : encodeZigZagNumber(v));
    }
    this.endContainer();
  }

  /**
   * Writes a packed float32 array (`WireFixedArr = 14`, `ElemType = WireFixed32`).
   * Note: because fixed-width element byte count is known upfront (`1 + len * 4`),
   * uses minimal Prefix-Varint length matching Go's `encodeFixed32Arr`.
   */
  writeFloat32Arr(fieldNum: number, items: ArrayLike<number>): void {
    this.writeTag(fieldNum, WireFixedArr);
    this.writeRawVarint(1 + items.length * 4);
    this.writeByte(WireFixed32);
    this.ensureCapacity(items.length * 4);
    for (let i = 0; i < items.length; i++) {
      this.view.setFloat32(this.pos, items[i]!, true);
      this.pos += 4;
    }
  }

  /**
   * Writes a packed fixed32/sfixed32 array (`WireFixedArr = 14`, `ElemType = WireFixed32`).
   */
  writeFixed32Arr(fieldNum: number, items: ArrayLike<number>): void {
    this.writeTag(fieldNum, WireFixedArr);
    this.writeRawVarint(1 + items.length * 4);
    this.writeByte(WireFixed32);
    this.ensureCapacity(items.length * 4);
    for (let i = 0; i < items.length; i++) {
      this.view.setUint32(this.pos, items[i]! >>> 0, true);
      this.pos += 4;
    }
  }

  /**
   * Writes a packed float64 array (`WireFixedArr = 14`, `ElemType = WireFixed64`).
   * Uses minimal Prefix-Varint length (`1 + len * 8`) matching Go's `encodeFixed64Arr`.
   */
  writeFloat64Arr(fieldNum: number, items: ArrayLike<number>): void {
    this.writeTag(fieldNum, WireFixedArr);
    this.writeRawVarint(1 + items.length * 8);
    this.writeByte(WireFixed64);
    this.ensureCapacity(items.length * 8);
    for (let i = 0; i < items.length; i++) {
      this.view.setFloat64(this.pos, items[i]!, true);
      this.pos += 8;
    }
  }

  /**
   * Writes a packed fixed64/sfixed64 array (`WireFixedArr = 14`, `ElemType = WireFixed64`).
   */
  writeFixed64Arr(fieldNum: number, items: ArrayLike<number | bigint>): void {
    this.writeTag(fieldNum, WireFixedArr);
    this.writeRawVarint(1 + items.length * 8);
    this.writeByte(WireFixed64);
    this.ensureCapacity(items.length * 8);
    for (let i = 0; i < items.length; i++) {
      const v = items[i]!;
      const u =
        typeof v === 'bigint' ? BigInt.asUintN(64, v) : BigInt.asUintN(64, BigInt(Math.trunc(v)));
      this.view.setBigUint64(this.pos, u, true);
      this.pos += 8;
    }
  }

  // ==========================================================================
  // Nested Sub-Message & Sub-Message Array Writers
  // ==========================================================================

  /**
   * Starts a nested sub-message (`WireSubMsg = 5`) in a single pass by reserving a 2-byte length slot.
   */
  beginSubMsg(fieldNum: number): void {
    this.writeTag(fieldNum, WireSubMsg);
    this.beginContainer();
  }

  /**
   * Finishes the current nested sub-message and backpatches its byte length.
   */
  endSubMsg(): void {
    this.endContainer();
  }

  /**
   * Starts a repeated sub-message array (`WireSubMsgArr = 8`) in a single pass.
   */
  beginSubMsgArr(fieldNum: number): void {
    this.writeTag(fieldNum, WireSubMsgArr);
    this.beginContainer();
  }

  /**
   * Starts the next element inside an open `WireSubMsgArr` by reserving its 2-byte length prefix.
   */
  beginSubMsgElem(): void {
    this.beginContainer();
  }

  /**
   * Finishes the current element inside an open `WireSubMsgArr` and backpatches its length.
   */
  endSubMsgElem(): void {
    this.endContainer();
  }

  /**
   * Finishes the open `WireSubMsgArr` and backpatches its total byte length.
   */
  endSubMsgArr(): void {
    this.endContainer();
  }

  // ==========================================================================
  // Map Writers (WireMap = 9)
  // ==========================================================================

  /**
   * Writes a `map<string, uint64>` (`WireMap = 9`) in a single pass.
   */
  writeMapStringUint(
    fieldNum: number,
    m: ReadonlyMap<string, number | bigint> | Readonly<Record<string, number | bigint>>,
    deterministic = false,
  ): void {
    this.writeTag(fieldNum, WireMap);
    this.beginContainer();
    this.writeByte(mapHeaderByte(WireString, WireUint));

    const entries: [string, number | bigint][] =
      m instanceof Map ? Array.from(m.entries()) : Object.entries(m);

    this.writeRawVarint(entries.length);
    if (deterministic && entries.length > 1) {
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    }
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i]!;
      this.writeRawStringPayload(k);
      this.writeRawVarint(typeof v === 'bigint' ? BigInt.asUintN(64, v) : v);
    }
    this.endContainer();
  }

  /**
   * Writes a `map<string, uint64>` (`WireMap = 9`) with keys sorted in lexicographical order.
   */
  writeMapStringUintDeterministic(
    fieldNum: number,
    m: ReadonlyMap<string, number | bigint> | Readonly<Record<string, number | bigint>>,
  ): void {
    this.writeMapStringUint(fieldNum, m, true);
  }
}
