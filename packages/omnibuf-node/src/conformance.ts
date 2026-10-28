import {
  DescriptorRegistry,
  ProtoScalarType,
  decodeBlind,
  decodeBlindJSON,
  defineMessage,
  fromBinary,
  toBinary,
  type FileDescriptorSetJSON,
  type MessageSchema,
  type ProtobufDescMessage,
} from '@omnibuf/core';
import {
  OpaquePeerUpdate,
  PeerUpdateSchema,
  createLocation,
  createNeighbor,
  createPeerUpdate,
  decodePeerUpdate,
  marshalPeerUpdateOmniBuf,
} from './gen/peer_omnibuf.pb.js';
import {
  OpaqueTestAllTypes,
  createAllTypesSubMsg,
  createTestAllTypes,
  decodeTestAllTypes,
  marshalTestAllTypesOmniBuf,
} from './gen/conformance_omnibuf.pb.js';

export const WireFormatUnspecified = 0;
export const WireFormatOmniBuf = 1;
export const WireFormatJSON = 2;

export const TestTierUnspecified = 0;
export const TestTierPlugin = 1;
export const TestTierProtobufTypes = 2;
export const TestTierAnnotatedStruct = 3;
export const TestTierBlind = 4;

export interface ConformanceRequest {
  test_name: string;
  message_type: string;
  tier: number;
  requested_output_format: number;
  omnibuf_payload: Uint8Array;
  json_payload: string;
  self_describing: boolean;
  test_opaque_splice: boolean;
  test_opaque_splice_shrink: boolean;
}

export interface ConformanceResponse {
  parse_error: string;
  serialize_error: string;
  runtime_error: string;
  skipped: string;
  omnibuf_payload: Uint8Array;
  json_payload: string;
}

export const ConformanceRequestSchema: MessageSchema<ConformanceRequest> =
  defineMessage<ConformanceRequest>('ConformanceRequest', {
    test_name: { fieldNum: 1, type: 'string' },
    message_type: { fieldNum: 2, type: 'string' },
    tier: { fieldNum: 3, type: 'uint32' },
    requested_output_format: { fieldNum: 4, type: 'uint32' },
    omnibuf_payload: { fieldNum: 5, type: 'bytes' },
    json_payload: { fieldNum: 6, type: 'string' },
    self_describing: { fieldNum: 7, type: 'bool' },
    test_opaque_splice: { fieldNum: 8, type: 'bool' },
    test_opaque_splice_shrink: { fieldNum: 9, type: 'bool' },
  });

export const ConformanceResponseSchema: MessageSchema<ConformanceResponse> =
  defineMessage<ConformanceResponse>('ConformanceResponse', {
    parse_error: { fieldNum: 1, type: 'string' },
    serialize_error: { fieldNum: 2, type: 'string' },
    runtime_error: { fieldNum: 3, type: 'string' },
    skipped: { fieldNum: 4, type: 'string' },
    omnibuf_payload: { fieldNum: 5, type: 'bytes' },
    json_payload: { fieldNum: 6, type: 'string' },
  });

export const AllTypesSubMsgSchema: MessageSchema<any> = defineMessage('AllTypesSubMsg', {
  id: { fieldNum: 1, type: 'uint32' },
  label: { fieldNum: 2, type: 'string' },
  flag: { fieldNum: 3, type: 'bool' },
  score: { fieldNum: 4, type: 'sint64', wire: 'sint' },
});

export const TestAllTypesSchema: MessageSchema<any> = defineMessage('TestAllTypes', {
  f1_uint32: { fieldNum: 1, type: 'uint32' },
  f2_uint64: { fieldNum: 2, type: 'uint64' },
  f3_sint32: { fieldNum: 3, type: 'sint32', wire: 'sint' },
  f4_sint64: { fieldNum: 4, type: 'sint64', wire: 'sint' },
  f5_bool: { fieldNum: 5, type: 'bool' },
  f6_string: { fieldNum: 6, type: 'string' },
  f7_bytes: { fieldNum: 7, type: 'bytes' },
  f8_sub_msg: {
    fieldNum: 8,
    type: 'submsg',
    optional: true,
    subSchema: () => AllTypesSubMsgSchema,
  },
  f9_string_arr: { fieldNum: 9, type: 'string[]' },
  f10_uint32_arr: { fieldNum: 10, type: 'uint32[]' },
  f11_sub_msg_arr: { fieldNum: 11, type: 'submsg[]', subSchema: () => AllTypesSubMsgSchema },
  f12_map_str_uint: { fieldNum: 12, type: 'map', mapKey: 'string', mapVal: 'uint64' },
  f13_float32: { fieldNum: 13, type: 'float32' },
  f14_float64: { fieldNum: 14, type: 'float64' },
  f15_fixed32: { fieldNum: 15, type: 'fixed32', wire: 'fixed32' },
  f16_fixed64: { fieldNum: 16, type: 'fixed64', wire: 'fixed64' },
  f20_overflow_str: { fieldNum: 20, type: 'string' },
});

