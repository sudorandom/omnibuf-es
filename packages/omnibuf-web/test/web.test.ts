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
  it('rejects invalid UTF-8 in buffer slices and preserves a leading BOM', () => {
    assert.throws(() => BrowserStringCodec.decode(Uint8Array.from([0x61, 0xff, 0x62]), 1, 2));
    const text = '\ufeffUnicode 😀';
    assert.equal(BrowserStringCodec.decode(BrowserStringCodec.encode(text)), text);
  });

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
    assert.throws(() => fromHex('0g'), /invalid hex byte/);
    assert.throws(() => fromHex('-1'), /invalid hex byte/);

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

  it('preserves empty packets and reassembles heavily fragmented large frames in Web TransformStreams', async () => {
    const largePayload = new Uint8Array(32 * 1024);
    for (let i = 0; i < largePayload.length; i++) {
      largePayload[i] = (i * 19 + 3) & 0xff;
    }
    const packets = [new Uint8Array(0), largePayload, new Uint8Array(0)];

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
      // Split header and payload into small 13-byte fragments
      for (let i = 0; i < combined.length; i += 13) {
        await decodeWriter.write(combined.subarray(i, Math.min(i + 13, combined.length)));
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

    expect(decodedPackets.length).toBe(3);
    expect(decodedPackets[0]!.byteLength).toBe(0);
    expect(decodedPackets[1]).toEqual(largePayload);
    expect(decodedPackets[2]!.byteLength).toBe(0);
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

  it('inspects concatenated packets with per-slice container values and rejects truncated packets', () => {
    const pkt1 = TelemetryEvent.encode(
      { event_id: 1, service: 'svc-1', healthy: true, tags: ['a'] },
      { selfDescribing: true },
    );
    const pkt2 = TelemetryEvent.encode({
      event_id: 2,
      service: 'svc-2',
      healthy: false,
      tags: ['b'],
    });
    const combined = new Uint8Array(pkt1.length + pkt2.length);
    combined.set(pkt1, 0);
    combined.set(pkt2, pkt1.length);

    const info = inspectPacket(combined);
    const tagFields = info.fields.filter((f) => f.fieldName === 'tags');
    expect(tagFields.length).toBe(2);
    expect(tagFields[0]!.value).toEqual(['a']);
    expect(tagFields[1]!.value).toEqual(['b']);
    expect(info.blind.tags).toEqual(['a', 'b']);

    assert.throws(() => inspectPacket(new Uint8Array([0x10, 0x80])));
  });
});
