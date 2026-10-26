// ============================================================================
// Single-Pass OmniBuf Forward Encoder with 2-Byte Length Backpatching
// ============================================================================

import {
  MaxNestingDepth,
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
  encodeZigZag,
  encodeZigZagNumber,
  getStringCodec,
  mapHeaderByte,
  writeVarintAt,
} from './wire.js';

export { mapHeaderByte };

/**
 * Encoder encodes OmniBuf messages into a reusable contiguous byte buffer in a single forward pass.
 */
export class Encoder {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;
  private readonly lenStack = new Int32Array(MaxNestingDepth * 2 + 8);
  private readonly elemCountStack = new Int32Array(MaxNestingDepth * 2 + 8);
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
      this.buf = new Uint8Array(Math.max(8192, minRemaining));
      this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      this.pos = 0;
    }
    return this.pos;
  }

  /**
   * Returns a standalone `Uint8Array` copy of `[startPos, this.pos)` in the slab.
   */
  endMessage(startPos: number): Uint8Array {
    return this.buf.slice(startPos, this.pos);
  }

  /**
   * Returns a zero-copy subarray view `[startPos, this.pos)` of the encoded message in the slab.
   * Only valid until the slab region is overwritten or reset.
   */
  endMessageView(startPos: number): Uint8Array {
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
    if (!Number.isInteger(fieldNum) || fieldNum < 0 || fieldNum > 536870911) {
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

  private patchReservedVarint(pos: number, v: number): void {
    if (v <= 127) {
      this.buf[pos] = ((v << 1) | 1) & 0xff;
      return;
    }
    if (v <= 16383) {
      this.ensureCapacity(1);
      this.buf.copyWithin(pos + 2, pos + 1, this.pos);
      const u16 = ((v << 2) | 2) & 0xffff;
      this.buf[pos] = u16 & 0xff;
      this.buf[pos + 1] = (u16 >>> 8) & 0xff;
      this.pos += 1;
      return;
    }
    if (v <= 536870911) {
      this.ensureCapacity(3);
      this.buf.copyWithin(pos + 4, pos + 1, this.pos);
      const w32 = ((v << 3) | 4) >>> 0;
      this.buf[pos] = w32 & 0xff;
      this.buf[pos + 1] = (w32 >>> 8) & 0xff;
      this.buf[pos + 2] = (w32 >>> 16) & 0xff;
      this.buf[pos + 3] = (w32 >>> 24) & 0xff;
      this.pos += 3;
      return;
    }
    this.ensureCapacity(8);
    this.buf.copyWithin(pos + 9, pos + 1, this.pos);
    writeVarintAt(this.buf, pos, BigInt(v));
    this.pos += 8;
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
   * Writes a 4-byte little-endian uint32 field (`WireFixed32 = 4`).
   */
  writeFixed32(fieldNum: number, v: number): void {
    this.writeTag(fieldNum, WireFixed32);
    this.writeRawFixed32(v);
  }

  /**
   * Writes a 4-byte little-endian int32 field (`WireSfixed32 = 6`).
   */
  writeSfixed32(fieldNum: number, v: number): void {
    this.writeTag(fieldNum, WireSfixed32);
    this.writeRawFixed32(v);
  }

  /**
   * Writes a 4-byte IEEE-754 float32 field (`WireFloat32 = 8`).
   */
  writeFloat32(fieldNum: number, v: number): void {
    if (fieldNum >= 1 && fieldNum <= 7) {
      if (this.pos + 5 > this.buf.length) {
        this.ensureCapacity(5);
      }
      this.buf[this.pos++] = (((fieldNum << 4) | WireFloat32) << 1) | 1;
      this.view.setFloat32(this.pos, v, true);
      this.pos += 4;
      return;
    }
    this.writeTag(fieldNum, WireFloat32);
    this.writeRawFloat32(v);
  }

  /**
   * Writes an 8-byte little-endian uint64 field (`WireFixed64 = 5`).
   */
  writeFixed64(fieldNum: number, v: number | bigint): void {
    this.writeTag(fieldNum, WireFixed64);
    this.writeRawFixed64(v);
  }

  /**
   * Writes an 8-byte little-endian int64 field (`WireSfixed64 = 7`).
   */
  writeSfixed64(fieldNum: number, v: number | bigint): void {
    this.writeTag(fieldNum, WireSfixed64);
    this.writeRawFixed64(v);
  }

  /**
   * Writes an 8-byte IEEE-754 float64 field (`WireFloat64 = 9`).
   */
  writeFloat64(fieldNum: number, v: number): void {
    if (fieldNum >= 1 && fieldNum <= 7) {
      if (this.pos + 9 > this.buf.length) {
        this.ensureCapacity(9);
      }
      this.buf[this.pos++] = (((fieldNum << 4) | WireFloat64) << 1) | 1;
      this.view.setFloat64(this.pos, v, true);
      this.pos += 8;
      return;
    }
    this.writeTag(fieldNum, WireFloat64);
    this.writeRawFloat64(v);
  }

  /**
   * Writes a UTF-8 string field (`WireString = 10`).
   */
  writeString(fieldNum: number, s: string): void {
    this.writeTag(fieldNum, WireString);
    this.writeRawStringPayload(s);
  }

  /**
   * Writes a raw byte slice field (`WireBytes = 11`).
   */
  writeBytes(fieldNum: number, b: Uint8Array): void {
    this.writeTag(fieldNum, WireBytes);
    this.writeRawBytesPayload(b);
  }

  // ==========================================================================
  // Composable Array Writers (WireArray = 13)
  // ==========================================================================

  /**
   * Writes a repeated string array (`WireArray = 13`, `ElementType = WireString = 10`) with an outer backpatched 2B length prefix.
   */
  writeStringArr(fieldNum: number, items: readonly string[]): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.writeByte(WireString);
    this.writeRawVarint(items.length);
    for (let i = 0; i < items.length; i++) {
      this.writeRawStringPayload(items[i]!);
    }
    this.endContainer();
  }

  /**
   * Writes a repeated bytes array (`WireArray = 13`, `ElementType = WireBytes = 11`) with an outer backpatched 2B length prefix.
   */
  writeBytesArr(fieldNum: number, items: readonly Uint8Array[]): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.writeByte(WireBytes);
    this.writeRawVarint(items.length);
    for (let i = 0; i < items.length; i++) {
      this.writeRawBytesPayload(items[i]!);
    }
    this.endContainer();
  }

  /**
   * Writes a packed unsigned integer array (`WireArray = 13`, `ElementType = WireUint = 0`) with an outer backpatched 2B length prefix.
   */
  writeUint32Arr(fieldNum: number, items: ArrayLike<number>): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.writeByte(WireUint);
    this.writeRawVarint(items.length);
    for (let i = 0; i < items.length; i++) {
      this.writeRawVarint(items[i]! >>> 0);
    }
    this.endContainer();
  }

  /**
   * Writes a packed unsigned integer array (`WireArray = 13`, `ElementType = WireUint = 0`) supporting `number | bigint` elements.
   */
  writeUintArr(fieldNum: number, items: ArrayLike<number | bigint>): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.writeByte(WireUint);
    this.writeRawVarint(items.length);
    for (let i = 0; i < items.length; i++) {
      const v = items[i]!;
      this.writeRawVarint(typeof v === 'bigint' ? BigInt.asUintN(64, v) : v);
    }
    this.endContainer();
  }

  /**
   * Writes a packed boolean array (`WireArray = 13`, `ElementType = WireBoolFalse = 2`) with 1-byte `0x00`/`0x01` elements.
   */
  writeBoolArr(fieldNum: number, items: readonly boolean[]): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.writeByte(WireBoolFalse);
    this.writeRawVarint(items.length);
    this.ensureCapacity(items.length);
    for (let i = 0; i < items.length; i++) {
      this.buf[this.pos++] = items[i] ? 1 : 0;
    }
    this.endContainer();
  }

  /**
   * Writes a packed ZigZag signed integer array (`WireArray = 13`, `ElementType = WireSint = 1`) with an outer backpatched 2B length prefix.
   */
  writeSintArr(fieldNum: number, items: ArrayLike<number | bigint>): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.writeByte(WireSint);
    this.writeRawVarint(items.length);
    for (let i = 0; i < items.length; i++) {
      const v = items[i]!;
      this.writeRawVarint(typeof v === 'bigint' ? encodeZigZag(v) : encodeZigZagNumber(v));
    }
    this.endContainer();
  }

  /**
   * Writes a packed float32 array (`WireArray = 13`, `ElementType = WireFloat32 = 8`).
   */
  writeFloat32Arr(fieldNum: number, items: ArrayLike<number>): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.writeByte(WireFloat32);
    this.writeRawVarint(items.length);
    this.ensureCapacity(items.length * 4);
    for (let i = 0; i < items.length; i++) {
      this.view.setFloat32(this.pos, items[i]!, true);
      this.pos += 4;
    }
    this.endContainer();
  }

  /**
   * Writes a packed fixed32 array (`WireArray = 13`, `ElementType = WireFixed32 = 4`).
   */
  writeFixed32Arr(fieldNum: number, items: ArrayLike<number>): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.writeByte(WireFixed32);
    this.writeRawVarint(items.length);
    this.ensureCapacity(items.length * 4);
    for (let i = 0; i < items.length; i++) {
      this.view.setUint32(this.pos, items[i]! >>> 0, true);
      this.pos += 4;
    }
    this.endContainer();
  }

  /**
   * Writes a packed sfixed32 array (`WireArray = 13`, `ElementType = WireSfixed32 = 6`).
   */
  writeSfixed32Arr(fieldNum: number, items: ArrayLike<number>): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.writeByte(WireSfixed32);
    this.writeRawVarint(items.length);
    this.ensureCapacity(items.length * 4);
    for (let i = 0; i < items.length; i++) {
      this.view.setUint32(this.pos, items[i]! >>> 0, true);
      this.pos += 4;
    }
    this.endContainer();
  }

  /**
   * Writes a packed float64 array (`WireArray = 13`, `ElementType = WireFloat64 = 9`).
   */
  writeFloat64Arr(fieldNum: number, items: ArrayLike<number>): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.writeByte(WireFloat64);
    this.writeRawVarint(items.length);
    this.ensureCapacity(items.length * 8);
    for (let i = 0; i < items.length; i++) {
      this.view.setFloat64(this.pos, items[i]!, true);
      this.pos += 8;
    }
    this.endContainer();
  }

  /**
   * Writes a packed fixed64 array (`WireArray = 13`, `ElementType = WireFixed64 = 5`).
   */
  writeFixed64Arr(fieldNum: number, items: ArrayLike<number | bigint>): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.writeByte(WireFixed64);
    this.writeRawVarint(items.length);
    this.ensureCapacity(items.length * 8);
    for (let i = 0; i < items.length; i++) {
      const v = items[i]!;
      const u =
        typeof v === 'bigint' ? BigInt.asUintN(64, v) : BigInt.asUintN(64, BigInt(Math.trunc(v)));
      this.view.setBigUint64(this.pos, u, true);
      this.pos += 8;
    }
    this.endContainer();
  }

  /**
   * Writes a packed sfixed64 array (`WireArray = 13`, `ElementType = WireSfixed64 = 7`).
   */
  writeSfixed64Arr(fieldNum: number, items: ArrayLike<number | bigint>): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.writeByte(WireSfixed64);
    this.writeRawVarint(items.length);
    this.ensureCapacity(items.length * 8);
    for (let i = 0; i < items.length; i++) {
      const v = items[i]!;
      const u =
        typeof v === 'bigint' ? BigInt.asUintN(64, v) : BigInt.asUintN(64, BigInt(Math.trunc(v)));
      this.view.setBigUint64(this.pos, u, true);
      this.pos += 8;
    }
    this.endContainer();
  }

  // ==========================================================================
  // Nested Sub-Message & Sub-Message Array Writers
  // ==========================================================================

  /**
   * Starts a nested sub-message (`WireSubMsg = 12`) in a single pass by reserving a 2-byte length slot.
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
   * Starts a repeated sub-message array (`WireArray = 13`, `ElementType = WireSubMsg = 12`) in a single pass.
   */
  beginSubMsgArr(fieldNum: number): void {
    this.writeTag(fieldNum, WireArray);
    this.beginContainer();
    this.elemCountStack[this.depth - 1] = 0;
    this.writeByte(WireSubMsg);
    this.writeByte(0x01); // 1-byte Prefix-Varint(0) count slot at lenPos + 3
  }

  /**
   * Starts the next element inside an open `WireArray(WireSubMsg)` by reserving its 2-byte length prefix.
   */
  beginSubMsgElem(): void {
    if (this.depth > 0) {
      this.elemCountStack[this.depth - 1]!++;
    }
    this.beginContainer();
  }

  /**
   * Finishes the current element inside an open `WireArray(WireSubMsg)` and backpatches its length.
   */
  endSubMsgElem(): void {
    this.endContainer();
  }

  /**
   * Finishes the open `WireArray(WireSubMsg)` and backpatches its element count and total byte length.
   */
  endSubMsgArr(): void {
    const lenPos = this.lenStack[this.depth - 1]!;
    const count = this.elemCountStack[this.depth - 1]!;
    this.patchReservedVarint(lenPos + 3, count);
    this.endContainer();
  }

  // ==========================================================================
  // Map Writers (WireMap = 14)
  // ==========================================================================

  /**
   * Writes a `map<string, uint64>` (`WireMap = 14`) in a single pass.
   */
  writeMapStringUint(
    fieldNum: number,
    m: ReadonlyMap<string, number | bigint> | Readonly<Record<string, number | bigint>>,
    deterministic = false,
  ): void {
    this.writeTag(fieldNum, WireMap);
    this.beginContainer();
    this.writeByte(WireString);
    this.writeByte(WireUint);

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
