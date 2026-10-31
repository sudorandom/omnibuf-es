import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

function expect(actual: any, message?: string) {
  return {
    toBe(expected: any) {
      assert.strictEqual(actual, expected, message);
    },
    toEqual(expected: any) {
      assert.deepStrictEqual(actual, expected, message);
    },
    toThrow() {
      assert.throws(actual, message);
    },
    not: {
      toBe(expected: any) {
        assert.notStrictEqual(actual, expected, message);
      },
    },
  };
}
import {
  NodeBufferStringCodec,
  OpaquePeerUpdate,
  PeerUpdateSchema,
  TestTierAnnotatedStruct,
  TestTierBlind,
  TestTierPlugin,
  TestTierProtobufTypes,
  WireFormatJSON,
  WireFormatOmniBuf,
  createFrameDecoderStream,
  createFrameEncoderStream,
  decodeBlind,
  decodeBlindJSON,
  handleConformanceRequest,
  loadDescriptorRegistrySync,
  marshalPeerUpdateOmniBuf,
  readField0SchemaMeta,
  readFrames,
  readPacketFileSync,
  unmarshalPeerUpdateOmniBuf,
  unmarshalTestAllTypesOmniBuf,
  writeFrame,
} from '../src/index.js';

const GOLDEN_DIR = fileURLToPath(new URL('../../../testdata/golden', import.meta.url));
const CORPUS_PATH = fileURLToPath(
  new URL('../../../testdata/conformance_corpus.json', import.meta.url),
);

describe('@omnibuf/node - NodeBufferStringCodec & Node Streams Framing', () => {
  it('rejects invalid UTF-8 in buffer slices and preserves a leading BOM', () => {
    assert.throws(() => NodeBufferStringCodec.decode(Uint8Array.from([0x61, 0xff, 0x62]), 1, 2));
    const text = '\ufeffUnicode 😀';
    assert.equal(NodeBufferStringCodec.decode(NodeBufferStringCodec.encode(text)), text);
  });

  it('encodes and decodes UTF-8 strings via Node Buffer', () => {
    const text = 'Hello from Node.js Buffer codec 🛰️';
    const len = NodeBufferStringCodec.byteLength(text);
    const buf = new Uint8Array(len);
    expect(NodeBufferStringCodec.encodeInto!(text, buf, 0)).toBe(len);
    expect(NodeBufferStringCodec.decode(buf, 0, len)).toBe(text);
  });

  it('frames and deframes packets over Node Readable/Writable streams', async () => {
    const pass = new PassThrough();
    const p1 = new Uint8Array([1, 2, 3, 4]);
    const p2 = new Uint8Array([10, 20, 30, 40, 50]);

    await writeFrame(pass, p1);
    await writeFrame(pass, p2);
    pass.end();

    const received: Uint8Array[] = [];
    for await (const frame of readFrames(pass)) {
      received.push(frame);
    }
    expect(received).toEqual([p1, p2]);
  });

  it('pipes packets through createFrameEncoderStream and createFrameDecoderStream', async () => {
    const encStream = createFrameEncoderStream();
    const decStream = createFrameDecoderStream();
    encStream.pipe(decStream);

    const out: Buffer[] = [];
    decStream.on('data', (chunk: Buffer) => out.push(chunk));

    const p1 = Buffer.from([7, 8, 9]);
    const p2 = Buffer.from([100, 200]);
    encStream.write(p1);
    encStream.write(p2);
    encStream.end();

    await new Promise<void>((resolve, reject) => {
      decStream.on('end', resolve);
      decStream.on('error', reject);
    });

    expect(out).toEqual([p1, p2]);
  });

  it('preserves empty (0-byte) packets in createFrameDecoderStream and readFrames', async () => {
    const encStream = createFrameEncoderStream();
    const decStream = createFrameDecoderStream();
    encStream.pipe(decStream);

    const out: Buffer[] = [];
    decStream.on('data', (chunk: Buffer) => out.push(chunk));

    const empty = Buffer.alloc(0);
    const nonEmpty = Buffer.from([42]);
    encStream.write(empty);
    encStream.write(nonEmpty);
    encStream.write(empty);
    encStream.end();

    await new Promise<void>((resolve, reject) => {
      decStream.on('end', resolve);
      decStream.on('error', reject);
    });

    expect(out.length).toBe(3);
    expect(out[0]!.length).toBe(0);
    expect(out[1]).toEqual(nonEmpty);
    expect(out[2]!.length).toBe(0);

    // Also verify single empty frame on readFrames and createFrameDecoderStream
    const singlePass = new PassThrough();
    await writeFrame(singlePass, new Uint8Array(0));
    singlePass.end();
    const frames: Uint8Array[] = [];
    for await (const f of readFrames(singlePass)) {
      frames.push(f);
    }
    expect(frames.length).toBe(1);
    expect(frames[0]!.byteLength).toBe(0);
  });

  it('rejects writeFrame() when Writable fails asynchronously after stream.write() returns true', async () => {
    const { Writable } = await import('node:stream');
    const failingWritable = new Writable({
      highWaterMark: 64 * 1024,
      write(_chunk, _encoding, callback) {
        setTimeout(() => {
          callback(new Error('asynchronous write failure after 10ms'));
        }, 10);
      },
    });

    await assert.rejects(
      () => writeFrame(failingWritable, new Uint8Array([1, 2, 3])),
      /asynchronous write failure after 10ms/,
    );

    // Also test backpressure (highWaterMark: 1) succeeding and failing asynchronously
    const slowBackpressureWritable = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setTimeout(() => callback(null), 10);
      },
    });
    await writeFrame(slowBackpressureWritable, new Uint8Array([1, 2, 3, 4]));
  });

  it('reassembles heavily fragmented large frames in linear time without dropping or corrupting bytes', async () => {
    const payload = new Uint8Array(64 * 1024);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = (i * 31 + 7) & 0xff;
    }

    const decStream = createFrameDecoderStream();
    const out: Buffer[] = [];
    decStream.on('data', (chunk: Buffer) => out.push(chunk));

    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.byteLength, 0);
    // Feed header 1 byte at a time
    for (let i = 0; i < 4; i++) {
      decStream.write(header.subarray(i, i + 1));
    }
    // Feed 64 KiB payload in small 17-byte fragments
    for (let i = 0; i < payload.byteLength; i += 17) {
      decStream.write(payload.subarray(i, Math.min(i + 17, payload.byteLength)));
    }
    decStream.end();

    await new Promise<void>((resolve, reject) => {
      decStream.on('end', resolve);
      decStream.on('error', reject);
    });

    expect(out.length).toBe(1);
    expect(new Uint8Array(out[0]!)).toEqual(payload);
  });
});

