import {
  getClassSchema,
  type BinaryReadOptions,
  type BinaryWriteOptions,
  type MarshalOptions,
  type MessageInitShape,
  type MessageSchema,
  type MessageShape,
} from './schema.js';
import {
  marshalProto,
  schemaFromProtobufDesc,
  unmarshalProto,
  type ProtobufDescMessage,
} from './protobuf-es.js';

export type EncodeOptions = BinaryWriteOptions;

/**
 * Schema input accepted by `create`, `toBinary`, `fromBinary`, `mergeFromBinary`, `clone`, `equals`, `clearField`.
 * Works with OmniBuf `MessageSchema<T>`, `@bufbuild/protobuf` `DescMessage` / `GenMessage<T>`, or `@omnibufMessage` classes.
 */
export type SchemaInput<T extends object = Record<string, any>> =
  MessageSchema<T> | ProtobufDescMessage | (new (...args: any[]) => T);

function resolveSchema<T extends object>(schema: SchemaInput<T>): MessageSchema<T> {
  if (isMessageSchema<T>(schema)) {
    return schema;
  }
  if (isProtobufDesc(schema)) {
    return schemaFromProtobufDesc<T>(schema);
  }
  if (typeof schema === 'function') {
    const clsSchema = getClassSchema<T>(schema);
    if (!clsSchema) {
      throw new Error(
        `omnibuf: class ${schema.name || '<anonymous>'} is not decorated with @omnibufMessage or @omnibufField`,
      );
    }
    return clsSchema;
  }
  throw new Error('omnibuf: invalid schema passed to runtime function');
}

/**
 * Create a new message instance of `schema`, optionally initialized from `init`.
 * Modeled after `@bufbuild/protobuf` v2 `create(schema, init?)`.
 *
 * - Sets `$typeName` to `schema.typeName`.
 * - Initializes all fields to their default values (`0`, `""`, `false`, `[]`, `{}`).
 * - If `init` is already a message of `schema` (`isMessage(init, schema)`), returns `init` directly without cloning.
 * - Recursively converts nested message initializers.
 */
export function create<S extends SchemaInput<any>>(
  schema: S,
  init?: MessageInitShape<S>,
): MessageShape<S> {
  const resolved = resolveSchema(schema);
  return resolved.create(init) as MessageShape<S>;
}

const DEFAULT_WRITE_OPTIONS: BinaryWriteOptions = {
  writeUnknownFields: true,
};

/**
 * Serialize `message` into OmniBuf binary wire format (`Uint8Array`).
 * Modeled after `@bufbuild/protobuf` v2 `toBinary(schema, message, options?)`.
 *
 * By default (`writeUnknownFields: true`), any unrecognized fields stored in `message.$unknown`
 * are written back out to the wire.
 */
export function toBinary<T extends object>(
  schema: SchemaInput<T>,
  message: T,
  options?: BinaryWriteOptions,
): Uint8Array {
  const resolved = resolveSchema<T>(schema);
  return resolved.encode(
    message,
    options === undefined
      ? DEFAULT_WRITE_OPTIONS
      : {
          writeUnknownFields: true,
          ...options,
        },
  );
}

/**
 * Parse serialized OmniBuf binary data into a new message instance.
 * Modeled after `@bufbuild/protobuf` v2 `fromBinary(schema, bytes, options?)`.
 *
 * By default (`readUnknownFields: true`), any unrecognized fields are retained in `message.$unknown`.
 */
export function fromBinary<T extends object>(
  schema: SchemaInput<T>,
  bytes: Uint8Array,
  options?: BinaryReadOptions,
): T {
  const resolved = resolveSchema<T>(schema);
  return resolved.decode(bytes, undefined, 0, options);
}

/**
 * Parse serialized OmniBuf binary data, merging fields into an existing `target` message.
 * Modeled after `@bufbuild/protobuf` v2 `mergeFromBinary(schema, target, bytes, options?)`.
 *
 * - Singular scalar fields overwrite existing values ("last write wins").
 * - Repeated fields are appended.
 * - Map entries are merged (overwriting existing keys).
 * - Nested message fields are merged recursively.
 */
