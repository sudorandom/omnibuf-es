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
  assert.equal(Buffer.from(enc.finish()).toString('hex'), '21b2046556021e0067074652418155');
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
    [0x0b, 0x05, 0x21, 0x01], // metadata type_name with the wrong wire type
    [0x33, 0x05, 0xff, 0x01], // empty map with invalid MapType
    [0x2f, 0x05, 0x05, 0x01], // count 2 but only one array value
    [0x2b, 0x03, 0x00], // unknown submessage with truncated tag
    [0x31, 0x03, 0x05], // submessage-array element exceeds container
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

it('uses valid uint map payloads for booleans and preserves fixed scalar meanings', () => {
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
  assert.deepEqual(decodeBlind(packet).field_1, { '1': 0, '0': 1 });
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

it('accepts all prefix widths including nonzero TZCNT >= 3 markers', () => {
  assert.deepEqual(decodeVarintBigInt(Uint8Array.from([2, 0])), [0n, 2]);
  assert.deepEqual(decodeVarintBigInt(Uint8Array.from([4, 0, 0, 0])), [0n, 4]);
  assert.deepEqual(decodeVarintBigInt(Uint8Array.from([8, 1, 0, 0, 0, 0, 0, 0, 0])), [1n, 9]);
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