export const TreeNodeSchema: MessageSchema<any> = defineMessage('TreeNode', {
  id: { fieldNum: 1, type: 'uint32' },
  name: { fieldNum: 2, type: 'string' },
  weight: { fieldNum: 3, type: 'sint64', wire: 'sint' },
  primary: { fieldNum: 4, type: 'submsg', optional: true, subSchema: () => TreeNodeSchema },
  children: { fieldNum: 5, type: 'submsg[]', subSchema: () => TreeNodeSchema },
  branches: { fieldNum: 6, type: 'submsg[]', subSchema: () => TreeNodeSchema },
  labels: { fieldNum: 7, type: 'map', mapKey: 'string', mapVal: 'uint64' },
});

export const NestedNICSchema: MessageSchema<any> = defineMessage('NestedNIC', {
  if_index: { fieldNum: 1, type: 'uint32' },
  mac: { fieldNum: 2, type: 'string' },
  ips: { fieldNum: 3, type: 'uint32[]' },
});

export const NestedServerSchema: MessageSchema<any> = defineMessage('NestedServer', {
  server_id: { fieldNum: 1, type: 'uint32' },
  hostname: { fieldNum: 2, type: 'string' },
  nics: { fieldNum: 3, type: 'submsg[]', subSchema: () => NestedNICSchema },
});

export const NestedRackSchema: MessageSchema<any> = defineMessage('NestedRack', {
  rack_id: { fieldNum: 1, type: 'uint32' },
  zone: { fieldNum: 2, type: 'string' },
  servers: { fieldNum: 3, type: 'submsg[]', subSchema: () => NestedServerSchema },
});

export const NestedClusterSchema: MessageSchema<any> = defineMessage('NestedCluster', {
  cluster_name: { fieldNum: 1, type: 'string' },
  racks: { fieldNum: 2, type: 'submsg[]', subSchema: () => NestedRackSchema },
  epoch: { fieldNum: 3, type: 'uint64' },
});

/**
 * Built-in `FileDescriptorSetJSON` for `omnibuf.bench.PeerUpdate` and `omnibuf.conformance.TestAllTypes`
 * so the conformance adapter and Tier 2 / Tier 1 plugin tests work out of the box.
 */
