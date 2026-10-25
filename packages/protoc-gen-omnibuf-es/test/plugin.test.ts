import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FileDescriptorSetJSON } from '@omnibuf/core';
import { generateFromDescriptorSet } from '../src/index.js';

function expect(actual: any) {
  return {
    toBe(expected: any) {
      assert.strictEqual(actual, expected);
    },
    toBeDefined() {
      assert.notStrictEqual(actual, undefined);
    },
    toContain(substr: string) {
      assert.ok(
        typeof actual === 'string' && actual.includes(substr),
        `Expected string to contain ${substr}`,
      );
    },
  };
}

const SAMPLE_FDS: FileDescriptorSetJSON = {
  file: [
    {
      name: 'peer.proto',
      package: 'omnibuf.bench',
      syntax: 'proto3',
      messageType: [
        {
          name: 'Location',
          field: [
            { name: 'region', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' },
            { name: 'datacenter', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' },
            { name: 'city', number: 3, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' },
            { name: 'rack', number: 4, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT32' },
            { name: 'latitude', number: 5, label: 'LABEL_OPTIONAL', type: 'TYPE_FLOAT' },
            { name: 'longitude', number: 6, label: 'LABEL_OPTIONAL', type: 'TYPE_FLOAT' },
          ],
        },
        {
          name: 'Neighbor',
          field: [
            { name: 'peer_asn', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT32' },
            { name: 'router', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' },
            { name: 'latency_us', number: 3, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT32' },
            { name: 'established', number: 4, label: 'LABEL_OPTIONAL', type: 'TYPE_BOOL' },
          ],
        },
        {
          name: 'PeerUpdate',
          field: [
            { name: 'asn', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT32' },
            { name: 'router_id', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' },
            { name: 'active', number: 3, label: 'LABEL_OPTIONAL', type: 'TYPE_BOOL' },
            { name: 'uptime_sec', number: 4, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT64' },
            { name: 'rssi_dbm', number: 5, label: 'LABEL_OPTIONAL', type: 'TYPE_SINT32' },
            { name: 'cpu_load', number: 6, label: 'LABEL_OPTIONAL', type: 'TYPE_DOUBLE' },
            { name: 'tags', number: 7, label: 'LABEL_REPEATED', type: 'TYPE_STRING' },
            { name: 'prefixes', number: 8, label: 'LABEL_REPEATED', type: 'TYPE_UINT32' },
            {
              name: 'location',
              number: 9,
              label: 'LABEL_OPTIONAL',
              type: 'TYPE_MESSAGE',
              typeName: '.omnibuf.bench.Location',
            },
            {
              name: 'neighbors',
              number: 10,
              label: 'LABEL_REPEATED',
              type: 'TYPE_MESSAGE',
              typeName: '.omnibuf.bench.Neighbor',
            },
            { name: 'sequence', number: 11, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT64' },
          ],
        },
      ],
    },
    {
      name: 'conformance.proto',
      package: 'omnibuf.conformance',
      syntax: 'proto3',
      messageType: [
        {
          name: 'TestAllTypes',
          field: [
            { name: 'f1_uint32', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT32' },
            { name: 'f6_string', number: 6, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' },
          ],
        },
      ],
    },
  ],
};

describe('@omnibuf/protoc-gen-omnibuf-es - Code Generator', () => {
  it('generates TypeScript interfaces, single-pass encoders, decoders, and Opaque<T> classes from FileDescriptorSet', () => {
    const files = generateFromDescriptorSet(SAMPLE_FDS);
    expect(files.length).toBe(2);

    const peerFile = files.find((f) => f.name === 'peer_omnibuf.pb.ts');
    expect(peerFile).toBeDefined();
    expect(peerFile!.content).toContain('export interface PeerUpdate');
    expect(peerFile!.content).toContain('export function encodePeerUpdate');
    expect(peerFile!.content).toContain('export function marshalPeerUpdateOmniBuf');
    expect(peerFile!.content).toContain('export function decodePeerUpdate');
    expect(peerFile!.content).toContain('export class OpaquePeerUpdate');
    expect(peerFile!.content).toContain('spliceFields(this._raw, this._dirtyMask');

    const confFile = files.find((f) => f.name === 'conformance_omnibuf.pb.ts');
    expect(confFile).toBeDefined();
    expect(confFile!.content).toContain('export interface TestAllTypes');
    expect(confFile!.content).toContain('export class OpaqueTestAllTypes');
  });
});

it('executes generated encoders, decoders and opaque mutations for maps, bytes, bools and int64', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const ts = await import('typescript');
  const dir = await mkdtemp(fileURLToPath(new URL('./generated-', import.meta.url)));
  try {
    const files = generateFromDescriptorSet({
      file: [
        {
          name: 'test.proto',
          package: 'test',
          messageType: [
            { name: 'Item', field: [{ name: 'id', number: 1, type: 'TYPE_UINT32' }] },
            {
              name: 'Example',
              field: [
                { name: 'flags', number: 1, type: 'TYPE_BOOL', label: 'LABEL_REPEATED' },
                { name: 'blobs', number: 2, type: 'TYPE_BYTES', label: 'LABEL_REPEATED' },
                { name: 'signed', number: 3, type: 'TYPE_INT64' },
                {
                  name: 'names',
                  number: 4,
                  type: 'TYPE_MESSAGE',
                  label: 'LABEL_REPEATED',
                  typeName: '.test.Example.NamesEntry',
                },
                {
                  name: 'items',
                  number: 5,
                  type: 'TYPE_MESSAGE',
                  label: 'LABEL_REPEATED',
                  typeName: '.test.Example.ItemsEntry',
                },
              ],
              nestedType: [
                {
                  name: 'NamesEntry',
                  options: { mapEntry: true },
                  field: [
                    { name: 'key', number: 1, type: 'TYPE_SINT32' },
                    { name: 'value', number: 2, type: 'TYPE_STRING' },
                  ],
                },
                {
                  name: 'ItemsEntry',
                  options: { mapEntry: true },
                  field: [
                    { name: 'key', number: 1, type: 'TYPE_STRING' },
                    { name: 'value', number: 2, type: 'TYPE_MESSAGE', typeName: '.test.Item' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const path = `${dir}/generated.ts`;
    await writeFile(path, files[0]!.content);
    const program = ts.createProgram([path], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    });
    assert.deepEqual(
      ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
      [],
    );
    const generated = await import(pathToFileURL(path).href);
    const value = {
      flags: [false, true],
      blobs: [Uint8Array.from([255, 0]), new Uint8Array()],
      signed: -9223372036854775808n,
      names: { '-2': 'two' },
      items: { first: { id: 42 } },
    };
    const packet = generated.marshalExampleOmniBuf(value);
    assert.deepEqual(packet, generated.ExampleSchema.encode(value));
    const decoded = generated.decodeExample(packet);
    for (const key of ['flags', 'blobs', 'signed', 'names'])
      assert.deepEqual(decoded[key], value[key as keyof typeof value]);
    assert.equal(decoded.items.first.id, 42);
    const opaque = new generated.OpaqueExample(packet);
    assert.equal(opaque.getSigned(), value.signed);
    assert.deepEqual(opaque.getNames(), { '-2': 'two' });
    assert.equal(opaque.getItems().first.id, 42);
    opaque.setNames({ '7': 'seven' });
    opaque.setFlags([true]);
    const changed = generated.decodeExample(opaque.marshal());
    assert.deepEqual(changed.names, { '7': 'seven' });
    assert.deepEqual(changed.flags, [true]);
    assert.deepEqual(changed.blobs, value.blobs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('resolves nested messages, colliding short names, cross-file imports, enums, oneofs, and proto3_optional', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const ts = await import('typescript');
  const dir = await mkdtemp(fileURLToPath(new URL('./generated-multi-', import.meta.url)));
  try {
    const files = generateFromDescriptorSet({
      file: [
        {
          name: 'common.proto',
          package: 'pkg.common',
          enumType: [
            {
              name: 'Status',
              value: [
                { name: 'STATUS_UNSPECIFIED', number: 0 },
                { name: 'STATUS_OK', number: 1 },
              ],
            },
          ],
          messageType: [
            {
              name: 'Inner',
              field: [{ name: 'tag', number: 1, type: 'TYPE_STRING' }],
            },
          ],
        },
        {
          name: 'service.proto',
          package: 'pkg.svc',
          dependency: ['common.proto'],
          messageType: [
            {
              name: 'FirstOuter',
              field: [
                {
                  name: 'inner',
                  number: 1,
                  type: 'TYPE_MESSAGE',
                  typeName: '.pkg.svc.FirstOuter.Inner',
                },
              ],
              nestedType: [
                {
                  name: 'Inner',
                  field: [{ name: 'code', number: 1, type: 'TYPE_UINT32' }],
                },
              ],
            },
            {
              name: 'SecondOuter',
              oneofDecl: [{ name: 'choice' }, { name: '_opt_score' }],
              field: [
                {
                  name: 'local_inner',
                  number: 1,
                  type: 'TYPE_MESSAGE',
                  typeName: '.pkg.svc.SecondOuter.Inner',
                },
                {
                  name: 'common_inner',
                  number: 2,
                  type: 'TYPE_MESSAGE',
                  typeName: '.pkg.common.Inner',
                },
                { name: 'status', number: 3, type: 'TYPE_ENUM', typeName: '.pkg.common.Status' },
                { name: 'str_choice', number: 4, type: 'TYPE_STRING', oneofIndex: 0 },
                { name: 'num_choice', number: 5, type: 'TYPE_INT32', oneofIndex: 0 },
                {
                  name: 'opt_score',
                  number: 6,
                  type: 'TYPE_INT32',
                  oneofIndex: 1,
                  proto3Optional: true,
                },
              ],
              nestedType: [
                {
                  name: 'Inner',
                  field: [{ name: 'label', number: 1, type: 'TYPE_STRING' }],
                },
              ],
            },
          ],
        },
      ],
    });

    const commonPath = `${dir}/common_omnibuf.pb.ts`;
    const servicePath = `${dir}/service_omnibuf.pb.ts`;
    await writeFile(commonPath, files[0]!.content);
    await writeFile(servicePath, files[1]!.content);

    const program = ts.createProgram([commonPath, servicePath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    });
    assert.deepEqual(
      ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
      [],
    );

    const svcMod = await import(pathToFileURL(servicePath).href);
    const commonMod = await import(pathToFileURL(commonPath).href);

    const msg = svcMod.createSecondOuter({
      localInner: { label: 'nested-second' },
      commonInner: { tag: 'from-common' },
      status: commonMod.Status.STATUS_OK,
      choice: { case: 'numChoice', value: -42 },
      optScore: 0,
    });

    const wire = svcMod.marshalSecondOuterOmniBuf(msg, {
      selfDescribing: true,
      deterministic: true,
    });
    const decoded = svcMod.decodeSecondOuter(wire);
    assert.equal(decoded.localInner.label, 'nested-second');
    assert.equal(decoded.commonInner.tag, 'from-common');
    assert.equal(decoded.status, commonMod.Status.STATUS_OK);
    assert.deepEqual(decoded.choice, { case: 'numChoice', value: -42 });
    assert.equal(decoded.optScore, 0);

    const opaque = new svcMod.OpaqueSecondOuter(wire);
    assert.equal(opaque.getLocalInner().label, 'nested-second');
    assert.equal(opaque.getCommonInner().tag, 'from-common');
    assert.equal(opaque.getNumChoice(), -42);
    assert.equal(opaque.getStrChoice(), undefined);
    assert.equal(opaque.getOptScore(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
