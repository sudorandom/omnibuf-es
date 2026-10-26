import {
  WireArray,
  WireBoolFalse,
  WireBoolTrue,
  WireBytes,
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
  base64ToUint8Array,
  decodeBlind,
  decodeSchemaMeta,
  decodeVarintAuto,
  decodeVarintBigInt,
  decodeZigZagAuto,
  encodeField0SchemaMeta,
  fastDecodeShortASCII,
  float32FromBits,
  float64FromBits,
  nextContainerField,
  readField0SchemaMeta,
  readLenSlice,
  roundFloat32Shortest,
  setStringCodec,
  uint8ArrayToBase64,
  type SchemaMeta,
  type StringCodec,
} from '@omnibuf/core';

export * from '@omnibuf/core';

const browserEncoder = new TextEncoder();
const browserDecoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Browser-optimized `StringCodec` using `TextEncoder.encodeInto` and `TextDecoder`.
 */
export const BrowserStringCodec: StringCodec = {
  encode(str: string): Uint8Array {
    if (str.length === 0) return new Uint8Array(0);
    return browserEncoder.encode(str);
  },
  decode(bytes: Uint8Array, start = 0, end = bytes.length): string {
    if (end <= start) return '';
    const ascii = fastDecodeShortASCII(bytes, start, end);
    if (ascii !== null) return ascii;
    return browserDecoder.decode(bytes.subarray(start, end));
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
    const res = browserEncoder.encodeInto(str, dst.subarray(offset));
    return res.written ?? 0;
  },
};

// Automatically install BrowserStringCodec when @omnibuf/web is imported in browser environments
setStringCodec(BrowserStringCodec);

/**
 * Return the human-readable name for a 4-bit OmniBuf wire type (`0..15`).
 */
export function wireTypeName(wireType: number): string {
  switch (wireType) {
    case WireUint:
      return 'uint';
    case WireSint:
      return 'sint';
    case WireBoolFalse:
      return 'bool_false';
    case WireBoolTrue:
      return 'bool_true';
    case WireFixed32:
      return 'fixed32';
    case WireFixed64:
      return 'fixed64';
    case WireSfixed32:
      return 'sfixed32';
    case WireSfixed64:
      return 'sfixed64';
    case WireFloat32:
      return 'float32';
    case WireFloat64:
      return 'float64';
    case WireString:
      return 'string';
    case WireBytes:
      return 'bytes';
    case WireSubMsg:
      return 'submsg';
    case WireArray:
      return 'array';
    case WireMap:
      return 'map';
    case WireExtended:
      return 'extended';
    default:
      return `unknown(${wireType})`;
  }
}

/**
 * Convert an OmniBuf `Uint8Array` packet into a browser `Blob` (`application/x-omnibuf`).
 */
export function toBlob(packet: Uint8Array, mimeType = 'application/x-omnibuf'): Blob {
  const copy = new Uint8Array(packet.byteLength);
  copy.set(packet);
  return new Blob([copy.buffer], { type: mimeType });
}

/**
 * Read an OmniBuf `Uint8Array` packet from a browser `Blob` or `File`.
 */
