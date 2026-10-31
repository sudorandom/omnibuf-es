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
    toBeCloseTo(expected: number, precision = 5) {
      assert.ok(Math.abs(actual - expected) < Math.pow(10, -precision));
    },
    toBeInstanceOf(cls: any) {
      assert.ok(actual instanceof cls);
    },
    not: {
      toBeNull() {
        assert.notStrictEqual(actual, null);
      },
    },
  };
}
import {
  DescriptorRegistry,
  Encoder,
  base64ToUint8Array,
  clearField,
  clone,
  concatMessages,
  create,
  decodeBlind,
  decodeBlindJSON,
  decodeVarint,
  decodeVarintBigInt,
  decodeZigZag,
  decodeZigZagBigInt,
  defineMessage,
  encodeZigZag,
  encodeZigZagNumber,
  equals,
  fromBinary,
  isMessage,
  locateField,
  marshalDeterministic,
  marshalProto,
  mergeFromBinary,
  omnibufField,
  omnibufMessage,
  parseBinaryFileDescriptorSet,
  readBool,
  readBytes,
  readField0SchemaMeta,
  readFixed32,
  readFixed64,
  readFloat32,
  readFloat32Arr,
  readFloat64,
  readFloat64Arr,
  readInt,
  readIntBigInt,
  readSintArr,
  readString,
  readStringArr,
  readSubMsg,
  readSubMsgArrElem,
  readUint,
  readUint32Arr,
  readUintBigInt,
  spliceFields,
  subMsgArrLen,
  toBinary,
  unmarshal,
  unmarshalProto,
  writeField0SchemaMeta,
  writeVarintAt,
  type Message,
  type ProtobufDescMessage,
  type SchemaMeta,
} from '../src/index.js';

describe('@omnibuf/core - Prefix-Varint & ZigZag primitives', () => {
  it('encodes and decodes Prefix-Varint across 1B, 2B, 4B, and 9B boundaries', () => {
    const vectors: Array<{ val: bigint; expectedLen: number }> = [
      { val: 0n, expectedLen: 1 },
      { val: 1n, expectedLen: 1 },
      { val: 127n, expectedLen: 1 },
      { val: 128n, expectedLen: 2 },
      { val: 16383n, expectedLen: 2 },
      { val: 16384n, expectedLen: 4 },
      { val: 536870911n, expectedLen: 4 },
      { val: 536870912n, expectedLen: 9 },
      { val: 0xffffffffn, expectedLen: 9 },
      { val: 0xffffffffffffffffn, expectedLen: 9 },
    ];

    for (const { val, expectedLen } of vectors) {
      const buf = new Uint8Array(16);
      const written = writeVarintAt(buf, 0, val);
      expect(written).toBe(expectedLen);
      const [decoded, bytesRead] = decodeVarintBigInt(buf, 0);
      expect(bytesRead).toBe(expectedLen);
      expect(decoded).toBe(val);

      if (val <= 0xffffffffn) {
        const buf32 = new Uint8Array(16);
        const w32 = writeVarintAt(buf32, 0, Number(val));
        expect(w32).toBe(expectedLen);
        const [d32, np32] = decodeVarint(buf32, 0);
        expect(np32).toBe(expectedLen);
        expect(d32).toBe(Number(val));
      }
    }
  });

  it('encodes and decodes 32-bit and 64-bit ZigZag integers', () => {
    const cases32: Array<[number, number]> = [
      [0, 0],
      [-1, 1],
      [1, 2],
      [-2, 3],
      [2, 4],
      [2147483647, 4294967294],
      [-2147483648, 4294967295],
    ];
    for (const [signed, unsigned] of cases32) {
      expect(Number(encodeZigZagNumber(signed))).toBe(unsigned);
      expect(decodeZigZag(unsigned)).toBe(signed);
    }

    const cases64: Array<[bigint, bigint]> = [
      [0n, 0n],
      [-1n, 1n],
      [1n, 2n],
      [-2n, 3n],
      [9223372036854775807n, 18446744073709551614n],
      [-9223372036854775808n, 18446744073709551615n],
    ];
    for (const [signed, unsigned] of cases64) {
      expect(encodeZigZag(signed)).toBe(unsigned);
      expect(decodeZigZagBigInt(unsigned)).toBe(signed);
    }
  });
});

