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
  marshalPeerUpdateOmniBuf,
  unmarshalPeerUpdateOmniBuf,
} from './gen/peer_omnibuf.pb.js';

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
        if (req.message_type !== 'omnibuf.bench.PeerUpdate') {
          resp.skipped = 'plugin tier generated for omnibuf.bench.PeerUpdate';
          return resp;
        }
        let msg;
        try {
          msg = unmarshalPeerUpdateOmniBuf(payload);
        } catch (err) {
          resp.parse_error = err instanceof Error ? err.message : String(err);
          return resp;
        }
        // Also exercise lazy OpaquePeerUpdate getters to verify zero-panic conformance
        const op = new OpaquePeerUpdate(payload);
        void op.getAsn();
        void op.getRouterId();
        void op.getActive();
        void op.getSequence();

        if (req.test_opaque_splice) {
          try {
            op.setAsn(1_000_000);
            op.setRouterId('edge-rtr-fra01-'.repeat(20));
            op.setUptimeSec(0xffffffffffffffffn);
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

      case TestTierProtobufTypes: {
        if (req.message_type !== 'omnibuf.bench.PeerUpdate') {
          resp.skipped = 'protobuf types tier exercises pb.PeerUpdate';
          return resp;
        }
        let msg;
        try {
          msg = fromBinary(PeerUpdateProtobufDesc, payload);
        } catch (err) {
          resp.parse_error = err instanceof Error ? err.message : String(err);
          return resp;
        }
        try {
          resp.omnibuf_payload = toBinary(PeerUpdateProtobufDesc, msg, {
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
