import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  Encoder,
  defineMessage,
  decodeBlind,
  concatMessages,
  getStringCodec,
  decodeVarintBigInt,
} from '../src/index.js';

it('matches the section 9 annotated packet', () => {
  const enc = new Encoder();
  enc.writeUint(1, 300);
  enc.writeBool(3, true);
  enc.beginSubMsg(9);
  enc.writeString(3, 'FRA');
  enc.writeUint(4, 42);
  enc.endSubMsg();
  assert.equal(Buffer.from(enc.finish()).toString('hex'), '21b2046772021e0075074652418155');
});

it('merges nested repeated fields and maps recursively across submessage occurrences', () => {
  const leaf = defineMessage('Leaf', {
    values: { fieldNum: 1, type: 'uint32[]' },
    labels: { fieldNum: 2, type: 'map' },
  });
  const child = defineMessage('Child', { leaf: { fieldNum: 1, type: 'submsg', subSchema: leaf } });
  const root = defineMessage('Root', { child: { fieldNum: 1, type: 'submsg', subSchema: child } });
  const a = root.encode(
    { child: { leaf: { values: [1], labels: { a: 10 } } } },
    { selfDescribing: true },
  );
  const b = root.encode(
    { child: { leaf: { values: [2], labels: { b: 20 } } } },
    { selfDescribing: true },
  );
  const packet = concatMessages(a, b);
  assert.deepEqual(decodeBlind(packet), {
    child: { leaf: { values: [1, 2], labels: { a: 10, b: 20 } } },
  });
  assert.deepEqual(root.decode(packet).child.leaf.values, [1, 2]);
  assert.deepEqual(root.decode(packet).child.leaf.labels, { a: 10, b: 20 });
});

it('rejects malformed metadata and unknown containers while skipping unknown extensions', () => {
  const empty = defineMessage('Empty', {});
  const invalid = [
    [0x19, 0x05, 0x21, 0x01], // metadata type_name with the wrong wire type
    [0x3d, 0x07, 0xff, 0x00, 0x01], // empty map with invalid KeyType
    [0x3b, 0x07, 0x00, 0x05, 0x01], // count 2 but only one array value
    [0x39, 0x03, 0x00], // unknown submessage with truncated tag
    [0x3b, 0x07, 0x0c, 0x03, 0x05], // submessage-array element exceeds container
    [0x3f, 0x01], // extension missing ExtType
  ];
  for (const bytes of invalid) {
    assert.throws(() => empty.decode(Uint8Array.from(bytes)), undefined, String(bytes));
    assert.throws(() => decodeBlind(Uint8Array.from(bytes)), undefined, String(bytes));
  }
  const ext = Uint8Array.from([0x3f, 0x03, 0xff]);
  assert.doesNotThrow(() => empty.decode(ext));
  assert.throws(() => decodeBlind(ext), /unrecognized/);
});

it('enforces depth 32 even in unknown fields', () => {
  let packet = new Uint8Array();
  const wrap = () => {
    const e = new Encoder();
    e.beginSubMsg(1);
    e.writeRaw(packet);
    e.endSubMsg();
    packet = e.finish();
  };
  const empty = defineMessage('Empty', {});
  for (let i = 0; i < 32; i++) wrap();
  assert.doesNotThrow(() => empty.decode(packet));
  assert.doesNotThrow(() => decodeBlind(packet));
  wrap();
  assert.throws(() => empty.decode(packet), /depth/);
  assert.throws(() => decodeBlind(packet), /depth/);
});

it('uses 1-byte boolean map payloads and preserves fixed scalar meanings', () => {
  const schema = defineMessage('Maps', {
    bools: { fieldNum: 1, type: 'map', mapKey: 'bool', mapVal: 'bool' },
    floats: { fieldNum: 2, type: 'map', mapVal: 'float64' },
    signed: { fieldNum: 3, type: 'map', mapVal: 'sfixed64' },
  });
  const value = { bools: { true: false, false: true }, floats: { x: 1.5 }, signed: { x: -4 } };
  const packet = schema.encode(value);
  const result = schema.decode(packet);
  assert.deepEqual(result.bools, value.bools);
  assert.deepEqual(result.floats, value.floats);
  assert.deepEqual(result.signed, value.signed);
  assert.deepEqual(decodeBlind(packet).field_1, { true: false, false: true });
});