describe('@omnibuf/core - All 16 wire types & single-pass Encoder / O(1) Readers', () => {
  it('round-trips all scalar, array, submsg, and map wire types', () => {
    const enc = new Encoder();
    enc.writeUint(1, 42);
    enc.writeUint(2, 18446744073709551615n);
    enc.writeInt(3, -123);
    enc.writeInt(4, -9223372036854775808n);
    enc.writeFixed32(5, 0xdeadbeef);
    enc.writeFixed64(6, 0xcafebabe12345678n);
    enc.writeFloat32(7, 3.5);
    enc.writeFloat64(8, Math.PI);
    enc.writeBool(9, false);
    enc.writeBool(10, true);
    enc.writeString(11, 'hello omnibuf 🚀');
    enc.writeBytes(12, new Uint8Array([1, 2, 3, 4, 255]));
    enc.writeStringArr(13, ['alpha', 'beta', 'gamma']);
    enc.writeUint32Arr(14, [10, 200, 30000]);
    enc.writeSintArr(15, [-100, 0, 100]);
    enc.writeFloat32Arr(16, [1.5, -2.5]);
    enc.writeFloat64Arr(17, [1.25, -3.75]);
    enc.writeMapStringUint(18, { alpha: 100, beta: 200 }, true);

    enc.beginSubMsg(19);
    enc.writeString(1, 'nested');
    enc.writeUint(2, 99);
    enc.endSubMsg();

    enc.beginSubMsgArr(20);
    for (let i = 0; i < 2; i++) {
      enc.beginSubMsgElem();
      enc.writeUint(1, i + 1);
      enc.endSubMsgElem();
    }
    enc.endSubMsgArr();

    const packet = enc.finish();

    expect(readUint(packet, 1)).toEqual([42, true]);
    expect(readUintBigInt(packet, 2)).toEqual([18446744073709551615n, true]);
    expect(readInt(packet, 3)).toEqual([-123, true]);
    expect(readIntBigInt(packet, 4)).toEqual([-9223372036854775808n, true]);
    expect(readFixed32(packet, 5)).toEqual([0xdeadbeef, true]);
    expect(readFixed64(packet, 6)).toEqual([0xcafebabe12345678n, true]);
    expect(readFloat32(packet, 7)[0]).toBeCloseTo(3.5);
    expect(readFloat64(packet, 8)[0]).toBeCloseTo(Math.PI);
    expect(readBool(packet, 9)).toEqual([false, true]);
    expect(readBool(packet, 10)).toEqual([true, true]);
    expect(readString(packet, 11)).toEqual(['hello omnibuf 🚀', true]);
    expect(Array.from(readBytes(packet, 12)[0])).toEqual([1, 2, 3, 4, 255]);
    expect(readStringArr(packet, 13)).toEqual([['alpha', 'beta', 'gamma'], true]);
    expect(readUint32Arr(packet, 14)).toEqual([[10, 200, 30000], true]);
    expect(readSintArr(packet, 15)).toEqual([[-100, 0, 100], true]);
    expect(readFloat32Arr(packet, 16)).toEqual([[1.5, -2.5], true]);
    expect(readFloat64Arr(packet, 17)).toEqual([[1.25, -3.75], true]);

    const [sub, subOk] = readSubMsg(packet, 19);
    expect(subOk).toBe(true);
    expect(readString(sub, 1)).toEqual(['nested', true]);
    expect(readUint(sub, 2)).toEqual([99, true]);

    expect(subMsgArrLen(packet, 20)).toBe(2);
    expect(readUint(readSubMsgArrElem(packet, 20, 0)[0], 1)).toEqual([1, true]);
    expect(readUint(readSubMsgArrElem(packet, 20, 1)[0], 1)).toEqual([2, true]);
  });

  it('expands 2-byte reserved length header to 4-byte header when submessage exceeds 16,383 bytes', () => {
    const enc = new Encoder();
    enc.beginSubMsg(1);
    const bigStr = 'x'.repeat(20000);
    enc.writeString(1, bigStr);
    enc.endSubMsg();
    const packet = enc.finish();

    const [sub, ok] = readSubMsg(packet, 1);
    expect(ok).toBe(true);
    expect(readString(sub, 1)).toEqual([bigStr, true]);
  });

  it('supports spliceFields and concatMessages raw merge semantics (including Field #0 merge)', () => {
    const SchemaA = defineMessage<{ id: number; name: string }>('test.Msg', {
      id: { fieldNum: 1, type: 'uint32', omitEmpty: true },
      name: { fieldNum: 2, type: 'string', omitEmpty: true },
    });
    const SchemaB = defineMessage<{ id: number; extra: string }>('test.Msg', {
      id: { fieldNum: 1, type: 'uint32', omitEmpty: true },
      extra: { fieldNum: 3, type: 'string', omitEmpty: true },
    });

    const pktA = SchemaA.encode({ id: 10, name: 'initial' }, { selfDescribing: true });
    const pktB = SchemaB.encode({ id: 99, extra: 'merged' }, { selfDescribing: true });

    const merged = concatMessages(pktA, pktB);
    // Last write wins for Field #1
    expect(readUint(merged, 1)).toEqual([99, true]);
    expect(readString(merged, 2)).toEqual(['initial', true]);
    expect(readString(merged, 3)).toEqual(['merged', true]);

    // Field #0 SchemaMeta is merged across both packets
    const [meta, ok] = readField0SchemaMeta(merged);
    expect(ok).toBe(true);
    expect(meta?.fields).toEqual({
      1: 'id',
      2: 'name',
      3: 'extra',
    });

    const blind = decodeBlind(merged);
    expect(blind).toEqual({
      id: 99,
      name: 'initial',
      extra: 'merged',
    });

    // Zero-decode spliceFields replacing field 2
    const spliced = spliceFields(merged, 1n << 2n, 3, (enc, fnum) => {
      if (fnum === 2) enc.writeString(2, 'spliced-name');
    });
    expect(locateField(spliced, 2).ok).toBe(true);
    expect(readUint(spliced, 1)).toEqual([99, true]);
    expect(readString(spliced, 2)).toEqual(['spliced-name', true]);
    expect(readString(spliced, 3)).toEqual(['merged', true]);
  });
});