export const CONFORMANCE_FDS: FileDescriptorSetJSON = {
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
          name: 'AllTypesSubMsg',
          field: [
            { name: 'id', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT32' },
            { name: 'label', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' },
            { name: 'flag', number: 3, label: 'LABEL_OPTIONAL', type: 'TYPE_BOOL' },
            { name: 'score', number: 4, label: 'LABEL_OPTIONAL', type: 'TYPE_SINT64' },
          ],
        },
        {
          name: 'TestAllTypes',
          field: [
            { name: 'f1_uint32', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT32' },
            { name: 'f2_uint64', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT64' },
            { name: 'f3_sint32', number: 3, label: 'LABEL_OPTIONAL', type: 'TYPE_SINT32' },
            { name: 'f4_sint64', number: 4, label: 'LABEL_OPTIONAL', type: 'TYPE_SINT64' },
            { name: 'f5_bool', number: 5, label: 'LABEL_OPTIONAL', type: 'TYPE_BOOL' },
            { name: 'f6_string', number: 6, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' },
            { name: 'f7_bytes', number: 7, label: 'LABEL_OPTIONAL', type: 'TYPE_BYTES' },
            {
              name: 'f8_sub_msg',
              number: 8,
              label: 'LABEL_OPTIONAL',
              type: 'TYPE_MESSAGE',
              typeName: '.omnibuf.conformance.AllTypesSubMsg',
            },
            { name: 'f9_string_arr', number: 9, label: 'LABEL_REPEATED', type: 'TYPE_STRING' },
            { name: 'f10_uint32_arr', number: 10, label: 'LABEL_REPEATED', type: 'TYPE_UINT32' },
            {
              name: 'f11_sub_msg_arr',
              number: 11,
              label: 'LABEL_REPEATED',
              type: 'TYPE_MESSAGE',
              typeName: '.omnibuf.conformance.AllTypesSubMsg',
            },
            {
              name: 'f12_map_str_uint',
              number: 12,
              label: 'LABEL_REPEATED',
              type: 'TYPE_MESSAGE',
              typeName: '.omnibuf.conformance.TestAllTypes.F12MapStrUintEntry',
            },
            { name: 'f13_float32', number: 13, label: 'LABEL_OPTIONAL', type: 'TYPE_FLOAT' },
            { name: 'f14_float64', number: 14, label: 'LABEL_OPTIONAL', type: 'TYPE_DOUBLE' },
            { name: 'f15_fixed32', number: 15, label: 'LABEL_OPTIONAL', type: 'TYPE_FIXED32' },
            { name: 'f16_fixed64', number: 16, label: 'LABEL_OPTIONAL', type: 'TYPE_FIXED64' },
            { name: 'f20_overflow_str', number: 20, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' },
          ],
          nestedType: [
            {
              name: 'F12MapStrUintEntry',
              options: { mapEntry: true },
              field: [
                { name: 'key', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' },
                { name: 'value', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT64' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export const LocationProtobufDesc: ProtobufDescMessage = {
  typeName: 'omnibuf.bench.Location',
  fields: [
    {
      number: 1,
      name: 'region',
      localName: 'region',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.STRING,
    },
    {
      number: 2,
      name: 'datacenter',
      localName: 'datacenter',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.STRING,
    },
    {
      number: 3,
      name: 'city',
      localName: 'city',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.STRING,
    },
    {
      number: 4,
      name: 'rack',
      localName: 'rack',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.UINT32,
    },
    {
      number: 5,
      name: 'latitude',
      localName: 'latitude',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.FLOAT,
    },
    {
      number: 6,
      name: 'longitude',
      localName: 'longitude',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.FLOAT,
    },
  ],
};

export const NeighborProtobufDesc: ProtobufDescMessage = {
  typeName: 'omnibuf.bench.Neighbor',
  fields: [
    {
      number: 1,
      name: 'peer_asn',
      localName: 'peerAsn',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.UINT32,
    },
    {
      number: 2,
      name: 'router',
      localName: 'router',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.STRING,
    },
    {
      number: 3,
      name: 'latency_us',
      localName: 'latencyUs',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.UINT32,
    },
    {
      number: 4,
      name: 'established',
      localName: 'established',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.BOOL,
    },
  ],
};

export const PeerUpdateProtobufDesc: ProtobufDescMessage = {
  typeName: 'omnibuf.bench.PeerUpdate',
  fields: [
    {
      number: 1,
      name: 'asn',
      localName: 'asn',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.UINT32,
    },
    {
      number: 2,
      name: 'router_id',
      localName: 'routerId',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.STRING,
    },
    {
      number: 3,
      name: 'active',
      localName: 'active',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.BOOL,
    },
    {
      number: 4,
      name: 'uptime_sec',
      localName: 'uptimeSec',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.UINT64,
    },
    {
      number: 5,
      name: 'rssi_dbm',
      localName: 'rssiDbm',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.SINT32,
    },
    {
      number: 6,
      name: 'cpu_load',
      localName: 'cpuLoad',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.DOUBLE,
    },
    {
      number: 7,
      name: 'tags',
      localName: 'tags',
      fieldKind: 'list',
      listKind: 'scalar',
      scalar: ProtoScalarType.STRING,
    },
    {
      number: 8,
      name: 'prefixes',
      localName: 'prefixes',
      fieldKind: 'list',
      listKind: 'scalar',
      scalar: ProtoScalarType.UINT32,
    },
    {
      number: 9,
      name: 'location',
      localName: 'location',
      fieldKind: 'message',
      message: LocationProtobufDesc,
    },
    {
      number: 10,
      name: 'neighbors',
      localName: 'neighbors',
      fieldKind: 'list',
      listKind: 'message',
      message: NeighborProtobufDesc,
    },
    {
      number: 11,
      name: 'sequence',
      localName: 'sequence',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.UINT64,
    },
  ],
};

export const AllTypesSubMsgProtobufDesc: ProtobufDescMessage = {
  typeName: 'omnibuf.conformance.AllTypesSubMsg',
  fields: [
    {
      number: 1,
      name: 'id',
      localName: 'id',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.UINT32,
    },
    {
      number: 2,
      name: 'label',
      localName: 'label',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.STRING,
    },
    {
      number: 3,
      name: 'flag',
      localName: 'flag',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.BOOL,
    },
    {
      number: 4,
      name: 'score',
      localName: 'score',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.SINT64,
    },
  ],
};

export const TestAllTypesProtobufDesc: ProtobufDescMessage = {
  typeName: 'omnibuf.conformance.TestAllTypes',
  fields: [
    {
      number: 1,
      name: 'f1_uint32',
      localName: 'f1Uint32',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.UINT32,
    },
    {
      number: 2,
      name: 'f2_uint64',
      localName: 'f2Uint64',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.UINT64,
    },
    {
      number: 3,
      name: 'f3_sint32',
      localName: 'f3Sint32',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.SINT32,
    },
    {
      number: 4,
      name: 'f4_sint64',
      localName: 'f4Sint64',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.SINT64,
    },
    {
      number: 5,
      name: 'f5_bool',
      localName: 'f5Bool',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.BOOL,
    },
    {
      number: 6,
      name: 'f6_string',
      localName: 'f6String',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.STRING,
    },
    {
      number: 7,
      name: 'f7_bytes',
      localName: 'f7Bytes',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.BYTES,
    },
    {
      number: 8,
      name: 'f8_sub_msg',
      localName: 'f8SubMsg',
      fieldKind: 'message',
      message: AllTypesSubMsgProtobufDesc,
    },
    {
      number: 9,
      name: 'f9_string_arr',
      localName: 'f9StringArr',
      fieldKind: 'list',
      listKind: 'scalar',
      scalar: ProtoScalarType.STRING,
    },
    {
      number: 10,
      name: 'f10_uint32_arr',
      localName: 'f10Uint32Arr',
      fieldKind: 'list',
      listKind: 'scalar',
      scalar: ProtoScalarType.UINT32,
    },
    {
      number: 11,
      name: 'f11_sub_msg_arr',
      localName: 'f11SubMsgArr',
      fieldKind: 'list',
      listKind: 'message',
      message: AllTypesSubMsgProtobufDesc,
    },
    {
      number: 12,
      name: 'f12_map_str_uint',
      localName: 'f12MapStrUint',
      fieldKind: 'map',
      mapKey: ProtoScalarType.STRING,
      mapKind: 'scalar',
      scalar: ProtoScalarType.UINT64,
    },
    {
      number: 13,
      name: 'f13_float32',
      localName: 'f13Float32',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.FLOAT,
    },
    {
      number: 14,
      name: 'f14_float64',
      localName: 'f14Float64',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.DOUBLE,
    },
    {
      number: 15,
      name: 'f15_fixed32',
      localName: 'f15Fixed32',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.FIXED32,
    },
    {
      number: 16,
      name: 'f16_fixed64',
      localName: 'f16Fixed64',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.FIXED64,
    },
    {
      number: 20,
      name: 'f20_overflow_str',
      localName: 'f20OverflowStr',
      fieldKind: 'scalar',
      scalar: ProtoScalarType.STRING,
    },
  ],
};

const defaultRegistry = new DescriptorRegistry(CONFORMANCE_FDS);

/**
 * Execute a single `ConformanceRequest` and return a `ConformanceResponse`.
 * Matches `cmd/conformance-go/main.go` across all 4 tiers (`TestTierBlind`, `TestTierPlugin`, `TestTierProtobufTypes`, `TestTierAnnotatedStruct`).
 */
export function handleConformanceRequest(
  req: Partial<ConformanceRequest>,
  _registry: DescriptorRegistry = defaultRegistry,
): ConformanceResponse {
  const resp = ConformanceResponseSchema.create();
  try {
    const payload = req.omnibuf_payload ?? new Uint8Array(0);
    const tier = req.tier ?? TestTierUnspecified;

    switch (tier) {
      case TestTierBlind: {
        try {
          decodeBlind(payload);
        } catch (err) {
          resp.parse_error = err instanceof Error ? err.message : String(err);
          return resp;
        }
        if (req.requested_output_format === WireFormatJSON) {
          resp.json_payload = decodeBlindJSON(payload, { fallbackOnNonFinite: true });
        }
        return resp;
      }

      case TestTierPlugin: {
        switch (req.message_type) {
          case 'omnibuf.bench.PeerUpdate': {
            const msg = createPeerUpdate({
              asn: 999999,
              routerId: 'stale-router',
              active: true,
              tags: ['stale-tag'],
              prefixes: [999],
              location: createLocation({ region: 'stale', city: 'stale-city', rack: 999 }),
              neighbors: [createNeighbor({ peerAsn: 999, router: 'stale-neighbor' })],
              sequence: 999999,
            });
            try {
              decodePeerUpdate(payload, msg);
            } catch (err) {
              resp.parse_error = err instanceof Error ? err.message : String(err);
              return resp;
            }
            const op = new OpaquePeerUpdate(payload);
            const opLoc = op.getLocation();
            if (
              op.getAsn() !== msg.asn ||
              op.getRouterId() !== msg.routerId ||
              op.getActive() !== msg.active ||
              BigInt(op.getUptimeSec()) !== BigInt(msg.uptimeSec) ||
              op.getRssiDbm() !== msg.rssiDbm ||
              !Object.is(op.getCpuLoad(), msg.cpuLoad) ||
              op.getTags().length !== msg.tags.length ||
              op.getPrefixes().length !== msg.prefixes.length ||
              (opLoc?.city ?? '') !== (msg.location?.city ?? '') ||
              op.getNeighbors().length !== msg.neighbors.length ||
              BigInt(op.getSequence()) !== BigInt(msg.sequence)
            ) {
              resp.parse_error = 'opaque PeerUpdate getter mismatch with decoded struct';
              return resp;
            }

            if (req.test_opaque_splice) {
              try {
                op.setAsn(1_000_000);
                op.setRouterId('edge-rtr-fra01-'.repeat(20));
                op.setActive(!op.getActive());
                op.setUptimeSec(0xffffffffffffffffn);
                op.setRssiDbm(-1_000_000);
                op.setCpuLoad(99.875);
                op.setTags(['tag-grow-a', 'tag-grow-b', 'long-tag-'.repeat(20)]);
                op.setPrefixes([100000, 200000, 300000, 400000, 500000, 600000]);
                op.setLocation({
                  $typeName: 'omnibuf.bench.Location',
                  region: 'eu-central-grown',
                  datacenter: 'fra-dc-'.repeat(25),
                  city: 'Berlin',
                  rack: 999999,
                  latitude: 52.52,
                  longitude: 13.405,
                });
                const curSeq = op.getSequence();
                const nextSeq = BigInt.asUintN(
                  64,
                  (typeof curSeq === 'bigint' ? curSeq : BigInt(curSeq)) + 1n,
                );
                op.setSequence(nextSeq <= 9007199254740991n ? Number(nextSeq) : nextSeq);
                resp.omnibuf_payload = op.marshal();
              } catch (err) {
                resp.serialize_error = err instanceof Error ? err.message : String(err);
              }
              return resp;
            }

            if (req.test_opaque_splice_shrink) {
              try {
                op.setAsn(1);
                op.setRouterId('r');
                op.setActive(false);
                op.setUptimeSec(5);
                op.setRssiDbm(-1);
                op.setCpuLoad(0.5);
                op.setTags(['t']);
                op.setPrefixes([1]);
                op.setLocation({
                  $typeName: 'omnibuf.bench.Location',
                  region: 'r',
                  datacenter: 'd',
                  city: 'c',
                  rack: 1,
                  latitude: 1.0,
                  longitude: 2.0,
                });
                op.setSequence(2);
                resp.omnibuf_payload = op.marshal();
              } catch (err) {
                resp.serialize_error = err instanceof Error ? err.message : String(err);
              }
              return resp;
            }

            try {
              resp.omnibuf_payload = marshalPeerUpdateOmniBuf(msg, {
                deterministic: true,
                selfDescribing: Boolean(req.self_describing),
              });
            } catch (err) {
              resp.serialize_error = err instanceof Error ? err.message : String(err);
            }
            return resp;
          }

          case 'omnibuf.conformance.TestAllTypes': {
            const msg = createTestAllTypes({
              f1Uint32: 999999,
              f5Bool: true,
              f6String: 'stale-str',
              f7Bytes: new Uint8Array([0xff]),
              f8SubMsg: createAllTypesSubMsg({
                id: 999,
                label: 'stale-sub',
                flag: true,
                score: -999,
              }),
              f9StringArr: ['stale'],
              f10Uint32Arr: [999],
              f11SubMsgArr: [createAllTypesSubMsg({ id: 999, label: 'stale-elem' })],
              f12MapStrUint: { stale: 999 },
              f20OverflowStr: 'stale-overflow',
            });
            try {
              decodeTestAllTypes(payload, msg);
            } catch (err) {
              resp.parse_error = err instanceof Error ? err.message : String(err);
              return resp;
            }
            const op = new OpaqueTestAllTypes(payload);
            void op.getF12MapStrUint();
            const opSub = op.getF8SubMsg();
            const wantSub = msg.f8SubMsg;
            const opBytes = op.getF7Bytes();
            let bytesMatch = opBytes.length === msg.f7Bytes.length;
            if (bytesMatch) {
              for (let i = 0; i < opBytes.length; i++) {
                if (opBytes[i] !== msg.f7Bytes[i]) {
                  bytesMatch = false;
                  break;
                }
              }
            }
            if (
              op.getF1Uint32() !== msg.f1Uint32 ||
              BigInt(op.getF2Uint64()) !== BigInt(msg.f2Uint64) ||
              op.getF3Sint32() !== msg.f3Sint32 ||
              BigInt(op.getF4Sint64()) !== BigInt(msg.f4Sint64) ||
              op.getF5Bool() !== msg.f5Bool ||
              op.getF6String() !== msg.f6String ||
              !bytesMatch ||
              (opSub?.id ?? 0) !== (wantSub?.id ?? 0) ||
              (opSub?.label ?? '') !== (wantSub?.label ?? '') ||
              (opSub?.flag ?? false) !== (wantSub?.flag ?? false) ||
              BigInt(opSub?.score ?? 0) !== BigInt(wantSub?.score ?? 0) ||
              op.getF9StringArr().length !== msg.f9StringArr.length ||
              op.getF10Uint32Arr().length !== msg.f10Uint32Arr.length ||
              op.getF11SubMsgArr().length !== msg.f11SubMsgArr.length ||
              !Object.is(op.getF13Float32(), msg.f13Float32) ||
              !Object.is(op.getF14Float64(), msg.f14Float64) ||
              op.getF15Fixed32() !== msg.f15Fixed32 ||
              BigInt(op.getF16Fixed64()) !== BigInt(msg.f16Fixed64) ||
              op.getF20OverflowStr() !== msg.f20OverflowStr
            ) {
              resp.parse_error = 'opaque TestAllTypes getter mismatch with decoded struct';
              return resp;
            }

            if (req.test_opaque_splice) {
              try {
                op.setF1Uint32(1_000_000);
                op.setF2Uint64(0xffffffffffffffffn);
                op.setF3Sint32(-1_000_000);
                op.setF4Sint64(-9223372036854775808n);
                op.setF5Bool(!op.getF5Bool());
                op.setF6String('grown-str-'.repeat(30));
                const f7 = new Uint8Array(260);
                for (let i = 0; i < 260; i += 2) {
                  f7[i] = 0xab;
                  f7[i + 1] = 0xcd;
                }
                op.setF7Bytes(f7);
                op.setF8SubMsg({
                  $typeName: 'omnibuf.conformance.AllTypesSubMsg',
                  id: 888888,
                  label: 'sub-grown-'.repeat(20),
                  flag: true,
                  score: -999999999,
                });
                op.setF9StringArr(['arr-grow-1', 'arr-grow-2', 'arr-grow-3-'.repeat(15)]);
                op.setF10Uint32Arr([100000, 200000, 300000, 400000, 500000]);
                op.setF11SubMsgArr([
                  {
                    $typeName: 'omnibuf.conformance.AllTypesSubMsg',
                    id: 100001,
                    label: 'elem0-'.repeat(25),
                    flag: true,
                    score: -500000,
                  },
                  {
                    $typeName: 'omnibuf.conformance.AllTypesSubMsg',
                    id: 100002,
                    label: 'elem1-grown',
                    flag: false,
                    score: 500000,
                  },
                ]);
                op.setF12MapStrUint({
                  k1: 1000000,
                  k2: 0xffffffffffffffffn,
                  k3_long_key: 424242,
                });
                op.setF13Float32(-1234.5);
                op.setF14Float64(3.141592653589793);
                op.setF15Fixed32(0xdeadbeef);
                op.setF16Fixed64(0xcafebabedeadbeefn);
                op.setF20OverflowStr('overflow20-'.repeat(20));
                resp.omnibuf_payload = op.marshal();
              } catch (err) {
                resp.serialize_error = err instanceof Error ? err.message : String(err);
              }
              return resp;
            }

            if (req.test_opaque_splice_shrink) {
              try {
                op.setF1Uint32(1);
                op.setF2Uint64(2);
                op.setF3Sint32(-1);
                op.setF4Sint64(-2);
                op.setF5Bool(false);
                op.setF6String('s');
                op.setF7Bytes(new Uint8Array([0x01]));
                op.setF8SubMsg({
                  $typeName: 'omnibuf.conformance.AllTypesSubMsg',
                  id: 1,
                  label: 'x',
                  flag: false,
                  score: -1,
                });
                op.setF9StringArr(['a']);
                op.setF10Uint32Arr([7]);
                op.setF11SubMsgArr([
                  {
                    $typeName: 'omnibuf.conformance.AllTypesSubMsg',
                    id: 1,
                    label: 'e',
                    flag: true,
                    score: 1,
                  },
                ]);
                op.setF12MapStrUint({ k: 1 });
                op.setF13Float32(0.5);
                op.setF14Float64(-0.25);
                op.setF15Fixed32(7);
                op.setF16Fixed64(9);
                op.setF20OverflowStr('z');
                resp.omnibuf_payload = op.marshal();
              } catch (err) {
                resp.serialize_error = err instanceof Error ? err.message : String(err);
              }
              return resp;
            }

            try {
              resp.omnibuf_payload = marshalTestAllTypesOmniBuf(msg, {
                deterministic: true,
                selfDescribing: Boolean(req.self_describing),
              });
            } catch (err) {
              resp.serialize_error = err instanceof Error ? err.message : String(err);
            }
            return resp;
          }

          default:
            resp.skipped = 'plugin tier generated for PeerUpdate and TestAllTypes';
            return resp;
        }
      }

      case TestTierProtobufTypes: {
        const desc =
          req.message_type === 'omnibuf.bench.PeerUpdate'
            ? PeerUpdateProtobufDesc
            : req.message_type === 'omnibuf.conformance.TestAllTypes'
              ? TestAllTypesProtobufDesc
              : null;
        if (!desc) {
          resp.skipped = 'protobuf types tier exercises pb.PeerUpdate and pb.TestAllTypes';
          return resp;
        }
        let msg;
        try {
          msg = fromBinary(desc, payload);
        } catch (err) {
          resp.parse_error = err instanceof Error ? err.message : String(err);
          return resp;
        }
        try {
          resp.omnibuf_payload = toBinary(desc, msg, {
            deterministic: true,
            selfDescribing: Boolean(req.self_describing),
          });
        } catch (err) {
          resp.serialize_error = err instanceof Error ? err.message : String(err);
        }
        return resp;
      }

      case TestTierAnnotatedStruct: {
        const opts = {
          deterministic: true,
          selfDescribing: Boolean(req.self_describing),
        };
        let targetSchema: MessageSchema<any>;
        switch (req.message_type) {
          case 'omnibuf.bench.PeerUpdate':
            targetSchema = PeerUpdateSchema;
            break;
          case 'omnibuf.conformance.TreeNode':
            targetSchema = TreeNodeSchema;
            break;
          case 'omnibuf.conformance.NestedCluster':
            targetSchema = NestedClusterSchema;
            break;
          default:
            targetSchema = TestAllTypesSchema;
            break;
        }
        let msg;
        try {
          msg = targetSchema.decode(payload);
        } catch (err) {
          resp.parse_error = err instanceof Error ? err.message : String(err);
          return resp;
        }
        try {
          resp.omnibuf_payload = targetSchema.encode(msg, opts);
        } catch (err) {
          resp.serialize_error = err instanceof Error ? err.message : String(err);
        }
        return resp;
      }

      default:
        resp.runtime_error = `unsupported tier: ${tier}`;
        return resp;
    }
  } catch (err) {
    resp.runtime_error = err instanceof Error ? err.message : String(err);
    return resp;
  }
}