it('preserves special map keys as own properties without mutating prototypes', () => {
  const schema = defineMessage('Maps', { entries: { fieldNum: 1, type: 'map', mapVal: 'string' } });
  const entries = JSON.parse('{"__proto__":"safe","constructor":"also safe"}');
  const packet = schema.encode({ entries });
  assert.deepEqual(schema.decode(packet).entries, entries);
  assert.deepEqual(decodeBlind(packet).field_1, entries);
  assert.equal(Object.getPrototypeOf(schema.decode(packet).entries), Object.prototype);
});

it('counts isolated UTF-16 surrogates like TextEncoder', () => {
  for (const str of ['\ud800', '\ud800a', '\ud800\ud800', '\udc00', '😀']) {
    assert.equal(getStringCodec().byteLength(str), new TextEncoder().encode(str).length);
    const e = new Encoder();
    e.writeString(1, str);
    assert.equal(
      decodeBlind(e.finish()).field_1,
      new TextDecoder().decode(new TextEncoder().encode(str)),
    );
  }
});

it('accepts all valid prefix widths and rejects reserved nonzero 9-byte markers', () => {
  assert.deepEqual(decodeVarintBigInt(Uint8Array.from([2, 0])), [0n, 2]);
  assert.deepEqual(decodeVarintBigInt(Uint8Array.from([4, 0, 0, 0])), [0n, 4]);
  assert.deepEqual(decodeVarintBigInt(Uint8Array.from([0, 1, 0, 0, 0, 0, 0, 0, 0])), [1n, 9]);
  assert.deepEqual(decodeVarintBigInt(Uint8Array.from([8, 1, 0, 0, 0, 0, 0, 0, 0])), [0n, 0]);
});

it('preserves field numbers beyond uint16 and 32-bit tag arithmetic', () => {
  for (const fieldNum of [65536, 268435456, 536870911]) {
    const schema = defineMessage('LargeField', { value: { fieldNum, type: 'uint32' } });
    const packet = schema.encode({ value: 42 });
    assert.equal(schema.decode(packet).value, 42);
    assert.equal(decodeBlind(packet)[`field_${fieldNum}`], 42);
  }
});

it('splices duplicate repeated occurrences once and supports four-byte tags', async () => {
  const { spliceFields } = await import('../src/index.js');
  const schema = defineMessage('List', { values: { fieldNum: 1024, type: 'uint32[]' } });
  const raw = concatMessages(schema.encode({ values: [1] }), schema.encode({ values: [2] }));
  const changed = spliceFields(raw, 1n << 1024n, 1024, (enc, field) =>
    enc.writeUint32Arr(field, [3]),
  );
  assert.deepEqual(schema.decode(changed).values, [3]);
  assert.throws(() => spliceFields(Uint8Array.from([0x21]), 2n, 1, () => {}));
});

it('preserves declared field names in Field #0 up to depth 32 for recursive schemas without exponential blowup', () => {
  interface TreeNode {
    label: string;
    left?: TreeNode | null;
    right?: TreeNode | null;
  }
  const TreeSchema: ReturnType<typeof defineMessage<TreeNode>> = defineMessage<TreeNode>('Tree', {
    label: { fieldNum: 1, name: 'node_label', type: 'string' },
    left: { fieldNum: 2, name: 'left_branch', type: 'submsg', subSchema: () => TreeSchema },
    right: { fieldNum: 3, name: 'right_branch', type: 'submsg', subSchema: () => TreeSchema },
  });

  // Build a 16-level deep tree alternating left and right branches
  let current: TreeNode = { label: 'leaf_16', left: null, right: null };
  for (let d = 15; d >= 0; d--) {
    current =
      d % 2 === 0
        ? { label: `depth_${d}`, left: current, right: null }
        : { label: `depth_${d}`, left: null, right: current };
  }

  const packet = TreeSchema.encode(current, { selfDescribing: true, deterministic: true });
  const blind = decodeBlind(packet) as any;

  let cursor = blind;
  for (let d = 0; d < 16; d++) {
    assert.equal(cursor.node_label, `depth_${d}`);
    cursor = d % 2 === 0 ? cursor.left_branch : cursor.right_branch;
    assert.ok(cursor, `missing branch at depth ${d}`);
  }
  assert.equal(cursor.node_label, 'leaf_16');
});

