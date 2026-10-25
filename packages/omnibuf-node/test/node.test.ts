import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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
  writeFrame,
} from '../src/index.js';

const GOLDEN_DIR = fileURLToPath(new URL('../../../testdata/golden', import.meta.url));
const CORPUS_PATH = fileURLToPath(
  new URL('../../../testdata/conformance_corpus.json', import.meta.url),
);

describe('@omnibuf/node - NodeBufferStringCodec & Node Streams Framing', () => {
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
        vec.schema === 'PeerUpdate'
          ? [TestTierPlugin, TestTierProtobufTypes, TestTierAnnotatedStruct]
          : [
                'TestAllTypes',
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
  });
});