export function mergeFromBinary<T extends object>(
  schema: SchemaInput<T>,
  target: T,
  bytes: Uint8Array,
  options?: BinaryReadOptions,
): T {
  const resolved = resolveSchema<T>(schema);
  const targetAny = target as any;
  if (
    targetAny &&
    typeof targetAny.$typeName === 'string' &&
    targetAny.$typeName !== resolved.typeName &&
    targetAny.$typeName !== resolved.shortName
  ) {
    throw new Error(
      `omnibuf: cannot merge ${resolved.typeName} into foreign message ${targetAny.$typeName}`,
    );
  }
  return resolved.decode(bytes, target, 0, {
    readUnknownFields: true,
    merge: true,
    ...options,
  });
}

/**
 * Create a deep copy of `message`, including nested sub-messages, arrays, maps, `Uint8Array` bytes, and `$unknown` fields.
 * Modeled after `@bufbuild/protobuf` v2 `clone(schema, message)`.
 */
export function clone<T extends object>(schema: SchemaInput<T>, message: T): T {
  const resolved = resolveSchema<T>(schema);
  return resolved.clone(message);
}

/**
 * Compare two messages of the same schema for deep equality.
 * Modeled after `@bufbuild/protobuf` v2 `equals(schema, a, b, options?)`.
 */
export function equals<T extends object>(
  schema: SchemaInput<T>,
  a: T | null | undefined,
  b: T | null | undefined,
  options?: { unknown?: boolean },
): boolean {
  const resolved = resolveSchema<T>(schema);
  return resolved.equals(a, b, options);
}

/**
 * Reset a field on `message` back to its default/zero value.
 * Supports both:
 * - `clearField(schema, message, fieldNameOrNum)`
 * - `clearField(message, descField)` (matching `@bufbuild/protobuf` v2 2-argument signature)
 */
export function clearField<T extends object>(
  schemaOrMessage: SchemaInput<T> | T,
  messageOrField: T | { readonly number: number; readonly parent?: ProtobufDescMessage },
  fieldNameOrNum?: keyof T | string | number | { readonly number: number },
): void {
  if (
    fieldNameOrNum === undefined &&
    typeof messageOrField === 'object' &&
    messageOrField !== null &&
    'number' in messageOrField &&
    'parent' in messageOrField &&
    messageOrField.parent
  ) {
    const resolved = resolveSchema<T>(messageOrField.parent);
    resolved.clearField(schemaOrMessage as T, messageOrField.number);
    return;
  }
  const resolved = resolveSchema<T>(schemaOrMessage as SchemaInput<T>);
  resolved.clearField(
    messageOrField as T,
    fieldNameOrNum as keyof T | string | number | { readonly number: number },
  );
}

/**
 * Interface implemented by Tier 1 generated messages or custom self-codecs.
 */
export interface OmniBufCodec<T> {
  encode(msg: T, options?: MarshalOptions): Uint8Array;
  decode(buf: Uint8Array): T;
}

function isProtobufDesc(val: unknown): val is ProtobufDescMessage {
  return (
    typeof val === 'object' &&
    val !== null &&
    'typeName' in val &&
    'fields' in val &&
    Array.isArray((val as ProtobufDescMessage).fields) &&
    typeof (val as any).encode !== 'function'
  );
}

function isMessageSchema<T extends object>(val: unknown): val is MessageSchema<T> {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as MessageSchema<T>).encode === 'function' &&
    typeof (val as MessageSchema<T>).decode === 'function'
  );
}

/**
 * Unified `marshal` entry point supporting all three OmniBuf integration tiers:
 * - **Tier 1**: Generated `OmniBufCodec<T>` or object with `.marshalOmniBuf(options?)`
 * - **Tier 2**: `@bufbuild/protobuf` `DescMessage` + message object
 * - **Tier 3**: `MessageSchema<T>` (`defineMessage`) or `@omnibufMessage` decorated class instance
 */