it('emits exact 64-bit bigints and -0 in stringifyBlindJSON even when JSON.rawJSON is unavailable', async () => {
  const { stringifyBlindJSON } = await import('../src/index.js');
  const origRawJSON = (JSON as any).rawJSON;
  try {
    (JSON as any).rawJSON = undefined;
    const json = stringifyBlindJSON({
      max_int64: 9223372036854775807n,
      min_int64: -9223372036854775808n,
      neg_zero: -0,
      nested: [18446744073709551615n],
    });
    assert.equal(
      json,
      '{"max_int64":9223372036854775807,"min_int64":-9223372036854775808,"neg_zero":-0,"nested":[18446744073709551615]}',
    );
  } finally {
    (JSON as any).rawJSON = origRawJSON;
  }
});

it('supports real @bufbuild/protobuf v2 descriptors with oneofs, proto3_optional presence, and recursive messages', async () => {
  const { createFileRegistry, create: pbCreate } = await import('@bufbuild/protobuf');
  const { FileDescriptorProtoSchema, FieldDescriptorProto_Label, FieldDescriptorProto_Type } =
    await import('@bufbuild/protobuf/wkt');
  const { create, toBinary, fromBinary, mergeFromBinary, clone, equals, clearField } =
    await import('../src/index.js');

  const fileProto = pbCreate(FileDescriptorProtoSchema, {
    name: 'tree.proto',
    package: 'omnibuf.test',
    syntax: 'proto3',
    oneofDecl: [],
    messageType: [
      {
        name: 'TreeNode',
        oneofDecl: [{ name: 'payload' }, { name: '_opt_weight' }],
        field: [
          {
            name: 'id',
            number: 1,
            label: FieldDescriptorProto_Label.OPTIONAL,
            type: FieldDescriptorProto_Type.UINT32,
          },
          {
            name: 'text_val',
            number: 2,
            label: FieldDescriptorProto_Label.OPTIONAL,
            type: FieldDescriptorProto_Type.STRING,
            oneofIndex: 0,
          },
          {
            name: 'int_val',
            number: 3,
            label: FieldDescriptorProto_Label.OPTIONAL,
            type: FieldDescriptorProto_Type.INT64,
            oneofIndex: 0,
          },
          {
            name: 'opt_weight',
            number: 4,
            label: FieldDescriptorProto_Label.OPTIONAL,
            type: FieldDescriptorProto_Type.INT32,
            oneofIndex: 1,
            proto3Optional: true,
          },
          {
            name: 'parent',
            number: 5,
            label: FieldDescriptorProto_Label.OPTIONAL,
            type: FieldDescriptorProto_Type.MESSAGE,
            typeName: '.omnibuf.test.TreeNode',
          },
          {
            name: 'children',
            number: 6,
            label: FieldDescriptorProto_Label.REPEATED,
            type: FieldDescriptorProto_Type.MESSAGE,
            typeName: '.omnibuf.test.TreeNode',
          },
        ],
      },
    ],
  });

  const registry = createFileRegistry(fileProto);
  const TreeNodeDesc = registry.getMessage('omnibuf.test.TreeNode')!;
  assert.ok(TreeNodeDesc);

  // 1. Recursive create() does not infinite-loop; oneof defaults to { case: undefined }; optWeight is undefined
  const emptyNode = create(TreeNodeDesc) as any;
  assert.equal(emptyNode.$typeName, 'omnibuf.test.TreeNode');
  assert.deepEqual(emptyNode.payload, { case: undefined });
  assert.equal(emptyNode.optWeight, undefined);
  assert.equal(emptyNode.parent, null);

  // 2. Explicit presence: optWeight = 0 is preserved on wire vs undefined when unset
  const zeroWeightNode = create(TreeNodeDesc, {
    id: 1,
    optWeight: 0,
    payload: { case: 'intVal', value: 9007199254740993n },
    parent: {
      id: 2,
      payload: { case: 'textVal', value: 'root-payload' },
    },
  } as any) as any;

  const bytes = toBinary(TreeNodeDesc, zeroWeightNode, {
    deterministic: true,
    selfDescribing: true,
  });
  const decoded = fromBinary<any>(TreeNodeDesc, bytes);

  assert.equal(decoded.id, 1);
  assert.equal(decoded.optWeight, 0);
  assert.deepEqual(decoded.payload, { case: 'intVal', value: 9007199254740993n });
  assert.equal(decoded.parent.id, 2);
  assert.deepEqual(decoded.parent.payload, { case: 'textVal', value: 'root-payload' });
  assert.equal(decoded.parent.optWeight, undefined);
  assert.equal(equals(TreeNodeDesc, zeroWeightNode, decoded), true);

  // 3. Cloning & clearing oneof and explicit presence fields
  const cloned = clone(TreeNodeDesc, decoded);
  assert.equal(equals(TreeNodeDesc, decoded, cloned), true);

  const optWeightField = TreeNodeDesc.fields.find((f) => f.localName === 'optWeight')!;
  clearField(cloned, optWeightField);
  assert.equal(cloned.optWeight, undefined);
  assert.equal(equals(TreeNodeDesc, decoded, cloned), false);

  // 4. Switching oneof case via mergeFromBinary replaces previous case
  const patch = toBinary(TreeNodeDesc, {
    payload: { case: 'textVal', value: 'overridden' },
  } as any);
  mergeFromBinary(TreeNodeDesc, cloned, patch);
  assert.deepEqual(cloned.payload, { case: 'textVal', value: 'overridden' });
});