describe('@omnibuf/core - Tier 2 (@bufbuild/protobuf DescMessage) & Tier 3 (Decorators / defineMessage)', () => {
  it('marshals and unmarshals via @bufbuild/protobuf DescMessage (Tier 2)', () => {
    const desc: ProtobufDescMessage = {
      typeName: 'omnibuf.test.User',
      fields: [
        { number: 1, name: 'userId', protoName: 'user_id', fieldKind: 'scalar', scalar: 13 }, // UINT32
        { number: 2, name: 'email', protoName: 'email', fieldKind: 'scalar', scalar: 9 }, // STRING
        { number: 3, name: 'verified', protoName: 'verified', fieldKind: 'scalar', scalar: 8 }, // BOOL
        {
          number: 4,
          name: 'roles',
          protoName: 'roles',
          fieldKind: 'list',
          listKind: 'scalar',
          scalar: 9,
        }, // STRING[]
      ],
    };

    const input = {
      userId: 777,
      email: 'alice@example.com',
      verified: true,
      roles: ['admin', 'editor'],
    };

    const wire = marshalProto(desc, input, { selfDescribing: true });
    const decoded = unmarshalProto<typeof input>(desc, wire);
    expect(decoded).toEqual(input);

    const blind = decodeBlind(wire);
    expect(blind).toEqual({
      user_id: 777,
      email: 'alice@example.com',
      verified: true,
      roles: ['admin', 'editor'],
    });
  });

  it('marshals and unmarshals TypeScript classes with @omnibufMessage and @omnibufField decorators (Tier 3)', () => {
    class MetricPoint {
      metric = '';
      delta = 0;
      tags: Record<string, string> = {};
    }

    omnibufField(1, { type: 'string' })(MetricPoint.prototype, 'metric');
    omnibufField(2, { type: 'sint32' })(MetricPoint.prototype, 'delta');
    omnibufField(3, { type: 'map', mapKey: 'string', mapVal: 'string' })(
      MetricPoint.prototype,
      'tags',
    );
    omnibufMessage('MetricPoint')(MetricPoint);

    const pt = new MetricPoint();
    pt.metric = 'cpu.temp';
    pt.delta = -15;
    pt.tags = { host: 'srv-01', dc: 'fra1' };

    const bytes = marshalDeterministic(pt, { selfDescribing: true });
    const roundTripped = unmarshal(bytes, MetricPoint);
    expect(roundTripped).toBeInstanceOf(MetricPoint);
    expect(roundTripped.metric).toBe('cpu.temp');
    expect(roundTripped.delta).toBe(-15);
    expect(roundTripped.tags).toEqual({ dc: 'fra1', host: 'srv-01' });

    const json = decodeBlindJSON(bytes);
    expect(JSON.parse(json)).toEqual({
      metric: 'cpu.temp',
      delta: -15,
      tags: { dc: 'fra1', host: 'srv-01' },
    });
  });

  it('implements protobuf-es v2 Message<TypeName> structure ($typeName, $unknown, create, toBinary, fromBinary, mergeFromBinary, isMessage, clone, equals, clearField)', () => {
    interface Hop extends Message<'omnibuf.test.Hop'> {
      hopAsn: number;
      hop_asn?: number;
      routerName: string;
      router_name?: string;
    }
    const HopSchema = defineMessage<Hop, 'omnibuf.test.Hop'>('omnibuf.test.Hop', {
      hopAsn: { fieldNum: 1, name: 'hop_asn', type: 'uint32' },
      routerName: { fieldNum: 2, name: 'router_name', type: 'string' },
    });

    interface RouteAnnouncement extends Message<'omnibuf.test.RouteAnnouncement'> {
      prefix: string;
      originAsn: number;
      origin_asn?: number;
      med: bigint;
      communities: string[];
      attributes: Record<string, number>;
      nextHop: Hop | null;
      next_hop?: Hop | null;
      hops: Hop[];
    }
    const RouteAnnouncementSchema = defineMessage<
      RouteAnnouncement,
      'omnibuf.test.RouteAnnouncement'
    >('omnibuf.test.RouteAnnouncement', {
      prefix: { fieldNum: 1, type: 'string' },
      originAsn: { fieldNum: 2, name: 'origin_asn', type: 'uint32' },
      med: { fieldNum: 3, type: 'uint64', useBigInt: true },
      communities: { fieldNum: 4, type: 'string[]' },
      attributes: { fieldNum: 5, type: 'map', mapKey: 'string', mapVal: 'uint32' },
      nextHop: {
        fieldNum: 6,
        name: 'next_hop',
        type: 'submsg',
        optional: true,
        subSchema: () => HopSchema,
      },
      hops: { fieldNum: 7, type: 'submsg[]', subSchema: () => HopSchema },
    });

    // 1. create() sets $typeName, initializes defaults, and recursively creates sub-messages
    const msg = create(RouteAnnouncementSchema, {
      prefix: '10.128.0.0/16',
      originAsn: 64512,
      med: 100n,
      communities: ['64512:100'],
      attributes: { local_pref: 200 },
      nextHop: { hopAsn: 3356, routerName: 'edge-01' },
      hops: [{ hop_asn: 1299, router_name: 'core-02' }],
    });

    expect(msg.$typeName).toBe('omnibuf.test.RouteAnnouncement');
    expect(isMessage(msg)).toBe(true);
    expect(isMessage(msg, RouteAnnouncementSchema)).toBe(true);
    expect(isMessage(msg, HopSchema)).toBe(false);
    // create() returns an existing message instance directly without cloning (protobuf-es v2 behavior)
    expect(create(RouteAnnouncementSchema, msg)).toBe(msg);
    // Both camelCase (localName) and snake_case (.proto name) properties work seamlessly
    expect(msg.originAsn).toBe(64512);
    expect(msg.origin_asn).toBe(64512);
    expect(msg.nextHop?.$typeName).toBe('omnibuf.test.Hop');
    expect(msg.nextHop?.hopAsn).toBe(3356);
    expect(msg.nextHop?.hop_asn).toBe(3356);
    expect(msg.hops[0]?.hopAsn).toBe(1299);
    expect(msg.hops[0]?.routerName).toBe('core-02');

    // 2. toBinary() / fromBinary() round-trip with $unknown field retention
    const knownBytes = toBinary(RouteAnnouncementSchema, msg, { deterministic: true });
    const extraEnc = new Encoder();
    extraEnc.writeRaw(knownBytes);
    extraEnc.writeString(99, 'future-extension-field');
    extraEnc.writeUint(100, 424242);
    const packetWithUnknown = extraEnc.finish();

    const parsed = fromBinary(RouteAnnouncementSchema, packetWithUnknown);
    expect(parsed.$typeName).toBe('omnibuf.test.RouteAnnouncement');
    expect(parsed.med).toBe(100n);
    expect(parsed.$unknown?.length).toBe(2);
    expect(parsed.$unknown?.[0]?.no).toBe(99);
    expect(parsed.$unknown?.[1]?.no).toBe(100);

    // Re-serializing with toBinary() writes $unknown fields back by default
    const reserializedWithUnknown = toBinary(RouteAnnouncementSchema, parsed, {
      deterministic: true,
    });
    expect(readString(reserializedWithUnknown, 99)).toEqual(['future-extension-field', true]);
    expect(readUint(reserializedWithUnknown, 100)).toEqual([424242, true]);

    // writeUnknownFields: false omits $unknown fields
    const reserializedWithoutUnknown = toBinary(RouteAnnouncementSchema, parsed, {
      deterministic: true,
      writeUnknownFields: false,
    });
    expect(readString(reserializedWithoutUnknown, 99)).toEqual(['', false]);

    // 3. clone() and equals()
    const cloned = clone(RouteAnnouncementSchema, parsed);
    expect(equals(RouteAnnouncementSchema, parsed, cloned)).toBe(true);
    expect(equals(RouteAnnouncementSchema, parsed, cloned, { unknown: true })).toBe(true);
    cloned.communities.push('64512:200');
    expect(parsed.communities.length).toBe(1);
    expect(equals(RouteAnnouncementSchema, parsed, cloned)).toBe(false);

    // 4. mergeFromBinary() and clearField()
    const deltaEnc = new Encoder();
    deltaEnc.writeUint(2, 65001);
    deltaEnc.writeStringArr(4, ['65001:999']);
    const mergedTarget = clone(RouteAnnouncementSchema, msg);
    mergeFromBinary(RouteAnnouncementSchema, mergedTarget, deltaEnc.finish());
    expect(mergedTarget.originAsn).toBe(65001);
    expect(mergedTarget.communities).toEqual(['64512:100', '65001:999']);

    clearField(RouteAnnouncementSchema, mergedTarget, 'originAsn');
    expect(mergedTarget.originAsn).toBe(0);
  });

  it('returns independent Uint8Array buffers from Schema.encode and spliceFields without shared slab aliasing', () => {
    const ItemSchema = defineMessage<{ id: number; name: string }>('omnibuf.test.Item', {
      id: { fieldNum: 1, type: 'uint32' },
      name: { fieldNum: 2, type: 'string' },
    });

    const pkt1 = ItemSchema.encode({ id: 1, name: 'alpha' });
    const snapshot1 = Uint8Array.from(pkt1);
    const pkt2 = ItemSchema.encode({ id: 2, name: 'bravo-longer-payload' });
    expect(pkt1.buffer !== pkt2.buffer).toBe(true);
    pkt2.fill(0xff);
    expect(pkt1).toEqual(snapshot1);

    const spliced1 = spliceFields(pkt1, 1 << 2, 2, (enc) => {
      enc.writeString(2, 'alpha-v2');
    });
    const splicedSnapshot = Uint8Array.from(spliced1);
    const spliced2 = spliceFields(pkt1, 1 << 2, 2, (enc) => {
      enc.writeString(2, 'alpha-v3-extra-bytes');
    });
    expect(spliced1.buffer !== spliced2.buffer).toBe(true);
    spliced2.fill(0);
    expect(spliced1).toEqual(splicedSnapshot);
  });

  it('preserves aliased prefixes in spliceFields without modifying the source packet', () => {
    const pktEnc = new Encoder(64);
    pktEnc.writeUint(1, 42);
    pktEnc.writeUint(2, 99);
    const packet = pktEnc.finish();

    const appendDirty = (enc: Encoder, fnum: number): void => {
      enc.writeUint(fnum, 1n << 40n);
    };

    for (const maxField of [2, 40]) {
      for (const prefixLen of [0, 3, 32]) {
        const prefix = new Uint8Array(prefixLen).fill(0xa5);
        const storage = new Uint8Array(prefixLen + packet.byteLength + 512);
        storage.set(prefix, 0);
        storage.set(packet, prefixLen);

        const wantEnc = new Encoder(prefixLen + packet.byteLength + 64);
        wantEnc.writeRaw(prefix);
        const want = spliceFields(packet, 1 << 1, maxField, appendDirty, wantEnc);

        const aliasedEnc = new Encoder(storage, prefixLen);
        const rawSlice = storage.subarray(prefixLen, prefixLen + packet.byteLength);
        const got = spliceFields(rawSlice, 1 << 1, maxField, appendDirty, aliasedEnc);

        expect(got).toEqual(want);
        expect(rawSlice).toEqual(packet);
      }
    }
  });

  it('validates base64 input in base64ToUint8Array and rejects malformed strings', () => {
    expect(base64ToUint8Array('AQID')).toEqual(new Uint8Array([1, 2, 3]));
    assert.throws(() => base64ToUint8Array('ABC'), /invalid base64 string length/);
    assert.throws(() => base64ToUint8Array('AB$D'), /invalid base64 character/);
    assert.throws(() => base64ToUint8Array('A=CD'), /invalid base64/);
  });

  it('prevents DescriptorRegistry shortName collisions from overwriting earlier schemas', () => {
    const reg = new DescriptorRegistry({
      file: [
        {
          name: 'a.proto',
          package: 'pkg.a',
          messageType: [
            { name: 'Item', field: [{ name: 'a_val', number: 1, type: 'TYPE_UINT32' }] },
          ],
        },
        {
          name: 'b.proto',
          package: 'pkg.b',
          messageType: [
            { name: 'Item', field: [{ name: 'b_val', number: 1, type: 'TYPE_STRING' }] },
          ],
        },
      ],
    });
    expect(reg.getSchema('pkg.a.Item')?.typeName).toBe('pkg.a.Item');
    expect(reg.getSchema('pkg.b.Item')?.typeName).toBe('pkg.b.Item');
    expect(reg.getSchema('Item')?.typeName).toBe('pkg.a.Item');
  });

  it('overlays Field #0 schemas in decodeBlind without quadratic copying and supports empty-string field name masking', () => {
    // 1. Nested overlay merges (matching upstream TestBlindSchemaOverlayNestedMerges)
    const rootMeta: SchemaMeta = {
      typeName: 'test.Parent',
      fields: { 1: 'child' },
      children: {
        1: {
          typeName: 'test.ChildFromRoot',
          fields: {
            1: 'from_root',
            2: 'override_me',
            3: 'clear_me',
            4: 'nested',
          },
          children: {
            4: {
              typeName: 'test.GrandFromRoot',
              fields: { 1: 'grand_root', 2: 'grand_override' },
            },
          },
        },
      },
    };
    const childLocalMeta1: SchemaMeta = {
      fields: { 2: 'from_child_1', 3: '' },
      children: {
        4: { fields: { 2: 'grand_child_1', 3: 'grand_extra' } },
      },
    };
    const childLocalMeta2: SchemaMeta = {
      fields: { 2: 'from_child_2', 5: 'tail_only' },
    };

    const grandEnc = new Encoder(32);
    grandEnc.writeUint(1, 10);
    grandEnc.writeUint(2, 20);
    grandEnc.writeUint(3, 30);
    const grandBytes = grandEnc.finish();

    const childEnc = new Encoder(128);
    writeField0SchemaMeta(childEnc, childLocalMeta1, true);
    childEnc.writeUint(1, 1);
    childEnc.writeUint(2, 2);
    childEnc.writeUint(3, 3);
    childEnc.beginSubMsg(4);
    childEnc.writeRaw(grandBytes);
    childEnc.endSubMsg();
    childEnc.writeUint(5, 5);
    writeField0SchemaMeta(childEnc, childLocalMeta2, true);
    const childBytes = childEnc.finish();

    const pktEnc = new Encoder(256);
    writeField0SchemaMeta(pktEnc, rootMeta, true);
    pktEnc.beginSubMsg(1);
    pktEnc.writeRaw(childBytes);
    pktEnc.endSubMsg();

    const got = decodeBlind(pktEnc.finish());
    expect(got).toEqual({
      child: {
        from_root: 1,
        from_child_2: 2,
        field_3: 3,
        tail_only: 5,
        nested: {
          grand_root: 10,
          grand_child_1: 20,
          grand_extra: 30,
        },
      },
    });

    // 2. Shared 1,000-field schema across 2,000 submessages (with and without local Field #0 overrides)
    const childFields: Record<number, string> = {};
    for (let i = 1; i <= 1000; i++) {
      childFields[i] = `field_name_${i}`;
    }
    const largeRootMeta: SchemaMeta = {
      typeName: 'bench.Root',
      fields: { 2: 'items' },
      children: {
        2: {
          typeName: 'bench.Item',
          fields: childFields,
        },
      },
    };
    const localOverrideMeta: SchemaMeta = {
      fields: { 1001: 'local_extra' },
    };

    for (const withLocalOverride of [false, true]) {
      const enc = new Encoder(32768);
      writeField0SchemaMeta(enc, largeRootMeta, true);
      enc.beginSubMsgArr(2);
      for (let i = 0; i < 2000; i++) {
        enc.beginSubMsgElem();
        enc.writeUint(1, i);
        if (withLocalOverride) {
          writeField0SchemaMeta(enc, localOverrideMeta, true);
        }
        enc.endSubMsgElem();
      }
      enc.endSubMsgArr();
      const decoded = decodeBlind(enc.finish());
      const items = decoded.items as Array<Record<string, unknown>>;
      expect(items.length).toBe(2000);
      expect(items[0]?.field_name_1).toBe(0);
      expect(items[1999]?.field_name_1).toBe(1999);
    }
  });

  it('decodes heavily fragmented repeated fields in linear time without quadratic array reallocation', () => {
    const FragSchema = defineMessage<{
      floats: number[];
      u64s: bigint[];
      s64s: bigint[];
      strs: string[];
    }>('omnibuf.test.Frag', {
      floats: { fieldNum: 1, type: 'float32[]' },
      u64s: { fieldNum: 2, type: 'uint64[]', useBigInt: true },
      s64s: { fieldNum: 3, type: 'sint64[]', useBigInt: true },
      strs: { fieldNum: 4, type: 'string[]' },
    });

    const count = 2000;
    const enc = new Encoder(count * 32);
    for (let i = 0; i < count; i++) {
      enc.writeFloat32Arr(1, [1.5]);
      enc.writeUintArr(2, [i]);
      enc.writeSintArr(3, [-i]);
      enc.writeStringArr(4, ['x']);
    }
    const packet = enc.finish();

    const msg = FragSchema.decode(packet);
    expect(msg.floats.length).toBe(count);
    expect(msg.floats[0]).toBe(1.5);
    expect(msg.u64s.length).toBe(count);
    expect(msg.u64s[count - 1]).toBe(BigInt(count - 1));
    expect(msg.s64s.length).toBe(count);
    expect(msg.s64s[count - 1]).toBe(BigInt(-(count - 1)));
    expect(msg.strs.length).toBe(count);
  });

  it('sorts large deterministic maps with long common prefixes identically across Encoder and MessageSchema', () => {
    const MapHolderSchema = defineMessage<{ entries: Record<string, number> }>(
      'omnibuf.test.MapHolder',
      {
        entries: { fieldNum: 12, type: 'map', mapKey: 'string', mapVal: 'uint64' },
      },
    );
    const prefix = 'p'.repeat(2048);

    for (const n of [16, 17, 512]) {
      const entries: Record<string, number> = {};
      for (let i = n - 1; i >= 0; i--) {
        const key = `${prefix}:${String((i * 73) % n).padStart(6, '0')}`;
        entries[key] = i + 1;
      }

      const rawEnc = new Encoder(4096);
      rawEnc.writeMapStringUintDeterministic(12, entries);
      const rawBytes = rawEnc.finish();

      const schemaBytes = MapHolderSchema.encode({ entries }, { deterministic: true });
      expect(schemaBytes).toEqual(rawBytes);
    }
  });

  it('preserves __proto__ map keys as own properties across create(), clone(), encode(), and decode()', () => {
    const SubSchema = defineMessage<{ label: string }>('omnibuf.test.Sub', {
      label: { fieldNum: 1, type: 'string' },
    });
    const HolderSchema = defineMessage<{
      scalars: Record<string, number>;
      subs: Record<string, { label: string }>;
    }>('omnibuf.test.Holder', {
      scalars: { fieldNum: 1, type: 'map', mapKey: 'string', mapVal: 'uint32' },
      subs: {
        fieldNum: 2,
        type: 'map',
        mapKey: 'string',
        mapVal: 'submsg',
        subSchema: () => SubSchema,
      },
    });

    const rawScalars: Record<string, number> = {};
    Object.defineProperty(rawScalars, '__proto__', {
      value: 77,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const rawSubs: Record<string, { label: string }> = {};
    Object.defineProperty(rawSubs, '__proto__', {
      value: { label: 'safe-sub' },
      writable: true,
      enumerable: true,
      configurable: true,
    });

    const created = HolderSchema.create({ scalars: rawScalars, subs: rawSubs });
    expect(Object.getPrototypeOf(created.scalars)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(created.subs)).toBe(Object.prototype);
    expect(Object.hasOwn(created.scalars, '__proto__')).toBe(true);
    expect(Object.hasOwn(created.subs, '__proto__')).toBe(true);

    const cloned = HolderSchema.clone(created);
    expect(Object.getPrototypeOf(cloned.scalars)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(cloned.subs)).toBe(Object.prototype);
    expect(Object.hasOwn(cloned.scalars, '__proto__')).toBe(true);
    expect(Object.hasOwn(cloned.subs, '__proto__')).toBe(true);
    expect(
      (Object.getOwnPropertyDescriptor(cloned.subs, '__proto__')?.value as { label: string }).label,
    ).toBe('safe-sub');

    const decoded = HolderSchema.decode(HolderSchema.encode(cloned));
    expect(Object.getPrototypeOf(decoded.scalars)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(decoded.subs)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded.scalars, '__proto__')).toBe(true);
    expect(Object.hasOwn(decoded.subs, '__proto__')).toBe(true);
  });

  it('grows zero-length initial Encoder buffers safely and rejects malformed binary FileDescriptorSets', () => {
    const zeroEnc = new Encoder(new Uint8Array(0));
    zeroEnc.writeUint(1, 12345);
    zeroEnc.writeString(2, 'grown');
    const pkt = zeroEnc.finish();
    expect(readUint(pkt, 1)).toEqual([12345, true]);
    expect(readString(pkt, 2)).toEqual(['grown', true]);

    // Truncated length-delimited field in FileDescriptorSet
    assert.throws(
      () => parseBinaryFileDescriptorSet(new Uint8Array([0x0a, 0x50, 0x01, 0x02])),
      /truncated protobuf length-delimited field/,
    );
    // Varint overflow (>10 continuation bytes) in FileDescriptorSet
    assert.throws(
      () =>
        parseBinaryFileDescriptorSet(
          new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]),
        ),
      /protobuf varint overflow/,
    );
    // Truncated 64-bit wire type 1 field in FileDescriptorSet
    assert.throws(
      () => parseBinaryFileDescriptorSet(new Uint8Array([0x09, 0x01, 0x02, 0x03])),
      /truncated protobuf 64-bit field/,
    );
  });
});
