# OmniBuf for TypeScript & JavaScript (`omnibuf-es`)

[![CI](https://github.com/sudorandom/omnibuf-es/actions/workflows/ci.yml/badge.svg)](https://github.com/sudorandom/omnibuf-es/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Website](https://img.shields.io/badge/website-omnibuf.com-111111?style=flat&labelColor=111111&color=D4FF33)](https://omnibuf.com/es)

TypeScript and ECMAScript implementation of the **OmniBuf** wire format specification.

OmniBuf is a binary wire format and Protobuf encoding designed for the hardware instructions and memory hierarchies of modern CPUs:

- **Prefix-Varints (`TZCNT` / `Math.clz32`)**: All variable-length integers and tags place their byte-length metadata in the lowest bits of the first byte (`1`, `2`, `4`, or `9` bytes little-endian), eliminating 7-bit continuation loops.
- **16 Explicit 4-Bit Wire Types (`0..15`)**: Explicit length headers on every variable-length container (`string`, `bytes`, `submsg`, `array`, `map`, `extended`) and distinct scalar fixed/float wire types enable $O(1)$ header-hop field skipping.
- **Single-Pass Serialization**: Overlong 2-byte Prefix-Varint length reservations allow single-pass forward buffer construction with $O(1)$ 16-bit little-endian backpatching.
- **Zero-Decode Routing & Splicing**: `locateField` and `spliceFields` inspect or mutate individual fields in a serialized packet without decoding untouched fields.
- **Self-Describing Mode (`Field #0`)**: Optional inline `SchemaMeta` (`Tag = 0x19`) enables schema-less `decodeBlind` / `decodeBlindJSON` inspection.

---

## Packages

| Package                                                              | Path                             | Description                                                                                                                                                                                                                                                |
| :------------------------------------------------------------------- | :------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@omnibuf/core`](./packages/omnibuf)                                | `packages/omnibuf`               | Environment-agnostic wire primitives, single-pass `Encoder`, $O(1)$ header-hopping readers, `decodeBlind`, Tier 2 (`@bufbuild/protobuf` & `FileDescriptorSet`), and Tier 3 (`defineMessage` & `@omnibufMessage` / `@omnibufField` decorators).             |
| [`@omnibuf/web`](./packages/omnibuf-web)                             | `packages/omnibuf-web`           | Browser & frontend package: `BrowserStringCodec` (`TextEncoder.encodeInto`), Web Streams framing (`createOmniBufEncodeStream`, `createOmniBufDecodeStream`), `Blob`/`Response`/`ArrayBuffer`/`DataURL` helpers, and `inspectPacket` for frontend devtools. |
| [`@omnibuf/node`](./packages/omnibuf-node)                           | `packages/omnibuf-node`          | Node.js package: `NodeBufferStringCodec`, Node `Readable`/`Writable`/`Transform` stream framing (`writeFrame`, `readFrames`), `.fds.json`/`.fds.pb.gz` descriptor loaders, and the cross-language conformance adapter (`omnibuf-conformance-es`).          |
| [`@omnibuf/protoc-gen-omnibuf-es`](./packages/protoc-gen-omnibuf-es) | `packages/protoc-gen-omnibuf-es` | Tier 1 `protoc` / `buf` compiler plugin generating single-pass encoders, decoders, and lazy `Opaque<Message>` views with `spliceFields`.                                                                                                                   |

---

## `protobuf-es` v2 Message Structure & Runtime API

Messages in `@omnibuf/core` follow the **`protobuf-es` (`@bufbuild/protobuf` v2)** plain-object message design:

- Every message is a plain ECMAScript object implementing `Message<TypeName>` with `$typeName` and optional `$unknown: UnknownField[]`.
- Field properties use `localName` (`camelCase`, e.g., `routerId`, `uptimeSec`, `rssiDbm`, `cpuLoad`, `peerAsn`, `latencyUs`), while `Field #0` (`SchemaMeta`) on the wire emits `.proto` `snake_case` field names (`router_id`, `uptime_sec`, etc.). Both `camelCase` and `snake_case` accessors work on message instances.
- Standard `protobuf-es` v2 functions work across Tier 1 generated schemas, Tier 2 `@bufbuild/protobuf` `DescMessage` descriptors, and Tier 3 `defineMessage` / `@omnibufMessage` schemas:
  - `create(schema, init?)`
  - `toBinary(schema, message, options?)`
  - `fromBinary(schema, bytes, options?)`
  - `mergeFromBinary(schema, target, bytes, options?)`
  - `isMessage(value, schema?)`
  - `clone(schema, message)`
  - `equals(schema, a, b, options?)`
  - `clearField(schema, message, fieldNameOrNum)`

---

## Three Integration Tiers

### Tier 1: Generated Code (`@omnibuf/protoc-gen-omnibuf-es`)

Generates `Message<TypeName>` interfaces, `<Msg>Schema`, `create<Msg>`, single-pass `encode<Msg>`, `decode<Msg>`, and lazy `Opaque<Msg>` wrappers with dirty-bitmask tracking and zero-decode `spliceFields` re-serialization:

```ts
import { OpaquePeerUpdate, PeerUpdateSchema } from '@omnibuf/node';
import { create, toBinary, fromBinary } from '@omnibuf/core';

const msg = create(PeerUpdateSchema, {
  asn: 64512,
  routerId: 'edge-rtr-fra01.core.backbone.net',
  active: true,
});
const packetBytes = toBinary(PeerUpdateSchema, msg, { selfDescribing: true });

const view = new OpaquePeerUpdate(packetBytes);
if (view.getActive() && view.getAsn() === 64512) {
  view.setSequence(99);
  const forwardedBytes = view.marshal(); // Zero-decode splice of field #11 only
}
```

### Tier 2: Existing Protobuf Types (`@bufbuild/protobuf` or `FileDescriptorSet`)

Use `create`, `toBinary`, `fromBinary`, `marshalProto`, or `unmarshalProto` directly with `@bufbuild/protobuf` `DescMessage` descriptors, or `DescriptorRegistry` with `.fds.json` / `.fds.pb.gz` files:

```ts
import { create, toBinary, fromBinary } from '@omnibuf/core';

const msg = create(PeerUpdateDesc, { asn: 64512, routerId: 'rtr-01' });
const bytes = toBinary(PeerUpdateDesc, msg, { selfDescribing: true });
const decoded = fromBinary(PeerUpdateDesc, bytes);
```

### Tier 3: Native TypeScript Classes & Schemas (`defineMessage` / `@omnibufMessage`)

No `.proto` files required. Use declarative `defineMessage` schemas or TypeScript `@omnibufMessage` / `@omnibufField` decorators:

```ts
import { defineMessage, create, toBinary, fromBinary, type Message } from '@omnibuf/core';

interface Peer extends Message<'app.Peer'> {
  peerId: number;
  ipAddress: string;
  active: boolean;
}

const PeerSchema = defineMessage<Peer, 'app.Peer'>('app.Peer', {
  peerId: { fieldNum: 1, name: 'peer_id', type: 'uint32' },
  ipAddress: { fieldNum: 2, name: 'ip_address', type: 'string' },
  active: { fieldNum: 3, type: 'bool' },
});

const peer = create(PeerSchema, { peerId: 42, ipAddress: '10.0.1.42', active: true });
const packet = toBinary(PeerSchema, peer, { selfDescribing: true });
const decoded = fromBinary(PeerSchema, packet);
```

---

## Development & Conformance Testing

```bash
just install
just fmt-check
just lint
just build
just test
just conformance
```

The conformance runner and shared corpus are pinned to upstream OmniBuf revision
`51e21054466e649501c42ddf63196ad1ea41c72b`. The first run downloads and builds the
runner with Go; subsequent runs reuse the binary cached by revision under `bin/`.
Set `CONFORMANCE_RUNNER` to an existing runner binary to test another version.
When updating the suite, update both the revision in `scripts/run-conformance.mjs`
and `testdata/conformance_corpus.json` from the same upstream commit.

---

## License

Released under the [MIT License](./LICENSE).
