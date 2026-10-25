import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function expect(actual: any) {
  return {
    toBe(expected: any) {
      assert.strictEqual(actual, expected);
    },
    toEqual(expected: any) {
      assert.deepStrictEqual(actual, expected);
    },
  };
}
import {
  BrowserStringCodec,
  createOmniBufDecodeStream,
  createOmniBufEncodeStream,
  defineMessage,
  fromArrayBuffer,
  fromBase64,
  fromBlob,
  fromDataURL,
  fromHex,
  fromResponse,
  inspectPacket,
  toArrayBuffer,
  toBase64,
  toBlob,
  toDataURL,
  toHex,
} from '../src/index.js';

const TelemetryEvent = defineMessage<{
  event_id: number;
  service: string;
  healthy: boolean;
  tags: string[];
}>('TelemetryEvent', {
  event_id: { fieldNum: 1, type: 'uint32' },
  service: { fieldNum: 2, type: 'string' },
  healthy: { fieldNum: 3, type: 'bool' },
  tags: { fieldNum: 4, type: 'string[]' },
});

describe('@omnibuf/web - Browser codecs, Binary Helpers, Web Streams, and Packet Inspector', () => {
  it('encodes and decodes UTF-8 strings with BrowserStringCodec including astral plane codepoints', () => {
    const str = 'OmniBuf Frontend 🌐⚡🔥';
    const len = BrowserStringCodec.byteLength(str);
    const dst = new Uint8Array(len + 4);
    const written = BrowserStringCodec.encodeInto!(str, dst, 2);
    expect(written).toBe(len);
    expect(BrowserStringCodec.decode(dst, 2, 2 + len)).toBe(str);
  });

  it('converts packets across Blob, Response, ArrayBuffer, Hex, Base64, and DataURL', async () => {
    const pkt = TelemetryEvent.encode(
      {
        event_id: 1024,
        service: 'edge-gateway',
        healthy: true,
        tags: ['http3', 'quic'],
      },
      { selfDescribing: true },
    );

    // Hex
    const hex = toHex(pkt);
    expect(fromHex(hex)).toEqual(pkt);

    // Base64
    const b64 = toBase64(pkt);
    expect(fromBase64(b64)).toEqual(pkt);

    // DataURL
    const dataUrl = toDataURL(pkt);
    expect(dataUrl.startsWith('data:application/x-omnibuf;base64,')).toBe(true);
    expect(fromDataURL(dataUrl)).toEqual(pkt);

    // ArrayBuffer
    const ab = toArrayBuffer(pkt);
    expect(fromArrayBuffer(ab)).toEqual(pkt);

    // Blob
    const blob = toBlob(pkt);
    expect(blob.type).toBe('application/x-omnibuf');
    expect(await fromBlob(blob)).toEqual(pkt);

    // Fetch Response
    const resp = new Response(toArrayBuffer(pkt), {
      status: 200,
      headers: { 'content-type': 'application/x-omnibuf' },
    });
    expect(await fromResponse(resp)).toEqual(pkt);
  });

  it('frames and deframes multiple packets across chunk boundaries using Web TransformStreams', async () => {
    const packets = [
      TelemetryEvent.encode({ event_id: 1, service: 'svc-a', healthy: true, tags: ['a'] }),
      TelemetryEvent.encode({ event_id: 2, service: 'svc-b', healthy: false, tags: ['b', 'c'] }),
      TelemetryEvent.encode({ event_id: 3, service: 'svc-c', healthy: true, tags: [] }),
    ];

    const encodeStream = createOmniBufEncodeStream();
    const decodeStream = createOmniBufDecodeStream();

    const encodedChunks: Uint8Array[] = [];
    const encodeWriter = encodeStream.writable.getWriter();
    const encodeReader = encodeStream.readable.getReader();

    const encodeWritePromise = (async () => {
      for (const p of packets) {
        await encodeWriter.write(p);
      }
      await encodeWriter.close();
    })();

    while (true) {
      const { done, value } = await encodeReader.read();
      if (done) break;
      encodedChunks.push(value);
    }
    await encodeWritePromise;

    // Concatenate all frames and split them into arbitrary 3-byte chunks to test stream reassembly
    const totalBytes = encodedChunks.reduce((acc, c) => acc + c.byteLength, 0);
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of encodedChunks) {
      combined.set(c, offset);
      offset += c.byteLength;
    }

    const decodeWriter = decodeStream.writable.getWriter();
    const decodeReader = decodeStream.readable.getReader();

    const writePromise = (async () => {
      for (let i = 0; i < combined.length; i += 3) {
        await decodeWriter.write(combined.subarray(i, Math.min(i + 3, combined.length)));
      }
      await decodeWriter.close();
    })();

    const decodedPackets: Uint8Array[] = [];
    while (true) {
      const { done, value } = await decodeReader.read();
      if (done) break;
      decodedPackets.push(value);
    }
    await writePromise;

    expect(decodedPackets).toEqual(packets);
  });

  it('inspects self-describing packets with byte offsets, wire type names, and decoded values', () => {
    const pkt = TelemetryEvent.encode(
      {
        event_id: 42,
        service: 'auth-api',
        healthy: true,
        tags: ['v1', 'canary'],
      },
      { selfDescribing: true },
    );

    const info = inspectPacket(pkt);
    expect(info.byteLength).toBe(pkt.byteLength);
    expect(info.schemaMeta?.typeName).toBe('TelemetryEvent');
    expect(info.fields.map((f) => f.fieldName)).toEqual([
      '_schema',
      'event_id',
      'service',
      'healthy',
      'tags',
    ]);
    expect(info.fields[1]!.wireTypeName).toBe('uint');
    expect(info.fields[1]!.value).toBe(42);
    expect(info.fields[3]!.wireTypeName).toBe('bool_true');
    expect(info.fields[3]!.value).toBe(true);
    expect(info.blind).toEqual({
      event_id: 42,
      service: 'auth-api',
      healthy: true,
      tags: ['v1', 'canary'],
    });
  });
});
