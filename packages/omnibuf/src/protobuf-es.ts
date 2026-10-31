import { base64ToUint8Array, readField0SchemaMeta, uint8ArrayToBase64 } from './blind.js';
import { MaxNestingDepth, decodeUTF8 } from './wire.js';
import {
  defineMessage,
  protoCamelCase,
  safeObjectProperty,
  type ArrayFieldType,
  type BinaryReadOptions,
  type BinaryWriteOptions,
  type FieldSpec,
  type MarshalOptions,
  type MessageSchema,
  type ScalarFieldType,
} from './schema.js';

/**
 * Minimal structural typing for `@bufbuild/protobuf` v1 & v2 `DescMessage` and `DescField`.
 */
export interface ProtobufDescField {
  readonly number: number;
  readonly name: string;
  readonly localName?: string;
  readonly jsonName?: string;
  readonly protoName?: string;
  readonly fieldKind: 'scalar' | 'enum' | 'message' | 'list' | 'map';
  readonly scalar?: number;
  readonly listKind?: 'scalar' | 'enum' | 'message';
  readonly message?: ProtobufDescMessage;
  readonly mapKey?: number;
  readonly mapKind?: 'scalar' | 'enum' | 'message';
  readonly longAsString?: boolean;
  readonly presence?: number | string;
  readonly opt?: boolean;
  readonly proto?: {
    readonly proto3Optional?: boolean;
  };
  readonly oneof?: {
    readonly name: string;
    readonly localName?: string;
  };
  readonly mapValue?: {
    readonly kind: 'scalar' | 'enum' | 'message';
    readonly scalar?: number;
    readonly message?: ProtobufDescMessage;
  };
}

export interface ProtobufDescMessage {
  readonly typeName: string;
  readonly fields: readonly ProtobufDescField[];
}

/**
 * JSON or binary-decoded `google.protobuf.FileDescriptorSet` structure.
 */
export interface FileDescriptorSetJSON {
  file?: FileDescriptorProtoJSON[];
}

export interface FileDescriptorProtoJSON {
  name?: string;
  package?: string;
  dependency?: string[];
  messageType?: DescriptorProtoJSON[];
  enumType?: EnumDescriptorProtoJSON[];
  syntax?: string;
}

export interface EnumDescriptorProtoJSON {
  name?: string;
  value?: Array<{ name?: string; number?: number }>;
}

export interface OneofDescriptorProtoJSON {
  name?: string;
}

export interface DescriptorProtoJSON {
  name?: string;
  field?: FieldDescriptorProtoJSON[];
  nestedType?: DescriptorProtoJSON[];
  enumType?: EnumDescriptorProtoJSON[];
  oneofDecl?: OneofDescriptorProtoJSON[];
  options?: {
    mapEntry?: boolean;
  };
}

export interface FieldDescriptorProtoJSON {
  name?: string;
  number?: number;
  label?: string | number;
  type?: string | number;
  typeName?: string;
  jsonName?: string;
  oneofIndex?: number;
  proto3Optional?: boolean;
}

/**
 * Protobuf ScalarType numbers (matching `google.protobuf.FieldDescriptorProto.Type` & `@bufbuild/protobuf` `ScalarType`).
 */
export const ProtoScalarType = {
  DOUBLE: 1,
  FLOAT: 2,
  INT64: 3,
  UINT64: 4,
  INT32: 5,
  FIXED64: 6,
  FIXED32: 7,
  BOOL: 8,
  STRING: 9,
  GROUP: 10,
  MESSAGE: 11,
  BYTES: 12,
  UINT32: 13,
  ENUM: 14,
  SFIXED32: 15,
  SFIXED64: 16,
  SINT32: 17,
  SINT64: 18,
} as const;