export async function fromBlob(blob: Blob): Promise<Uint8Array> {
  const ab = await blob.arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Read an OmniBuf `Uint8Array` packet from a Fetch API `Response`.
 */
export async function fromResponse(response: Response): Promise<Uint8Array> {
  if (!response.ok) {
    throw new Error(`omnibuf/web: HTTP ${response.status} ${response.statusText}`);
  }
  const ab = await response.arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Return a standalone `ArrayBuffer` containing a copy of the OmniBuf packet bytes
 * (suitable for `WebSocket.send`, `RTCDataChannel.send`, or `postMessage` transferables).
 */
export function toArrayBuffer(packet: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(packet.byteLength);
  copy.set(packet);
  return copy.buffer;
}

/**
 * Wrap an `ArrayBuffer` or `ArrayBufferView` as a `Uint8Array`.
 */
export function fromArrayBuffer(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (source instanceof Uint8Array) return source;
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  return new Uint8Array(source);
}

/**
 * Encode an OmniBuf packet to lowercase hexadecimal string.
 */
export function toHex(packet: Uint8Array): string {
  let out = '';
  for (let i = 0; i < packet.length; i++) {
    out += packet[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Decode a hexadecimal string (ignoring whitespace) into an OmniBuf `Uint8Array` packet.
 */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error('omnibuf/web: invalid hex string length');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const pair = clean.slice(i * 2, i * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
      throw new Error(`omnibuf/web: invalid hex byte at index ${i * 2}`);
    }
    out[i] = parseInt(pair, 16);
  }
  return out;
}

/**
 * Encode an OmniBuf packet to a Base64 string.
 */
export function toBase64(packet: Uint8Array): string {
  return uint8ArrayToBase64(packet);
}

/**
 * Decode a Base64 string into an OmniBuf `Uint8Array` packet.
 */
export function fromBase64(b64: string): Uint8Array {
  return base64ToUint8Array(b64);
}

/**
 * Encode an OmniBuf packet into a `data:application/x-omnibuf;base64,...` Data URL.
 */
export function toDataURL(packet: Uint8Array, mimeType = 'application/x-omnibuf'): string {
  return `data:${mimeType};base64,${uint8ArrayToBase64(packet)}`;
}

/**
 * Decode a `data:...;base64,...` Data URL into an OmniBuf `Uint8Array` packet.
 */
export function fromDataURL(dataUrl: string): Uint8Array {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) {
    throw new Error('omnibuf/web: invalid Data URL');
  }
  return base64ToUint8Array(dataUrl.slice(commaIdx + 1));
}

/**
 * Create a Web Streams `TransformStream<Uint8Array, Uint8Array>` that frames each
 * incoming OmniBuf packet with a 4-byte little-endian `uint32` length prefix.
 * Suitable for streaming over `fetch`, `WebTransport`, or `RTCDataChannel`.
 */
export function createOmniBufEncodeStream(): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(packet, controller) {
      const frame = new Uint8Array(4 + packet.byteLength);
      const len = packet.byteLength >>> 0;
      frame[0] = len & 0xff;
      frame[1] = (len >>> 8) & 0xff;
      frame[2] = (len >>> 16) & 0xff;
      frame[3] = (len >>> 24) & 0xff;
      frame.set(packet, 4);
      controller.enqueue(frame);
    },
  });
}

/**
 * Linear-time chunk queue for length-prefixed frame decoding in Web Streams.
 */