it('negative enum values round-trip across scalar, repeated, and map fields', async () => {
  const { defineMessage, readEnum, readEnumArr, readTypedMap } = await import('../src/index.js');

  const EnumHolder = defineMessage<{
    status: number;
    history: number[];
    byKey: Record<string, number>;
  }>('EnumHolder', {
    status: { fieldNum: 1, type: 'enum' },
    history: { fieldNum: 2, type: 'enum[]' },
    byKey: { fieldNum: 3, type: 'map', mapKey: 'string', mapVal: 'enum' },
  });

  const input = {
    status: -1,
    history: [-1, 0, 1, -2147483648, 2147483647],
    byKey: { negOne: -1, minInt: -2147483648, pos: 42 },
  };

  const wire = EnumHolder.encode(input, { deterministic: true });
  const decoded = EnumHolder.decode(wire);

  assert.equal(decoded.status, -1);
  assert.deepEqual(decoded.history, [-1, 0, 1, -2147483648, 2147483647]);
  assert.deepEqual(decoded.byKey, { negOne: -1, minInt: -2147483648, pos: 42 });

  // Verify Opaque reader helpers match reflective decode
  assert.deepEqual(readEnum(wire, 1), [-1, true]);
  assert.deepEqual(readEnumArr(wire, 2), [[-1, 0, 1, -2147483648, 2147483647], true]);
  assert.deepEqual(readTypedMap(wire, 3, 'string', 'enum'), [
    { negOne: -1, minInt: -2147483648, pos: 42 },
    true,
  ]);
});