export function parseFieldDescriptorType(t: string | number | undefined): number {
  if (typeof t === 'number') return t;
  switch (t) {
    case 'TYPE_DOUBLE':
      return ProtoScalarType.DOUBLE;
    case 'TYPE_FLOAT':
      return ProtoScalarType.FLOAT;
    case 'TYPE_INT64':
      return ProtoScalarType.INT64;
    case 'TYPE_UINT64':
      return ProtoScalarType.UINT64;
    case 'TYPE_INT32':
      return ProtoScalarType.INT32;
    case 'TYPE_FIXED64':
      return ProtoScalarType.FIXED64;
    case 'TYPE_FIXED32':
      return ProtoScalarType.FIXED32;
    case 'TYPE_BOOL':
      return ProtoScalarType.BOOL;
    case 'TYPE_STRING':
      return ProtoScalarType.STRING;
    case 'TYPE_GROUP':
      return ProtoScalarType.GROUP;
    case 'TYPE_MESSAGE':
      return ProtoScalarType.MESSAGE;
    case 'TYPE_BYTES':
      return ProtoScalarType.BYTES;
    case 'TYPE_UINT32':
      return ProtoScalarType.UINT32;
    case 'TYPE_ENUM':
      return ProtoScalarType.ENUM;
    case 'TYPE_SFIXED32':
      return ProtoScalarType.SFIXED32;
    case 'TYPE_SFIXED64':
      return ProtoScalarType.SFIXED64;
    case 'TYPE_SINT32':
      return ProtoScalarType.SINT32;
    case 'TYPE_SINT64':
      return ProtoScalarType.SINT64;
    default:
      throw new Error(`omnibuf: unsupported FieldDescriptorProto.Type: ${String(t)}`);
  }
}

function isRepeatedLabel(label: string | number | undefined): boolean {
  return label === 3 || label === 'LABEL_REPEATED';
}

function shortMessageName(typeName: string): string {
  const clean = typeName.replace(/^\./, '');
  const parts = clean.split('.');
  return parts[parts.length - 1] || clean;
}

function scalarTypeFromProto(protoType: number): {
  scalar: ScalarFieldType;
  array: ArrayFieldType;
} {
  switch (protoType) {
    case ProtoScalarType.UINT32:
      return { scalar: 'uint32', array: 'uint32[]' };
    case ProtoScalarType.UINT64:
      return { scalar: 'uint64', array: 'uint64[]' };
    case ProtoScalarType.INT32:
      return { scalar: 'int32', array: 'int32[]' };
    case ProtoScalarType.ENUM:
      return { scalar: 'enum', array: 'enum[]' };
    case ProtoScalarType.INT64:
      return { scalar: 'int64', array: 'int64[]' };
    case ProtoScalarType.SINT32:
      return { scalar: 'sint32', array: 'sint32[]' };
    case ProtoScalarType.SINT64:
      return { scalar: 'sint64', array: 'sint64[]' };
    case ProtoScalarType.FIXED32:
      return { scalar: 'fixed32', array: 'fixed32[]' };
    case ProtoScalarType.SFIXED32:
      return { scalar: 'sfixed32', array: 'sfixed32[]' };
    case ProtoScalarType.FIXED64:
      return { scalar: 'fixed64', array: 'fixed64[]' };
    case ProtoScalarType.SFIXED64:
      return { scalar: 'sfixed64', array: 'sfixed64[]' };
    case ProtoScalarType.FLOAT:
      return { scalar: 'float32', array: 'float32[]' };
    case ProtoScalarType.DOUBLE:
      return { scalar: 'float64', array: 'float64[]' };
    case ProtoScalarType.BOOL:
      return { scalar: 'bool', array: 'bool[]' };
    case ProtoScalarType.STRING:
      return { scalar: 'string', array: 'string[]' };
    case ProtoScalarType.BYTES:
      return { scalar: 'bytes', array: 'bytes[]' };
    default:
      throw new Error(`omnibuf: unsupported scalar type ${protoType}`);
  }
}

const compiledProtobufDescCache = new WeakMap<ProtobufDescMessage, MessageSchema<any>>();