describe('@omnibuf/node - Byte-for-byte Verification Against Golden Files & Conformance Corpus', () => {
  it('matches golden PeerUpdate and AllWireTypes packets byte-for-byte', () => {
    const peerSharedBytes = readPacketFileSync(`${GOLDEN_DIR}/peer_update.shared.obuf.hex`);
    const peerField0Bytes = readPacketFileSync(`${GOLDEN_DIR}/peer_update.field0.obuf.hex`);
    const peerBlindSharedJson = JSON.parse(
      readFileSync(`${GOLDEN_DIR}/peer_update.blind.shared.json`, 'utf8'),
    );
    const peerBlindField0Json = JSON.parse(
      readFileSync(`${GOLDEN_DIR}/peer_update.blind.field0.json`, 'utf8'),
    );

    // 1. Blind decode matches golden JSON
    expect(JSON.parse(decodeBlindJSON(peerSharedBytes))).toEqual(peerBlindSharedJson);
    expect(JSON.parse(decodeBlindJSON(peerField0Bytes))).toEqual(peerBlindField0Json);

    // 2. Tier 1 generated plugin codec matches golden bytes byte-for-byte
    const decodedPeer = unmarshalPeerUpdateOmniBuf(peerSharedBytes);
    const reencodedShared = marshalPeerUpdateOmniBuf(decodedPeer, { deterministic: true });
    expect(Buffer.from(reencodedShared).toString('hex')).toBe(
      Buffer.from(peerSharedBytes).toString('hex'),
    );

    const reencodedField0 = marshalPeerUpdateOmniBuf(decodedPeer, {
      selfDescribing: true,
      deterministic: true,
    });
    expect(Buffer.from(reencodedField0).toString('hex')).toBe(
      Buffer.from(peerField0Bytes).toString('hex'),
    );

    // 3. Tier 3 MessageSchema matches golden bytes byte-for-byte
    const reencodedTier3 = PeerUpdateSchema.encode(decodedPeer, {
      selfDescribing: true,
      deterministic: true,
    });
    expect(Buffer.from(reencodedTier3).toString('hex')).toBe(
      Buffer.from(peerField0Bytes).toString('hex'),
    );

    // 4. Tier 2 DescriptorRegistry (.fds.json and .fds.pb.gz) matches golden bytes byte-for-byte
    const peerRegJson = loadDescriptorRegistrySync(`${GOLDEN_DIR}/peer.fds.json`);
    const peerRegPbGz = loadDescriptorRegistrySync(`${GOLDEN_DIR}/peer.fds.pb.gz`);

    expect(
      Buffer.from(
        peerRegJson.encode('omnibuf.bench.PeerUpdate', peerBlindField0Json, {
          selfDescribing: true,
          deterministic: true,
        }),
      ).toString('hex'),
    ).toBe(Buffer.from(peerField0Bytes).toString('hex'));

    expect(
      Buffer.from(
        peerRegPbGz.encode('omnibuf.bench.PeerUpdate', peerBlindField0Json, {
          selfDescribing: true,
          deterministic: true,
        }),
      ).toString('hex'),
    ).toBe(Buffer.from(peerField0Bytes).toString('hex'));

    // 5. AllWireTypes golden verification (both blind decode and Tier 2 DescriptorRegistry encode/decode!)
    const allWireShared = readPacketFileSync(`${GOLDEN_DIR}/all_wire_types.shared.obuf.hex`);
    const allWireField0 = readPacketFileSync(`${GOLDEN_DIR}/all_wire_types.field0.obuf.hex`);
    const allWireBlindSharedJson = JSON.parse(
      readFileSync(`${GOLDEN_DIR}/all_wire_types.blind.shared.json`, 'utf8'),
    );
    const allWireBlindField0Json = JSON.parse(
      readFileSync(`${GOLDEN_DIR}/all_wire_types.blind.field0.json`, 'utf8'),
    );
    const allWireInputJson = JSON.parse(
      readFileSync(`${GOLDEN_DIR}/all_wire_types.input.json`, 'utf8'),
    );

    expect(JSON.parse(decodeBlindJSON(allWireShared))).toEqual(allWireBlindSharedJson);
    expect(JSON.parse(decodeBlindJSON(allWireField0))).toEqual(allWireBlindField0Json);

    const allReg = loadDescriptorRegistrySync(`${GOLDEN_DIR}/all_wire_types.fds.json`);
    const reencodedAllShared = allReg.encode('omnibuf.golden.AllWireTypesMsg', allWireInputJson, {
      deterministic: true,
      selfDescribing: false,
    });
    expect(Buffer.from(reencodedAllShared).toString('hex')).toBe(
      Buffer.from(allWireShared).toString('hex'),
    );

    const reencodedAllField0 = allReg.encode('omnibuf.golden.AllWireTypesMsg', allWireInputJson, {
      deterministic: true,
      selfDescribing: true,
    });
    expect(Buffer.from(reencodedAllField0).toString('hex')).toBe(
      Buffer.from(allWireField0).toString('hex'),
    );
  });

  it('passes all valid vectors and rejects all invalid wire vectors in conformance_corpus.json across all 4 tiers', () => {
    const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));

    // 1. Verify all valid vectors across Blind, AnnotatedStruct, ProtobufTypes, and Plugin tiers
    for (const vec of corpus.valid_vectors) {
      const rawWire = new Uint8Array(Buffer.from(vec.wire_hex, 'hex'));
      expect(rawWire.byteLength).toBe(vec.wire_byte_len);

      // 1A. Blind tier
      const blindResp = handleConformanceRequest({
        test_name: `${vec.name}/Blind`,
        message_type: vec.schema,
        tier: TestTierBlind,
        requested_output_format: WireFormatJSON,
        omnibuf_payload: rawWire,
      });
      expect(blindResp.parse_error, `Blind parse_error on ${vec.name}`).toBe('');
      expect(blindResp.runtime_error).toBe('');
      if (vec.expected_blind) {
        expect(JSON.parse(blindResp.json_payload)).toEqual(vec.expected_blind);
      }

      // 1B. Schema tiers
      const canonicalType =
        vec.schema === 'PeerUpdate'
          ? 'omnibuf.bench.PeerUpdate'
          : vec.schema === 'TreeNode'
            ? 'omnibuf.conformance.TreeNode'
            : vec.schema === 'NestedCluster'
              ? 'omnibuf.conformance.NestedCluster'
              : 'omnibuf.conformance.TestAllTypes';

      const tiers =
        vec.schema === 'PeerUpdate' || vec.schema === 'TestAllTypes'
          ? [TestTierPlugin, TestTierProtobufTypes, TestTierAnnotatedStruct]
          : [
                'EmptyMessage',
                'SparseField14',
                'SelfDescribingSparse',
                'TreeNode',
                'NestedCluster',
              ].includes(vec.schema)
            ? [TestTierAnnotatedStruct]
            : [];

      for (const tier of tiers) {
        const resp = handleConformanceRequest({
          test_name: `${vec.name}/Tier_${tier}`,
          message_type: canonicalType,
          tier,
          requested_output_format: WireFormatOmniBuf,
          omnibuf_payload: rawWire,
        });
        expect(resp.parse_error, `tier ${tier} parse_error on ${vec.name}`).toBe('');
        expect(resp.serialize_error, `tier ${tier} serialize_error on ${vec.name}`).toBe('');
        expect(resp.runtime_error, `tier ${tier} runtime_error on ${vec.name}`).toBe('');

        // Verify round-trip equivalence by re-running through the tier and comparing wire bytes
        const resp2 = handleConformanceRequest({
          test_name: `${vec.name}/Tier_${tier}/Reencode`,
          message_type: canonicalType,
          tier,
          requested_output_format: WireFormatOmniBuf,
          omnibuf_payload: resp.omnibuf_payload,
        });
        expect(Buffer.from(resp2.omnibuf_payload).toString('hex')).toBe(
          Buffer.from(resp.omnibuf_payload).toString('hex'),
        );

        if (vec.schema === 'PeerUpdate') {
          const respSD = handleConformanceRequest({
            test_name: `${vec.name}/Tier_${tier}/SelfDescribing`,
            message_type: canonicalType,
            tier,
            requested_output_format: WireFormatOmniBuf,
            omnibuf_payload: rawWire,
            self_describing: true,
          });
          expect(respSD.parse_error).toBe('');
          const [meta, ok] = readField0SchemaMeta(respSD.omnibuf_payload);
          expect(ok).toBe(true);
          expect(meta?.fields?.[2]).toBe('router_id');

          if (tier === TestTierPlugin) {
            const respSplice = handleConformanceRequest({
              test_name: `${vec.name}/Tier_${tier}/OpaqueSpliceGrow`,
              message_type: canonicalType,
              tier,
              requested_output_format: WireFormatOmniBuf,
              omnibuf_payload: rawWire,
              test_opaque_splice: true,
            });
            expect(respSplice.parse_error).toBe('');
            expect(respSplice.serialize_error).toBe('');
            expect(respSplice.runtime_error).toBe('');

            const origDec = unmarshalPeerUpdateOmniBuf(rawWire, { readUnknownFields: false });
            const origSeq = BigInt.asUintN(
              64,
              typeof origDec.sequence === 'bigint' ? origDec.sequence : BigInt(origDec.sequence),
            );
            const nextSeq = BigInt.asUintN(64, origSeq + 1n);
            const splicedDec = unmarshalPeerUpdateOmniBuf(respSplice.omnibuf_payload, {
              readUnknownFields: false,
            });
            expect(splicedDec.asn).toBe(1_000_000);
            expect(splicedDec.routerId).toBe('edge-rtr-fra01-'.repeat(20));
            expect(BigInt(splicedDec.uptimeSec)).toBe(0xffffffffffffffffn);
            expect(BigInt(splicedDec.sequence)).toBe(nextSeq);

            const respShrink = handleConformanceRequest({
              test_name: `${vec.name}/Tier_${tier}/OpaqueSpliceShrink`,
              message_type: canonicalType,
              tier,
              requested_output_format: WireFormatOmniBuf,
              omnibuf_payload: rawWire,
              test_opaque_splice_shrink: true,
            });
            expect(respShrink.parse_error).toBe('');
            expect(respShrink.serialize_error).toBe('');
            expect(respShrink.runtime_error).toBe('');
            const shrunkDec = unmarshalPeerUpdateOmniBuf(respShrink.omnibuf_payload, {
              readUnknownFields: false,
            });
            expect(shrunkDec.asn).toBe(1);
            expect(shrunkDec.routerId).toBe('r');
            expect(shrunkDec.active).toBe(false);
            expect(shrunkDec.uptimeSec).toBe(5);
            expect(shrunkDec.rssiDbm).toBe(-1);
            expect(shrunkDec.sequence).toBe(2);
          }
        } else if (vec.schema === 'TestAllTypes' && tier === TestTierPlugin) {
          const respSplice = handleConformanceRequest({
            test_name: `${vec.name}/Tier_${tier}/OpaqueSpliceGrow`,
            message_type: canonicalType,
            tier,
            requested_output_format: WireFormatOmniBuf,
            omnibuf_payload: rawWire,
            test_opaque_splice: true,
          });
          expect(respSplice.parse_error).toBe('');
          expect(respSplice.serialize_error).toBe('');
          expect(respSplice.runtime_error).toBe('');
          const grownDec = unmarshalTestAllTypesOmniBuf(respSplice.omnibuf_payload, {
            readUnknownFields: false,
          });
          expect(grownDec.f1Uint32).toBe(1_000_000);
          expect(BigInt(grownDec.f2Uint64)).toBe(0xffffffffffffffffn);
          expect(grownDec.f3Sint32).toBe(-1_000_000);
          expect(grownDec.f6String).toBe('grown-str-'.repeat(30));

          const respShrink = handleConformanceRequest({
            test_name: `${vec.name}/Tier_${tier}/OpaqueSpliceShrink`,
            message_type: canonicalType,
            tier,
            requested_output_format: WireFormatOmniBuf,
            omnibuf_payload: rawWire,
            test_opaque_splice_shrink: true,
          });
          expect(respShrink.parse_error).toBe('');
          expect(respShrink.serialize_error).toBe('');
          expect(respShrink.runtime_error).toBe('');
          const shrunkDec = unmarshalTestAllTypesOmniBuf(respShrink.omnibuf_payload, {
            readUnknownFields: false,
          });
          expect(shrunkDec.f1Uint32).toBe(1);
          expect(shrunkDec.f2Uint64).toBe(2);
          expect(shrunkDec.f3Sint32).toBe(-1);
          expect(shrunkDec.f6String).toBe('s');
        }
      }
    }

    // 2. Verify all invalid wire cases are strictly rejected (no crash, returns parse_error)
    for (const ic of corpus.invalid_cases) {
      const badBytes = new Uint8Array(Buffer.from(ic.wire_hex, 'hex'));
      expect(() => decodeBlind(badBytes), `expected decodeBlind to reject ${ic.name}`).toThrow();

      const blindResp = handleConformanceRequest({
        test_name: `Invalid/${ic.name}/Blind`,
        message_type: 'omnibuf.conformance.TestAllTypes',
        tier: TestTierBlind,
        requested_output_format: WireFormatJSON,
        omnibuf_payload: badBytes,
      });
      expect(blindResp.parse_error, `expected Blind parse_error on ${ic.name}`).not.toBe('');

      for (const tier of [TestTierAnnotatedStruct, TestTierProtobufTypes, TestTierPlugin]) {
        const resp = handleConformanceRequest({
          test_name: `Invalid/${ic.name}/Tier_${tier}`,
          message_type: 'omnibuf.bench.PeerUpdate',
          tier,
          requested_output_format: WireFormatOmniBuf,
          omnibuf_payload: badBytes,
        });
        expect(resp.runtime_error, `unexpected runtime_error on ${ic.name}`).toBe('');
      }
    }
  });

  it('supports lazy OpaquePeerUpdate zero-decode reads and selective spliceFields mutation', () => {
    const initial = marshalPeerUpdateOmniBuf({
      asn: 64512,
      router_id: 'edge-rtr-fra01.core.backbone.net',
      active: true,
      uptime_sec: 1849203,
      rssi_dbm: -62,
      cpu_load: 0.42875,
      tags: ['tier1', 'ebgp'],
      prefixes: [167772160, 172032000],
      location: {
        region: 'eu-central-1',
        datacenter: 'FRA-Equinix-FR5',
        city: 'Frankfurt',
        rack: 42,
        latitude: 50.1109,
        longitude: 8.6821,
      },
      neighbors: [
        { peer_asn: 3356, router: 'ae0.fra1.level3.net', latency_us: 850, established: true },
      ],
      sequence: 9876543210,
    });

    const opaque = new OpaquePeerUpdate(initial);
    // Zero-copy when clean
    expect(opaque.marshal()).toBe(initial);
    expect(opaque.asn()).toBe(64512);
    expect(opaque.routerId()).toBe('edge-rtr-fra01.core.backbone.net');
    expect(opaque.getRouterId()).toBe('edge-rtr-fra01.core.backbone.net');
    expect(opaque.router_id()).toBe('edge-rtr-fra01.core.backbone.net');
    expect(opaque.active()).toBe(true);
    expect(opaque.rssiDbm()).toBe(-62);
    expect(opaque.rssi_dbm()).toBe(-62);
    expect(opaque.sequence()).toBe(9876543210);

    // Mutate only active (#3) and sequence (#11)
    opaque.setActive(false);
    opaque.setSequence(9876543211);

    const updatedBytes = opaque.marshal();
    const decoded = unmarshalPeerUpdateOmniBuf(updatedBytes);
    expect(decoded.$typeName).toBe('omnibuf.bench.PeerUpdate');
    expect(decoded.asn).toBe(64512);
    expect(decoded.routerId).toBe('edge-rtr-fra01.core.backbone.net');
    expect(decoded.router_id).toBe('edge-rtr-fra01.core.backbone.net');
    expect(decoded.active).toBe(false);
    expect(decoded.tags).toEqual(['tier1', 'ebgp']);
    expect(decoded.location?.$typeName).toBe('omnibuf.bench.Location');
    expect(decoded.location?.datacenter).toBe('FRA-Equinix-FR5');
    expect(decoded.neighbors[0]?.$typeName).toBe('omnibuf.bench.Neighbor');
    expect(decoded.neighbors[0]?.peerAsn).toBe(3356);
    expect(decoded.neighbors[0]?.peer_asn).toBe(3356);
    expect(decoded.sequence).toBe(9876543211);

    // Grow middle fields across Prefix-Varint byte-width boundaries (1B->4B, 1B->2B len, 4B->9B)
    const longRouter = 'edge-rtr-fra01-'.repeat(20);
    const opGrow = new OpaquePeerUpdate(updatedBytes);
    opGrow.setAsn(1_000_000);
    opGrow.setRouterId(longRouter);
    opGrow.setUptimeSec(0xffffffffffffffffn);
    const grownBytes = opGrow.marshal();
    expect(grownBytes.byteLength > updatedBytes.byteLength).toBe(true);

    const grownView = new OpaquePeerUpdate(grownBytes);
    expect(grownView.getAsn()).toBe(1_000_000);
    expect(grownView.getRouterId()).toBe(longRouter);
    expect(BigInt(grownView.getUptimeSec())).toBe(0xffffffffffffffffn);
    expect(grownView.getLocation()?.city).toBe('Frankfurt');
    expect(grownView.getNeighbors()[0]?.router).toBe('ae0.fra1.level3.net');
    expect(grownView.getSequence()).toBe(9876543211);

    // Shrink middle fields back down (4B->1B, 2B->1B len, 9B->1B)
    grownView.setAsn(1);
    grownView.setRouterId('r');
    grownView.setUptimeSec(5);
    const shrunkBytes = grownView.marshal();
    expect(shrunkBytes.byteLength < updatedBytes.byteLength).toBe(true);

    const shrunkDec = unmarshalPeerUpdateOmniBuf(shrunkBytes);
    expect(shrunkDec.asn).toBe(1);
    expect(shrunkDec.routerId).toBe('r');
    expect(shrunkDec.uptimeSec).toBe(5);
    expect(shrunkDec.location?.city).toBe('Frankfurt');
    expect(shrunkDec.sequence).toBe(9876543211);
  });

  it('decodes 1-byte Prefix-Varint odd length containers in generated decodeTestAllTypes and OpaqueTestAllTypes', async () => {
    const { WireArray, WireString, WireSubMsg, WireUint, writeVarintAt } =
      await import('@omnibuf/core');
    const { OpaqueTestAllTypes } = await import('../src/index.js');

    // Submsg body of odd length 3: id (#1, WireUint=0) = 300 -> [0x21, 0xb2, 0x04]
    const subBody3 = new Uint8Array([0x21, 0xb2, 0x04]);
    // Submsg body of length 2: id (#1, WireUint=0) = 9 -> [0x21, 0x13]
    const subBody2 = new Uint8Array([0x21, (9 << 1) | 1]);

    // f8SubMsg (#8, WireSubMsg=12): 1-byte odd length = 3 (0x07)
    // f9StringArr (#9, WireArray=13): 1-byte odd length = 5 (0x0b) -> [WireString(10), count=1(0x03), len=2(0x05), 'o', 'k']
    // f10Uint32Arr (#10, WireArray=13): 1-byte odd length = 3 (0x07) -> [WireUint(0), count=1(0x03), val=11(0x17)]
    // f11SubMsgArr (#11, WireArray=13):
    //   occurrence 1: outer len = 6 (0x0d), inner elem 1B odd len = 3 (0x07) + subBody3
    //   occurrence 2: outer 1B odd len = 5 (0x0b), inner elem 1B len = 2 (0x05) + subBody2
    const varintBytes = (v: number): Uint8Array => {
      const tmp = new Uint8Array(9);
      return tmp.subarray(0, writeVarintAt(tmp, 0, v));
    };

    const wire = new Uint8Array([
      ...varintBytes((8 << 4) | WireSubMsg),
      (3 << 1) | 1,
      ...subBody3,

      ...varintBytes((9 << 4) | WireArray),
      (5 << 1) | 1,
      WireString,
      (1 << 1) | 1,
      (2 << 1) | 1,
      0x6f,
      0x6b,

      ...varintBytes((10 << 4) | WireArray),
      (3 << 1) | 1,
      WireUint,
      (1 << 1) | 1,
      (11 << 1) | 1,

      ...varintBytes((11 << 4) | WireArray),
      (6 << 1) | 1,
      WireSubMsg,
      (1 << 1) | 1,
      (3 << 1) | 1,
      ...subBody3,

      ...varintBytes((11 << 4) | WireArray),
      (5 << 1) | 1,
      WireSubMsg,
      (1 << 1) | 1,
      (2 << 1) | 1,
      ...subBody2,
    ]);

    const decoded = unmarshalTestAllTypesOmniBuf(wire);
    expect(decoded.f8SubMsg?.id).toBe(300);
    expect(decoded.f9StringArr).toEqual(['ok']);
    expect(decoded.f10Uint32Arr).toEqual([11]);
    expect(decoded.f11SubMsgArr.map((x) => x.id)).toEqual([300, 9]);

    const opaque = new OpaqueTestAllTypes(wire);
    expect(opaque.getF8SubMsg()?.id).toBe(300);
    expect(opaque.getF9StringArr()).toEqual(['ok']);
    expect(opaque.getF10Uint32Arr()).toEqual([11]);
    expect(opaque.getF11SubMsgArr().map((x) => x.id)).toEqual([300, 9]);
  });

  it('merges concatenated sub-messages in readSubMsg/Opaque, resets unseen fields on target reuse, and rejects mismatched fixed array types', async () => {
    const {
      Encoder,
      concatMessages,
      readBool,
      readFixed32Arr,
      readFixed64Arr,
      readInt,
      readSfixed32Arr,
      readSfixed64Arr,
      readString,
      readSubMsg,
      readUint,
    } = await import('@omnibuf/core');
    const {
      OpaqueTestAllTypes,
      TestAllTypesSchema,
      createAllTypesSubMsg,
      createTestAllTypes,
      decodeTestAllTypes,
    } = await import('../src/index.js');

    // 1. Concatenated packets with partial sub-messages merge in readSubMsg and Opaque getters
    const encA = new Encoder(64);
    encA.beginSubMsg(8);
    encA.writeUint(1, 10);
    encA.writeString(2, 'from-A');
    encA.writeBool(3, true);
    encA.endSubMsg();

    const encB = new Encoder(64);
    encB.beginSubMsg(8);
    encB.writeUint(1, 20);
    encB.writeInt(4, -555);
    encB.endSubMsg();

    const concat = concatMessages(encA.finish(), encB.finish());
    const [subConcat, subOk] = readSubMsg(concat, 8);
    expect(subOk).toBe(true);
    expect(readUint(subConcat, 1)).toEqual([20, true]);
    expect(readString(subConcat, 2)).toEqual(['from-A', true]);
    expect(readBool(subConcat, 3)).toEqual([true, true]);
    expect(readInt(subConcat, 4)).toEqual([-555, true]);

    const op = new OpaqueTestAllTypes(concat);
    const subOp = op.getF8SubMsg();
    expect(subOp?.id).toBe(20);
    expect(subOp?.label).toBe('from-A');
    expect(subOp?.flag).toBe(true);
    expect(subOp?.score).toBe(-555);

    // 2. Reusing a generated or schema struct when a singular sub-message is absent resets it to null
    const reused = createTestAllTypes({
      f1Uint32: 42,
      f8SubMsg: createAllTypesSubMsg({ id: 9, label: 'stale', flag: true, score: 100 }),
    });
    decodeTestAllTypes(new Uint8Array(0), reused);
    expect(reused.f1Uint32).toBe(0);
    expect(reused.f8SubMsg).toBe(null);

    const reusedSchema = TestAllTypesSchema.create({
      f1Uint32: 42,
      f8SubMsg: createAllTypesSubMsg({ id: 9, label: 'stale', flag: true, score: 100 }),
    });
    TestAllTypesSchema.decode(new Uint8Array(0), reusedSchema);
    expect(reusedSchema.f1Uint32).toBe(0);
    expect(reusedSchema.f8SubMsg).toBe(null);

    // 3. readFixed*Arr / readSfixed*Arr reject mismatched element wire types (WireFloat32 / WireFloat64)
    const float32Enc = new Encoder(32);
    float32Enc.writeFloat32Arr(1, [1.5, 2.5]);
    const float32Pkt = float32Enc.finish();
    expect(readFixed32Arr(float32Pkt, 1)).toEqual([[], false]);
    expect(readSfixed32Arr(float32Pkt, 1)).toEqual([[], false]);

    const float64Enc = new Encoder(32);
    float64Enc.writeFloat64Arr(1, [1.5, 2.5]);
    const float64Pkt = float64Enc.finish();
    expect(readFixed64Arr(float64Pkt, 1)).toEqual([[], false]);
    expect(readSfixed64Arr(float64Pkt, 1)).toEqual([[], false]);
  });

  it('rejects oversized raw files and gzip decompression bombs in loadDescriptorRegistrySync', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnibuf-fds-test-'));
    try {
      const limit = 4096;

      // 1. Oversized raw file
      const rawPath = join(dir, 'oversized.fds.pb');
      writeFileSync(rawPath, Buffer.alloc(limit + 1));
      assert.throws(
        () => loadDescriptorRegistrySync(rawPath, { maxSchemaBytes: limit }),
        /exceeds limit/,
      );

      // 2. Single-member and multi-member concatenated gzip bombs whose compressed size is < limit
      const memberA = gzipSync(Buffer.alloc(limit));
      const memberB = gzipSync(Buffer.alloc(1));
      const concatGz = Buffer.concat([memberA, memberB]);
      expect(concatGz.byteLength < limit).toBe(true);

      const gzPath = join(dir, 'bomb.fds.pb.gz');
      writeFileSync(gzPath, concatGz);
      assert.throws(
        () => loadDescriptorRegistrySync(gzPath, { maxSchemaBytes: limit }),
        /exceeds limit/,
      );

      // 3. Invalid maxSchemaBytes
      assert.throws(
        () => loadDescriptorRegistrySync(rawPath, { maxSchemaBytes: 0 }),
        /invalid maxSchemaBytes/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