it('differential equivalence across MessageSchema, DescriptorRegistry, Opaque readers, and decodeBlind', async () => {
  const {
    DescriptorRegistry,
    WireString,
    WireSubMsg,
    WireUint,
    activeOneofSlice,
    decodeBlind,
    readEnum,
    readEnumArr,
    readString,
    readSubMsgMerged,
    readTypedMap,
  } = await import('../src/index.js');

  const fds = {
    file: [
      {
        name: 'diff.proto',
        package: 'diff',
        syntax: 'proto3',
        enumType: [
          {
            name: 'Kind',
            value: [
              { name: 'KIND_NEG', number: -5 },
              { name: 'KIND_ZERO', number: 0 },
              { name: 'KIND_POS', number: 7 },
            ],
          },
        ],
        messageType: [
          {
            name: 'Sub',
            field: [
              { name: 'a', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT32' },
              { name: 'tags', number: 2, label: 'LABEL_REPEATED', type: 'TYPE_STRING' },
            ],
          },
          {
            name: 'Record',
            oneofDecl: [{ name: 'pick' }],
            field: [
              {
                name: 'kind',
                number: 1,
                label: 'LABEL_OPTIONAL',
                type: 'TYPE_ENUM',
                typeName: '.diff.Kind',
              },
              {
                name: 'kinds',
                number: 2,
                label: 'LABEL_REPEATED',
                type: 'TYPE_ENUM',
                typeName: '.diff.Kind',
              },
              {
                name: 'pick_str',
                number: 3,
                label: 'LABEL_OPTIONAL',
                type: 'TYPE_STRING',
                oneofIndex: 0,
              },
              {
                name: 'pick_uint',
                number: 4,
                label: 'LABEL_OPTIONAL',
                type: 'TYPE_UINT32',
                oneofIndex: 0,
              },
              {
                name: 'pick_sub',
                number: 5,
                label: 'LABEL_OPTIONAL',
                type: 'TYPE_MESSAGE',
                typeName: '.diff.Sub',
                oneofIndex: 0,
              },
              {
                name: 'kind_map',
                number: 6,
                label: 'LABEL_REPEATED',
                type: 'TYPE_MESSAGE',
                typeName: '.diff.Record.KindMapEntry',
              },
            ],
            nestedType: [
              {
                name: 'KindMapEntry',
                options: { mapEntry: true },
                field: [
                  { name: 'key', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' },
                  {
                    name: 'value',
                    number: 2,
                    label: 'LABEL_OPTIONAL',
                    type: 'TYPE_ENUM',
                    typeName: '.diff.Kind',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const reg = new DescriptorRegistry(fds);
  const RecordSchema = reg.getSchema('diff.Record')!;
  const SubSchema = reg.getSchema('diff.Sub')!;

  // Construct a multi-part wire packet where:
  // - part 1 sets kind = -5, kinds = [-5], pick_sub = { a: 10, tags: ['x'] }, kind_map = { k1: -5 }
  // - part 2 switches oneof to pick_str = 'middle'
  // - part 3 switches oneof back to pick_sub = { tags: ['y'] } (must NOT merge with part 1's pick_sub because part 2 cleared it!), and appends kinds = [7], kind_map = { k2: 7 }
  const p1 = RecordSchema.encode(
    {
      kind: -5,
      kinds: [-5],
      pick: { case: 'pickSub', value: { a: 10, tags: ['x'] } },
      kindMap: { k1: -5 },
    } as any,
    { selfDescribing: true },
  );
  const p2 = RecordSchema.encode({
    kind: -5,
    pick: { case: 'pickStr', value: 'middle' },
  } as any);
  const p3 = RecordSchema.encode(
    {
      kind: -5,
      kinds: [7],
      pick: { case: 'pickSub', value: { a: 99, tags: ['y'] } },
      kindMap: { k2: 7 },
    } as any,
    { selfDescribing: true },
  );

  const combined = new Uint8Array(p1.length + p2.length + p3.length);
  combined.set(p1, 0);
  combined.set(p2, p1.length);
  combined.set(p3, p1.length + p2.length);

  // Path 1: MessageSchema.decode
  const decodedSchema = RecordSchema.decode(combined) as any;
  // Path 2: DescriptorRegistry.decode
  const decodedReg = reg.decode('diff.Record', combined) as any;

  assert.equal(decodedSchema.kind, -5);
  assert.deepEqual(decodedSchema.kinds, [-5, 7]);
  assert.deepEqual(decodedSchema.kindMap, { k1: -5, k2: 7 });
  assert.equal(decodedSchema.pick.case, 'pickSub');
  assert.equal(decodedSchema.pick.value.a, 99);
  assert.deepEqual(decodedSchema.pick.value.tags, ['y']);
  assert.deepEqual(decodedReg, decodedSchema);

  // Path 3: Opaque readers + activeOneofSlice
  const oneofSpecs: ReadonlyArray<readonly [number, number]> = [
    [3, 1 << WireString],
    [4, 1 << WireUint],
    [5, 1 << WireSubMsg],
  ];
  assert.deepEqual(readEnum(combined, 1), [-5, true]);
  assert.deepEqual(readEnumArr(combined, 2), [[-5, 7], true]);
  assert.deepEqual(readTypedMap(combined, 6, 'string', 'enum'), [{ k1: -5, k2: 7 }, true]);
  assert.equal(activeOneofSlice(combined, 3, oneofSpecs), null);
  assert.equal(activeOneofSlice(combined, 4, oneofSpecs), null);
  const subSlice = activeOneofSlice(combined, 5, oneofSpecs);
  assert.ok(subSlice);
  const [opaqueSub, okSub] = readSubMsgMerged(subSlice, 5, (sub, target, merge) =>
    SubSchema.decode(sub, target, 0, { merge }),
  );
  assert.equal(okSub, true);
  assert.equal((opaqueSub as any).a, 99);
  assert.deepEqual((opaqueSub as any).tags, ['y']);
  assert.equal(readString(combined, 3)[0], 'middle'); // raw locateField sees superseded field 3, which is why activeOneofSlice is required

  // Path 4: Blind decoder (sees signed ZigZag varint on wire and merges repeated/maps)
  const blind = decodeBlind(combined) as any;
  assert.equal(blind.kind, -5);
  assert.deepEqual(blind.kinds, [-5, 7]);
});