/**
 * Compile a `@bufbuild/protobuf` `DescMessage` (v1 or v2) into an OmniBuf `MessageSchema`.
 * Automatically maps `localName` (`camelCase`) and `.proto` `name` (`snake_case`) so both
 * property conventions work on message instances while emitting `.proto` `snake_case` in `Field #0`.
 */
export function schemaFromProtobufDesc<T extends object = Record<string, any>>(
  desc: ProtobufDescMessage,
  options?: {
    useBigInt?: boolean;
    optionalSubMessages?: boolean;
  },
): MessageSchema<T> {
  if (!options) {
    const cached = compiledProtobufDescCache.get(desc);
    if (cached) return cached;
  }
  const cache = new Map<string, MessageSchema<any>>();
  const building = new Set<string>();
  const optionalSubMessages = options?.optionalSubMessages ?? true;

  function build(d: ProtobufDescMessage): MessageSchema<any> {
    const existing = cache.get(d.typeName);
    if (existing) return existing;

    building.add(d.typeName);
    const specs: Record<string, FieldSpec> = {};

    for (const f of d.fields) {
      // Support both @bufbuild/protobuf v2 (`localName` + `name`) and v1 (`name` + `protoName`)
      const propKey =
        f.localName ?? (f.protoName ? f.name : safeObjectProperty(protoCamelCase(f.name)));
      const protoName = f.protoName ?? f.name;
      const fieldUseBigInt =
        options?.useBigInt !== undefined
          ? options.useBigInt
          : typeof f.longAsString === 'boolean'
            ? !f.longAsString
            : false;
      const oneofProtoName = f.oneof?.name;
      const oneofLocalName = f.oneof
        ? (f.oneof.localName ?? safeObjectProperty(protoCamelCase(f.oneof.name)))
        : undefined;
      const isExplicitPresence =
        !oneofLocalName &&
        (f.presence === 1 ||
          f.presence === 'EXPLICIT' ||
          f.opt === true ||
          f.proto?.proto3Optional === true);

      if (f.fieldKind === 'scalar' || f.fieldKind === 'enum') {
        const scalarNum =
          f.fieldKind === 'enum' ? ProtoScalarType.ENUM : (f.scalar ?? ProtoScalarType.UINT32);
        const { scalar } = scalarTypeFromProto(scalarNum);
        specs[propKey] = {
          fieldNum: f.number,
          name: protoName,
          localName: propKey,
          type: scalar,
          useBigInt: fieldUseBigInt,
          oneof: oneofLocalName,
          oneofProtoName,
          explicitPresence: isExplicitPresence,
        };
      } else if (f.fieldKind === 'message') {
        if (!f.message) throw new Error(`omnibuf: missing message descriptor for field ${f.name}`);
        const msgDesc = f.message;
        if (!cache.has(msgDesc.typeName) && !building.has(msgDesc.typeName)) {
          build(msgDesc);
        }
        specs[propKey] = {
          fieldNum: f.number,
          name: protoName,
          localName: propKey,
          type: 'submsg',
          optional: optionalSubMessages,
          oneof: oneofLocalName,
          oneofProtoName,
          subSchema: () => cache.get(msgDesc.typeName) ?? build(msgDesc),
        };
      } else if (f.fieldKind === 'list') {
        if (f.listKind === 'message') {
          if (!f.message) {
            throw new Error(`omnibuf: missing message descriptor for list field ${f.name}`);
          }
          const msgDesc = f.message;
          if (!cache.has(msgDesc.typeName) && !building.has(msgDesc.typeName)) {
            build(msgDesc);
          }
          specs[propKey] = {
            fieldNum: f.number,
            name: protoName,
            localName: propKey,
            type: 'submsg[]',
            subSchema: () => cache.get(msgDesc.typeName) ?? build(msgDesc),
          };
        } else {
          const scalarNum =
            f.listKind === 'enum' ? ProtoScalarType.ENUM : (f.scalar ?? ProtoScalarType.UINT32);
          const { array } = scalarTypeFromProto(scalarNum);
          specs[propKey] = {
            fieldNum: f.number,
            name: protoName,
            localName: propKey,
            type: array,
            useBigInt: fieldUseBigInt,
          };
        }
      } else if (f.fieldKind === 'map') {
        const keyScalar = f.mapKey ?? ProtoScalarType.STRING;
        const { scalar: mapKey } = scalarTypeFromProto(keyScalar);
        const mapKind = f.mapKind ?? f.mapValue?.kind ?? 'scalar';
        if (mapKind === 'message') {
          const valMsg = f.message ?? f.mapValue?.message;
          if (!valMsg) {
            throw new Error(`omnibuf: missing map value message descriptor for ${f.name}`);
          }
          if (!cache.has(valMsg.typeName) && !building.has(valMsg.typeName)) {
            build(valMsg);
          }
          specs[propKey] = {
            fieldNum: f.number,
            name: protoName,
            localName: propKey,
            type: 'map',
            mapKey,
            mapVal: 'submsg',
            subSchema: () => cache.get(valMsg.typeName) ?? build(valMsg),
          };
        } else {
          const valScalar =
            mapKind === 'enum'
              ? ProtoScalarType.ENUM
              : (f.scalar ?? f.mapValue?.scalar ?? ProtoScalarType.STRING);
          const { scalar: mapVal } = scalarTypeFromProto(valScalar);
          specs[propKey] = {
            fieldNum: f.number,
            name: protoName,
            localName: propKey,
            type: 'map',
            mapKey,
            mapVal,
            useBigInt: fieldUseBigInt,
          };
        }
      }
    }

    const cleanTypeName = d.typeName.replace(/^\./, '');
    const compiledSchema = defineMessage(cleanTypeName, specs);
    building.delete(d.typeName);
    cache.set(d.typeName, compiledSchema);
    if (!options) {
      compiledProtobufDescCache.set(d, compiledSchema);
    }
    return compiledSchema;
  }

  return build(desc);
}