class WebFrameBufferQueue {
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
 * Create a Web Streams `TransformStream<Uint8Array, Uint8Array>` that deframes
 * 4-byte little-endian length-prefixed chunks into complete OmniBuf `Uint8Array` packets.
 */
export function createOmniBufDecodeStream(options?: {
  maxFrameBytes?: number;
}): TransformStream<Uint8Array, Uint8Array> {
  const maxFrameBytes = options?.maxFrameBytes ?? 16 * 1024 * 1024;
  const queue = new WebFrameBufferQueue();

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (chunk.byteLength === 0) return;
      queue.push(chunk);

      while (true) {
        if (queue.pendingFrameLen === null) {
          if (queue.totalBytes < 4) break;
          const frameLen = queue.peekUInt32LE();
          if (frameLen > maxFrameBytes) {
            controller.error(
              new Error(
                `omnibuf/web: frame length ${frameLen} exceeds maxFrameBytes ${maxFrameBytes}`,
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
        const packet = new Uint8Array(frameLen);
        queue.consume(frameLen, packet);
        controller.enqueue(packet);
      }
    },
    flush(controller) {
      if (queue.trailingBytes > 0) {
        controller.error(
          new Error(
            `omnibuf/web: truncated frame at end of stream (${queue.trailingBytes} trailing bytes)`,
          ),
        );
      }
    },
  });
}

/**
 * Detailed byte-level field breakdown entry returned by `inspectPacket`.
 */
export interface InspectedField {
  /** Byte offset where the field tag begins in the packet */
  offset: number;
  /** Total byte length of this field (tag + length header + payload) */
  byteLength: number;
  /** Field number (`0` for inline `SchemaMeta`, `1..N` for user fields) */
  fieldNumber: number;
  /** Resolved field name from `Field #0` `SchemaMeta` if available, else `"field_<N>"` */
  fieldName: string;
  /** 4-bit wire type number (`0..15`) */
  wireType: number;
  /** Human-readable wire type name (e.g. `"uint"`, `"string"`, `"submsg"`) */
  wireTypeName: string;
  /** Hex representation of the tag bytes */
  tagHex: string;
  /** Hex representation of the entire field slice */
  rawHex: string;
  /** Decoded value for this field */
  value: unknown;
}

/**
 * Full packet inspection result for frontend devtools, wire explorers, and debugging UIs.
 */
export interface PacketInspection {
  /** Total packet size in bytes */
  byteLength: number;
  /** Full packet as lowercase hex */
  hex: string;
  /** Merged `Field #0` `SchemaMeta` if the packet is self-describing, otherwise `null` */
  schemaMeta: SchemaMeta | null;
  /** Ordered list of all fields in wire order */
  fields: InspectedField[];
  /** Schema-less `decodeBlind` output object */
  blind: Record<string, unknown>;
}

/**
 * Inspect an OmniBuf packet and return a structured byte-level breakdown of every field,
 * along with its `Field #0` `SchemaMeta` (if present) and `decodeBlind` representation.
 */
export function inspectPacket(packet: Uint8Array): PacketInspection {
  const blind = decodeBlind(packet);
  const [schemaMeta] = readField0SchemaMeta(packet);
  const f0Prefix = schemaMeta ? encodeField0SchemaMeta(schemaMeta, true) : null;
  const fields: InspectedField[] = [];

  let pos = 0;
  while (pos < packet.length) {
    const startOffset = pos;
    const [rawTag, tn] = decodeVarintBigInt(packet, pos);
    if (tn === 0 || rawTag >> 4n > 536870911n) {
      throw new Error(`omnibuf/web: invalid or truncated tag at ${pos}`);
    }
    const fieldNumber = Number(rawTag >> 4n);
    const wireType = Number(rawTag & 0x0fn);
    const tagEnd = pos + tn;

    let valEnd = tagEnd;
    let previewValue: unknown = null;
    const fieldName =
      fieldNumber === 0 ? '_schema' : (schemaMeta?.fields?.[fieldNumber] ?? `field_${fieldNumber}`);

    switch (wireType) {
      case WireBoolFalse:
        valEnd = tagEnd;
        previewValue = false;
        break;
      case WireBoolTrue:
        valEnd = tagEnd;
        previewValue = true;
        break;
      case WireUint: {
        const [v, vn] = decodeVarintAuto(packet, tagEnd);
        if (vn === 0) {
          throw new Error(`omnibuf/web: truncated uint at ${tagEnd}`);
        }
        valEnd = tagEnd + vn;
        previewValue = v;
        break;
      }
      case WireSint: {
        const [raw, vn] = decodeVarintBigInt(packet, tagEnd);
        if (vn === 0) {
          throw new Error(`omnibuf/web: truncated sint at ${tagEnd}`);
        }
        valEnd = tagEnd + vn;
        previewValue = decodeZigZagAuto(raw);
        break;
      }
      case WireFixed32: {
        if (packet.length - tagEnd < 4) {
          throw new Error(`omnibuf/web: truncated fixed32 at ${tagEnd}`);
        }
        valEnd = tagEnd + 4;
        previewValue =
          (packet[tagEnd]! |
            (packet[tagEnd + 1]! << 8) |
            (packet[tagEnd + 2]! << 16) |
            (packet[tagEnd + 3]! << 24)) >>>
          0;
        break;
      }
      case WireSfixed32: {
        if (packet.length - tagEnd < 4) {
          throw new Error(`omnibuf/web: truncated sfixed32 at ${tagEnd}`);
        }
        valEnd = tagEnd + 4;
        previewValue =
          packet[tagEnd]! |
          (packet[tagEnd + 1]! << 8) |
          (packet[tagEnd + 2]! << 16) |
          (packet[tagEnd + 3]! << 24) |
          0;
        break;
      }
      case WireFloat32: {
        if (packet.length - tagEnd < 4) {
          throw new Error(`omnibuf/web: truncated float32 at ${tagEnd}`);
        }
        valEnd = tagEnd + 4;
        const u32 =
          (packet[tagEnd]! |
            (packet[tagEnd + 1]! << 8) |
            (packet[tagEnd + 2]! << 16) |
            (packet[tagEnd + 3]! << 24)) >>>
          0;
        previewValue = roundFloat32Shortest(float32FromBits(u32));
        break;
      }
      case WireFixed64: {
        if (packet.length - tagEnd < 8) {
          throw new Error(`omnibuf/web: truncated fixed64 at ${tagEnd}`);
        }
        valEnd = tagEnd + 8;
        let u64 = 0n;
        for (let b = 7; b >= 0; b--) {
          u64 = (u64 << 8n) | BigInt(packet[tagEnd + b]!);
        }
        previewValue = u64 <= 9007199254740991n ? Number(u64) : u64;
        break;
      }
      case WireSfixed64: {
        if (packet.length - tagEnd < 8) {
          throw new Error(`omnibuf/web: truncated sfixed64 at ${tagEnd}`);
        }
        valEnd = tagEnd + 8;
        let u64 = 0n;
        for (let b = 7; b >= 0; b--) {
          u64 = (u64 << 8n) | BigInt(packet[tagEnd + b]!);
        }
        const s64 = BigInt.asIntN(64, u64);
        previewValue = s64 >= -9007199254740991n && s64 <= 9007199254740991n ? Number(s64) : s64;
        break;
      }
      case WireFloat64: {
        if (packet.length - tagEnd < 8) {
          throw new Error(`omnibuf/web: truncated float64 at ${tagEnd}`);
        }
        valEnd = tagEnd + 8;
        let u64 = 0n;
        for (let b = 7; b >= 0; b--) {
          u64 = (u64 << 8n) | BigInt(packet[tagEnd + b]!);
        }
        previewValue = float64FromBits(u64);
        break;
      }
      default: {
        const [bodySlice, nextPos] = readLenSlice(packet, tagEnd, 0);
        valEnd = nextPos;
        if (fieldNumber === 0) {
          previewValue = decodeSchemaMeta(bodySlice);
        } else if (wireType === WireString) {
          previewValue = BrowserStringCodec.decode(bodySlice, 0, bodySlice.length);
        } else {
          // Decode this specific field slice in isolation so duplicate/concatenated occurrences
          // show their own slice value rather than only the final merged packet state
          const singleFieldSlice = packet.subarray(startOffset, valEnd);
          if (f0Prefix) {
            const combined = new Uint8Array(f0Prefix.length + singleFieldSlice.length);
            combined.set(f0Prefix, 0);
            combined.set(singleFieldSlice, f0Prefix.length);
            const singleBlind = decodeBlind(combined);
            previewValue = singleBlind[fieldName];
          } else {
            const singleBlind = decodeBlind(singleFieldSlice);
            previewValue = singleBlind[fieldName];
          }
        }
        break;
      }
    }

    fields.push({
      offset: startOffset,
      byteLength: valEnd - startOffset,
      fieldNumber,
      fieldName,
      wireType,
      wireTypeName: wireTypeName(wireType),
      tagHex: toHex(packet.subarray(startOffset, tagEnd)),
      rawHex: toHex(packet.subarray(startOffset, valEnd)),
      value: previewValue,
    });

    pos = valEnd;
  }

  return {
    byteLength: packet.byteLength,
    hex: toHex(packet),
    schemaMeta,
    fields,
    blind,
  };
}

export { nextContainerField };
