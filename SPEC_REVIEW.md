# Specification review

Reviewed against `/Users/kevin/Projects/omnibuf/web/src/pages/spec.astro` on 2026-10-25.

**Status: Complete implementation of the specification.** All initial corrections and all five compliance gaps identified in the review have been resolved and verified against both unit/regression tests and the official 178-case conformance corpus.

## Corrections made

- Sections 2 and 8: recursively merge nested messages, including repeated fields and maps within later occurrences. Blind decoding previously used a shallow object assignment; typed decoding restarted repeated-field accumulation inside each nested occurrence.
- Sections 5 and 7: preserve field numbers beyond 65,535, avoid truncating tags through JavaScript 32-bit arithmetic, and splice fields with four- and nine-byte tags. Replacing duplicate repeated occurrences now emits the replacement once. Splicing rejects truncated input instead of silently retaining it.
- Sections 6.5-6.8 and 11: generate encoders for repeated booleans and bytes and honor declared map key/value types, including message values. Previously maps always used string-to-uint encoding and schema defaults. Generated 64-bit interfaces accept bigint, and opaque 64-bit access no longer converts exact values through number-only readers.
- Sections 6.3 and 10: calculate UTF-8 lengths correctly for unpaired UTF-16 surrogates in the core and browser codecs.
- Sections 6.8 and 10: reject invalid map type headers even for empty maps. Boolean maps use WireUint payloads, since the specification excludes boolean tags from MapType. Typed map decoding preserves float and signed-fixed interpretations. Special string keys such as `__proto__` remain own data properties.
- Section 10: validate Field #0 structure in typed decoding. Validate unknown array/map/submessage contents and nesting depth without allocating decoded collections. Unknown extensions remain skippable, while blind decoding rejects unrecognized subtypes. Header-hop lookup remains a separate lightweight operation.

## Resolved compliance gaps

1. **General plugin type resolution (sections 1.1 and 11.1).** `packages/protoc-gen-omnibuf-es/src/generator.ts` now recursively walks nested non-map messages and enums (`Outer_Inner`), resolves qualified type symbols across the `FileDescriptorSet` to avoid short-name collisions, emits relative `.js` imports for cross-file `.proto` dependencies, and generates TypeScript `enum` declarations.
2. **Generated decoder architecture and lazy access (section 11.1).** `packages/protoc-gen-omnibuf-es/src/generator.ts` and `packages/omnibuf-node/src/gen/peer_omnibuf.pb.ts` now emit reflection-free tag-loop decoders (`decode<Message>()`) with `switch (fieldNum)` and `validateSkippedPayload` for unknown fields, as well as consistently lazy $O(1)$ header-hop `Opaque<Message>` getters backed by `readSubMsgMerged`, `readSubMsgArrDecoded`, `readTypedMap`, `readBytesArr`, `readBoolArr`, `readFixed32Arr`, `readSfixed32Arr`, `readFixed64Arr`, and `readSfixed64Arr` without falling back to `MessageSchema.decode(this._raw)`.
3. **Standard Protobuf semantics and recursive descriptors (sections 1.1 and 11.1).** `packages/omnibuf/src/schema.ts`, `packages/omnibuf/src/protobuf-es.ts`, and `packages/protoc-gen-omnibuf-es/src/generator.ts` now model `@bufbuild/protobuf` v2 `oneof` `{ case, value }` discriminated unions, `proto3_optional` explicit scalar presence (`undefined` when unset, encoded on wire even when `0`/`""`/`false`), 2-argument `clearField(msg, descField)`, and cycle-safe `create()` on recursive message descriptors.
4. **Deep self-description (section 8).** `MessageSchema.getSchemaMeta()` in `packages/omnibuf/src/schema.ts` now expands `Field #0` `SchemaMeta` up to `MaxNestingDepth` (32), following the actual populated structure of the message instance on recursive schemas and terminating unpopulated cycle edges cleanly without exponential blowup.
5. **Exact blind JSON on all runtimes (section 1.1's lossless inspection goal).** `stringifyBlindJSON()` in `packages/omnibuf/src/blind.ts` now uses a direct recursive JSON serializer that emits exact 64-bit `bigint` decimal tokens and `"-0"` directly without depending on `JSON.rawJSON`.

## Verification

- `pnpm run build && pnpm run typecheck`: passed across all workspace packages.
- `node --import tsx --test packages/*/test/*.test.ts`: **34 tests passed**, including dedicated regression tests for recursive deep self-description (`Field #0` up to depth 32), runtime-independent `stringifyBlindJSON` (`bigint` and `-0.0` without `JSON.rawJSON`), real `@bufbuild/protobuf` v2 descriptors with `oneof`, `proto3_optional`, and recursive `TreeNode` messages, and multi-file `.proto` code generation with colliding nested names, enums, oneofs, and reflection-free decoders.
- Official runner against `/Users/kevin/Projects/omnibuf/testdata/conformance_corpus.json`: **178 passed, 0 skipped, 0 failed** (plugin 27, Protobuf types 27, declarative 61, blind 63).