/**
 * Marshal a `@bufbuild/protobuf` message (or plain object matching `DescMessage`) into OmniBuf wire format.
 */
export function marshalProto<T extends object>(
  desc: ProtobufDescMessage,
  msg: T,
  options?: BinaryWriteOptions & { useBigInt?: boolean; optionalSubMessages?: boolean },
): Uint8Array {
  const schema = schemaFromProtobufDesc<T>(
    desc,
    options?.useBigInt !== undefined || options?.optionalSubMessages !== undefined
      ? { useBigInt: options.useBigInt, optionalSubMessages: options.optionalSubMessages }
      : undefined,
  );
  return schema.encode(msg, options);
}

/**
 * Unmarshal an OmniBuf packet using a `@bufbuild/protobuf` `DescMessage`.
 */
export function unmarshalProto<T extends object>(
  desc: ProtobufDescMessage,
  buf: Uint8Array,
  options?: BinaryReadOptions & { useBigInt?: boolean; optionalSubMessages?: boolean },
): T {
  const schema = schemaFromProtobufDesc<T>(
    desc,
    options?.useBigInt !== undefined || options?.optionalSubMessages !== undefined
      ? { useBigInt: options.useBigInt, optionalSubMessages: options.optionalSubMessages }
      : undefined,
  );
  return schema.decode(buf, undefined, 0, options);
}

/**
 * Registry of compiled `MessageSchema` codecs built from a `google.protobuf.FileDescriptorSet`.
 * Supports Tier 2 dynamic Protobuf encoding/decoding directly from `.fds.json` or `.fds.pb` descriptors,
 * matching Go's `protoreflect` codec (`MarshalProtoReflect` / `UnmarshalProtoReflect`) byte-for-byte.
 */