export function marshal<T extends object>(
  msgOrSchema: T | MessageSchema<T> | ProtobufDescMessage | OmniBufCodec<T>,
  msgOrOptions?: T | MarshalOptions,
  maybeOptions?: MarshalOptions,
): Uint8Array {
  if (isMessageSchema<T>(msgOrSchema)) {
    return msgOrSchema.encode(msgOrOptions as T, maybeOptions);
  }
  if (isProtobufDesc(msgOrSchema)) {
    return marshalProto(msgOrSchema, msgOrOptions as T, maybeOptions);
  }
  const instance = msgOrSchema as any;
  const options = msgOrOptions as MarshalOptions | undefined;
  if (typeof instance.marshalOmniBuf === 'function') {
    return instance.marshalOmniBuf(options);
  }
  if (instance.constructor) {
    const schema = getClassSchema<T>(instance.constructor);
    if (schema) {
      return schema.encode(instance, options);
    }
  }
  throw new Error(
    'omnibuf: marshal requires a MessageSchema, ProtobufDescMessage, @omnibufMessage class instance, or object implementing marshalOmniBuf()',
  );
}

/**
 * Unified `marshalDeterministic` entry point (sorts map keys before serialization).
 */
export function marshalDeterministic<T extends object>(
  msgOrSchema: T | MessageSchema<T> | ProtobufDescMessage | OmniBufCodec<T>,
  msgOrOptions?: T | MarshalOptions,
  maybeOptions?: MarshalOptions,
): Uint8Array {
  if (isMessageSchema<T>(msgOrSchema)) {
    return msgOrSchema.encode(msgOrOptions as T, { ...maybeOptions, deterministic: true });
  }
  if (isProtobufDesc(msgOrSchema)) {
    return marshalProto(msgOrSchema, msgOrOptions as T, {
      ...maybeOptions,
      deterministic: true,
    });
  }
  return marshal(msgOrSchema as T, {
    ...(msgOrOptions as MarshalOptions | undefined),
    deterministic: true,
  });
}

/**
 * Unified `unmarshal` entry point supporting:
 * - **Tier 1**: Generated `OmniBufCodec<T>`
 * - **Tier 2**: `@bufbuild/protobuf` `DescMessage`
 * - **Tier 3**: `MessageSchema<T>` (`defineMessage`) or `@omnibufMessage` decorated class constructor
 */
export function unmarshal<T extends object>(
  buf: Uint8Array,
  target: MessageSchema<T> | ProtobufDescMessage | OmniBufCodec<T> | (new (...args: any[]) => T),
): T {
  if (isMessageSchema<T>(target)) {
    return target.decode(buf);
  }
  if (isProtobufDesc(target)) {
    return unmarshalProto<T>(target, buf);
  }
  if (typeof target === 'function') {
    const schema = getClassSchema<T>(target);
    if (!schema) {
      throw new Error(
        `omnibuf: class ${target.name || '<anonymous>'} is not decorated with @omnibufMessage or @omnibufField`,
      );
    }
    return schema.decode(buf);
  }
  throw new Error('omnibuf: unsupported target passed to unmarshal');
}

/**
 * Raw concatenation merge semantics (`append(msgA, msgB)`).
 * Per Section 6 of the OmniBuf specification, merging two messages of the same type
 * is raw byte concatenation without decoding or re-encoding:
 * - For singular fields, `locateField` scans sequentially and returns the last occurrence ("last write wins").
 * - If both packets carry `Field #0` (`SchemaMeta`), readers automatically merge their metadata trees.
 */
export function concatMessages(...packets: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (let i = 0; i < packets.length; i++) {
    totalLen += packets[i]!.length;
  }
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (let i = 0; i < packets.length; i++) {
    out.set(packets[i]!, offset);
    offset += packets[i]!.length;
  }
  return out;
}