export class DescriptorRegistry {
  private readonly schemas = new Map<string, MessageSchema<any>>();

  constructor(fds: FileDescriptorSetJSON, options?: { useBigInt?: boolean }) {
    const rawMap = new Map<string, DescriptorProtoJSON>();
    const useBigInt = options?.useBigInt ?? false;

    const registerRecursive = (prefix: string, desc: DescriptorProtoJSON) => {
      const fullName = prefix ? `${prefix}.${desc.name ?? ''}` : (desc.name ?? '');
      rawMap.set(fullName, desc);
      for (const nested of desc.nestedType ?? []) {
        registerRecursive(fullName, nested);
      }
    };

    for (const file of fds.file ?? []) {
      const pkg = file.package ?? '';
      for (const msg of file.messageType ?? []) {
        registerRecursive(pkg, msg);
      }
    }

    const building = new Set<string>();
    const compile = (fullName: string, desc: DescriptorProtoJSON): MessageSchema<any> => {
      const existing = this.schemas.get(fullName);
      if (existing) return existing;

      building.add(fullName);
      const specs: Record<string, FieldSpec> = {};

      for (const f of desc.field ?? []) {
        const num = f.number ?? 0;
        const protoName = f.name ?? `field_${num}`;
        const typeNum = parseFieldDescriptorType(f.type);
        const repeated = isRepeatedLabel(f.label);
        const cleanTypeName = (f.typeName ?? '').replace(/^\./, '');
        const hasRealOneof =
          f.oneofIndex !== undefined && !f.proto3Optional && desc.oneofDecl?.[f.oneofIndex]?.name;
        const oneofProtoName = hasRealOneof ? desc.oneofDecl![f.oneofIndex!]!.name : undefined;
        const oneofLocalName = oneofProtoName
          ? safeObjectProperty(protoCamelCase(oneofProtoName))
          : undefined;
        const explicitPresence = !oneofLocalName && Boolean(f.proto3Optional);

        if (typeNum === ProtoScalarType.MESSAGE) {
          const target = rawMap.get(cleanTypeName);
          if (target?.options?.mapEntry) {
            const kf = (target.field ?? []).find((x) => x.number === 1);
            const vf = (target.field ?? []).find((x) => x.number === 2);
            const kTypeNum = parseFieldDescriptorType(kf?.type);
            const vTypeNum = parseFieldDescriptorType(vf?.type);
            const { scalar: mapKey } = scalarTypeFromProto(kTypeNum);
            if (vTypeNum === ProtoScalarType.MESSAGE) {
              const valTargetName = (vf?.typeName ?? '').replace(/^\./, '');
              const valTarget = rawMap.get(valTargetName);
              if (!valTarget) {
                throw new Error(`omnibuf: missing map value message ${valTargetName}`);
              }
              if (!this.schemas.has(valTargetName) && !building.has(valTargetName)) {
                compile(valTargetName, valTarget);
              }
              specs[protoName] = {
                fieldNum: num,
                name: protoName,
                type: 'map',
                mapKey,
                mapVal: 'submsg',
                subSchema: () =>
                  this.schemas.get(valTargetName) ?? compile(valTargetName, valTarget),
              };
            } else {
              const { scalar: mapVal } = scalarTypeFromProto(vTypeNum);
              specs[protoName] = {
                fieldNum: num,
                name: protoName,
                type: 'map',
                mapKey,
                mapVal,
                useBigInt,
              };
            }
          } else if (target) {
            const isRecursiveRef = cleanTypeName === fullName || building.has(cleanTypeName);
            if (!this.schemas.has(cleanTypeName) && !building.has(cleanTypeName)) {
              compile(cleanTypeName, target);
            }
            specs[protoName] = {
              fieldNum: num,
              name: protoName,
              type: repeated ? 'submsg[]' : 'submsg',
              optional: isRecursiveRef || Boolean(oneofLocalName) || Boolean(f.proto3Optional),
              oneof: oneofLocalName,
              oneofProtoName,
              subSchema: () => this.schemas.get(cleanTypeName) ?? compile(cleanTypeName, target),
            };
          }
        } else {
          const { scalar, array } = scalarTypeFromProto(typeNum);
          specs[protoName] = {
            fieldNum: num,
            name: protoName,
            type: repeated ? array : scalar,
            useBigInt,
            oneof: oneofLocalName,
            oneofProtoName,
            explicitPresence,
          };
        }
      }

      const shortName = desc.name ?? shortMessageName(fullName);
      const compiledSchema = defineMessage(fullName, specs);
      building.delete(fullName);
      this.schemas.set(fullName, compiledSchema);
      if (!rawMap.has(shortName) && !this.schemas.has(shortName)) {
        this.schemas.set(shortName, compiledSchema);
      }
      return compiledSchema;
    };

    for (const [fullName, desc] of rawMap.entries()) {
      if (desc.options?.mapEntry) continue;
      compile(fullName, desc);
    }
  }

  getSchema(typeName: string): MessageSchema<any> | undefined {
    const clean = typeName.replace(/^\./, '');
    return this.schemas.get(clean);
  }

  getSchemaOrThrow(typeName: string): MessageSchema<any> {
    const s = this.getSchema(typeName);
    if (!s) {
      throw new Error(`omnibuf: message descriptor not found for "${typeName}"`);
    }
    return s;
  }

  encode(typeName: string, value: Record<string, any>, options?: MarshalOptions): Uint8Array {
    const schema = this.getSchemaOrThrow(typeName);
    return schema.encode(value, options);
  }

  decode(typeName: string, buf: Uint8Array): Record<string, any> {
    const schema = this.getSchemaOrThrow(typeName);
    return schema.decode(buf);
  }
}

/**
 * Decode a binary `google.protobuf.FileDescriptorSet` (standard Protobuf wire format)
 * into `FileDescriptorSetJSON` without requiring any external protobuf runtime.
 */
export function parseBinaryFileDescriptorSet(buf: Uint8Array): FileDescriptorSetJSON {
  function readPbVarint(b: Uint8Array, pos: number): [bigint, number] {
    let result = 0n;
    let shift = 0n;
    while (pos < b.length) {
      if (shift >= 64n) {
        throw new Error('omnibuf: protobuf varint overflow');
      }
      const byte = b[pos++]!;
      if (shift === 63n && byte > 1) {
        throw new Error('omnibuf: protobuf varint overflow');
      }
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return [result, pos];
      shift += 7n;
    }
    throw new Error('omnibuf: unexpected EOF in protobuf varint');
  }

  function readPbBytes(b: Uint8Array, pos: number): [Uint8Array, number] {
    const [len, p2] = readPbVarint(b, pos);
    if (len > BigInt(b.length - p2)) {
      throw new Error('omnibuf: truncated protobuf length-delimited field');
    }
    const n = Number(len);
    return [b.subarray(p2, p2 + n), p2 + n];
  }

  function skipPbField(b: Uint8Array, pos: number, wireType: number): number {
    switch (wireType) {
      case 0: {
        const [, nextPos] = readPbVarint(b, pos);
        return nextPos;
      }
      case 1: {
        if (b.length - pos < 8) {
          throw new Error('omnibuf: truncated protobuf 64-bit field');
        }
        return pos + 8;
      }
      case 2: {
        const [, nextPos] = readPbBytes(b, pos);
        return nextPos;
      }
      case 5: {
        if (b.length - pos < 4) {
          throw new Error('omnibuf: truncated protobuf 32-bit field');
        }
        return pos + 4;
      }
      default:
        throw new Error(`omnibuf: unsupported protobuf wire type ${wireType}`);
    }
  }

  function decodeFieldDescriptor(b: Uint8Array): FieldDescriptorProtoJSON {
    const out: FieldDescriptorProtoJSON = {};
    let pos = 0;
    while (pos < b.length) {
      const [tag, p1] = readPbVarint(b, pos);
      pos = p1;
      const fieldNum = Number(tag >> 3n);
      const wt = Number(tag & 7n);
      if (wt === 2 && (fieldNum === 1 || fieldNum === 6 || fieldNum === 10)) {
        const [sub, nextPos] = readPbBytes(b, pos);
        const str = decodeUTF8(sub);
        pos = nextPos;
        if (fieldNum === 1) out.name = str;
        else if (fieldNum === 6) out.typeName = str;
        else if (fieldNum === 10) out.jsonName = str;
      } else if (
        wt === 0 &&
        (fieldNum === 3 || fieldNum === 4 || fieldNum === 5 || fieldNum === 9 || fieldNum === 17)
      ) {
        const [val, p2] = readPbVarint(b, pos);
        pos = p2;
        if (fieldNum === 3) out.number = Number(val);
        else if (fieldNum === 4) out.label = Number(val);
        else if (fieldNum === 5) out.type = Number(val);
        else if (fieldNum === 9) out.oneofIndex = Number(val);
        else if (fieldNum === 17) out.proto3Optional = val !== 0n;
      } else {
        pos = skipPbField(b, pos, wt);
      }
    }
    return out;
  }

  function decodeOneofDescriptor(b: Uint8Array): OneofDescriptorProtoJSON {
    const out: OneofDescriptorProtoJSON = {};
    let pos = 0;
    while (pos < b.length) {
      const [tag, p1] = readPbVarint(b, pos);
      pos = p1;
      const fieldNum = Number(tag >> 3n);
      const wt = Number(tag & 7n);
      if (wt === 2 && fieldNum === 1) {
        const [sub, nextPos] = readPbBytes(b, pos);
        out.name = decodeUTF8(sub);
        pos = nextPos;
      } else {
        pos = skipPbField(b, pos, wt);
      }
    }
    return out;
  }

  function decodeEnumValueDescriptor(b: Uint8Array): { name?: string; number?: number } {
    const out: { name?: string; number?: number } = {};
    let pos = 0;
    while (pos < b.length) {
      const [tag, p1] = readPbVarint(b, pos);
      pos = p1;
      const fieldNum = Number(tag >> 3n);
      const wt = Number(tag & 7n);
      if (wt === 2 && fieldNum === 1) {
        const [sub, nextPos] = readPbBytes(b, pos);
        out.name = decodeUTF8(sub);
        pos = nextPos;
      } else if (wt === 0 && fieldNum === 2) {
        const [val, p2] = readPbVarint(b, pos);
        out.number = Number(BigInt.asIntN(32, val));
        pos = p2;
      } else {
        pos = skipPbField(b, pos, wt);
      }
    }
    return out;
  }

  function decodeEnumDescriptor(b: Uint8Array): EnumDescriptorProtoJSON {
    const out: EnumDescriptorProtoJSON = { value: [] };
    let pos = 0;
    while (pos < b.length) {
      const [tag, p1] = readPbVarint(b, pos);
      pos = p1;
      const fieldNum = Number(tag >> 3n);
      const wt = Number(tag & 7n);
      if (wt === 2 && (fieldNum === 1 || fieldNum === 2)) {
        const [sub, nextPos] = readPbBytes(b, pos);
        pos = nextPos;
        if (fieldNum === 1) out.name = decodeUTF8(sub);
        else if (fieldNum === 2) out.value!.push(decodeEnumValueDescriptor(sub));
      } else {
        pos = skipPbField(b, pos, wt);
      }
    }
    return out;
  }

  function decodeMessageOptions(b: Uint8Array): { mapEntry?: boolean } {
    const out: { mapEntry?: boolean } = {};
    let pos = 0;
    while (pos < b.length) {
      const [tag, p1] = readPbVarint(b, pos);
      pos = p1;
      const fieldNum = Number(tag >> 3n);
      const wt = Number(tag & 7n);
      if (wt === 0 && fieldNum === 7) {
        const [val, p2] = readPbVarint(b, pos);
        pos = p2;
        out.mapEntry = val !== 0n;
      } else {
        pos = skipPbField(b, pos, wt);
      }
    }
    return out;
  }

  function decodeDescriptorProto(b: Uint8Array, depth = 0): DescriptorProtoJSON {
    if (depth > MaxNestingDepth) {
      throw new Error(
        `omnibuf: descriptor nesting depth ${depth} exceeds MaxNestingDepth (${MaxNestingDepth})`,
      );
    }
    const out: DescriptorProtoJSON = { field: [], nestedType: [], enumType: [], oneofDecl: [] };
    let pos = 0;
    while (pos < b.length) {
      const [tag, p1] = readPbVarint(b, pos);
      pos = p1;
      const fieldNum = Number(tag >> 3n);
      const wt = Number(tag & 7n);
      if (
        wt === 2 &&
        (fieldNum === 1 ||
          fieldNum === 2 ||
          fieldNum === 3 ||
          fieldNum === 4 ||
          fieldNum === 7 ||
          fieldNum === 8)
      ) {
        const [sub, nextPos] = readPbBytes(b, pos);
        pos = nextPos;
        if (fieldNum === 1) out.name = decodeUTF8(sub);
        else if (fieldNum === 2) out.field!.push(decodeFieldDescriptor(sub));
        else if (fieldNum === 3) out.nestedType!.push(decodeDescriptorProto(sub, depth + 1));
        else if (fieldNum === 4) out.enumType!.push(decodeEnumDescriptor(sub));
        else if (fieldNum === 7) out.options = decodeMessageOptions(sub);
        else if (fieldNum === 8) out.oneofDecl!.push(decodeOneofDescriptor(sub));
      } else {
        pos = skipPbField(b, pos, wt);
      }
    }
    return out;
  }

  function decodeFileDescriptor(b: Uint8Array): FileDescriptorProtoJSON {
    const out: FileDescriptorProtoJSON = { dependency: [], messageType: [], enumType: [] };
    let pos = 0;
    while (pos < b.length) {
      const [tag, p1] = readPbVarint(b, pos);
      pos = p1;
      const fieldNum = Number(tag >> 3n);
      const wt = Number(tag & 7n);
      if (
        wt === 2 &&
        (fieldNum === 1 ||
          fieldNum === 2 ||
          fieldNum === 3 ||
          fieldNum === 4 ||
          fieldNum === 5 ||
          fieldNum === 12)
      ) {
        const [sub, nextPos] = readPbBytes(b, pos);
        pos = nextPos;
        if (fieldNum === 1) out.name = decodeUTF8(sub);
        else if (fieldNum === 2) out.package = decodeUTF8(sub);
        else if (fieldNum === 3) out.dependency!.push(decodeUTF8(sub));
        else if (fieldNum === 4) out.messageType!.push(decodeDescriptorProto(sub, 0));
        else if (fieldNum === 5) out.enumType!.push(decodeEnumDescriptor(sub));
        else if (fieldNum === 12) out.syntax = decodeUTF8(sub);
      } else {
        pos = skipPbField(b, pos, wt);
      }
    }
    return out;
  }

  const fds: FileDescriptorSetJSON = { file: [] };
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = readPbVarint(buf, pos);
    pos = p1;
    const fieldNum = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (wt === 2 && fieldNum === 1) {
      const [sub, nextPos] = readPbBytes(buf, pos);
      pos = nextPos;
      fds.file!.push(decodeFileDescriptor(sub));
    } else {
      pos = skipPbField(buf, pos, wt);
    }
  }
  return fds;
}

export {
  base64ToUint8Array as base64Decode,
  uint8ArrayToBase64 as base64Encode,
  readField0SchemaMeta,
};
