import { validateValue, validateMapTypes } from './validation.js';
// ============================================================================
// Tier 3: Annotated Classes & Declarative Type Mapping for Plain Objects/Classes
// ============================================================================

import {
  type SchemaMeta,
  base64ToUint8Array,
  decodeSchemaMeta,
  encodeField0SchemaMeta,
  mergeSchemaMeta,
  writeField0SchemaMeta,
} from './blind.js';
import { Encoder, mapHeaderByte } from './encoder.js';
import {
  appendBoolArrBody,
  appendBytesArrBody,
  appendFloat32ArrBody,
  appendFloat64ArrBody,
  appendSintArrAutoBody,
  appendStringArrBody,
  appendUint32ArrBody,
  appendUintArrAutoBody,
  countSubMsgArrElems,
} from './readers.js';
import {
  MaxNestingDepth,
  WireBoolFalse,
  WireBoolTrue,
  WireBytes,
  WireFixed32,
  WireFixed64,
  WireFixedArr,
  WireMap,
  WireSint,
  WireSintArr,
  WireString,
  WireStringArr,
  WireSubMsg,
  WireSubMsgArr,
  WireUint,
  WireUintArr,
  decodeUTF8,
  decodeVarint,
  decodeVarintAuto,
  decodeVarintBigInt,
  decodeZigZag,
  decodeZigZagAuto,
  decodeZigZagBigInt,
  encodeZigZag,
  encodeZigZagNumber,
  float32FromBits,
  float64FromBits,
  readFloat64At,
  readLenSlice,
  roundFloat32Shortest,
} from './wire.js';

/**
 * Unrecognized wire field retained on `message.$unknown` when `readUnknownFields` is enabled
 * (matching `@bufbuild/protobuf` v2 `UnknownField`).
 */
export interface UnknownField {
  readonly no: number;
  readonly wireType: number;
  readonly data: Uint8Array;
}

/**
 * Base message shape modeled after `protobuf-es` (`@bufbuild/protobuf` v2 `Message<TypeName>`).
 */
export type Message<TypeName extends string = string> = {
  readonly $typeName: TypeName;
  $unknown?: UnknownField[] | undefined;
};

/**
 * Extracts the runtime message type `T` from a `MessageSchema<T>` or `DescMessage`.
 */
export type MessageShape<S> =
  S extends MessageSchema<infer T, any>
    ? T
    : S extends { readonly typeName: infer N extends string }
      ? Message<N> & Record<string, any>
      : Record<string, any>;

/**
 * Extracts the initializer shape accepted by `create(schema, init?)`.
 */
export type MessageInitShape<S> =
  S extends MessageSchema<infer T, any> ? Partial<T> & Record<string, any> : Record<string, any>;

/**
 * Options for reading binary OmniBuf payloads (modeled after `@bufbuild/protobuf` `BinaryReadOptions`).
 */
export interface BinaryReadOptions {
  /**
   * Retain unknown fields during decoding on `message.$unknown`.
   * Defaults to `true` (matching `@bufbuild/protobuf`).
   */
  readUnknownFields?: boolean;
  /**
   * Maximum recursion depth for nested sub-messages (defaults to `MaxNestingDepth` = 32).
   */
  recursionLimit?: number;
  /**
   * Merge decoded fields into an existing target message (appending arrays and merging maps).
   */
  merge?: boolean;
}

/**
 * Options for writing binary OmniBuf payloads (extends `MarshalOptions` with `@bufbuild/protobuf` `BinaryWriteOptions`).
 */
export interface BinaryWriteOptions extends MarshalOptions {
  /**
   * Write unknown fields stored on `message.$unknown` to the wire.
   * Defaults to `true` in `toBinary()` (matching `@bufbuild/protobuf`).
   */
  writeUnknownFields?: boolean;
}

/**
 * Converts `snake_case` field names to `protoCamelCase` (matching `protoc` and `@bufbuild/protobuf` v2).
 */
export function protoCamelCase(snakeCase: string): string {
  let capNext = false;
  const b: string[] = [];
  for (let i = 0; i < snakeCase.length; i++) {
    let c = snakeCase.charAt(i);
    switch (c) {
      case '_':
        capNext = true;
        break;
      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
        b.push(c);
        capNext = false;
        break;
      default:
        if (capNext) {
          capNext = false;
          c = c.toUpperCase();
        }
        b.push(c);
        break;
    }
  }
  return b.join('');
}

/**
 * Converts `protoCamelCase` to `snake_case` (matching `@bufbuild/protobuf` v2).
 */
export function protoSnakeCase(lowerCamelCase: string): string {
  return lowerCamelCase.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
}

const RESERVED_OBJECT_PROPERTIES = new Set(['constructor', 'toString', 'toJSON', 'valueOf']);

/**
 * Escapes field names that collide with built-in JavaScript `Object.prototype` properties.
 */
export function safeObjectProperty(name: string): string {
  return RESERVED_OBJECT_PROPERTIES.has(name) ? `${name}$` : name;
}

function shortMessageName(typeName: string): string {
  const clean = typeName.replace(/^\./, '');
  const parts = clean.split('.');
  return parts[parts.length - 1] || clean;
}

export type ScalarFieldType =
  | 'uint32'
  | 'uint64'
  | 'sint32'
  | 'sint64'
  | 'int32'
  | 'int64'
  | 'enum'
  | 'bool'
  | 'string'
  | 'bytes'
  | 'float32'
  | 'float64'
  | 'fixed32'
  | 'fixed64'
  | 'sfixed32'
  | 'sfixed64';

export type ArrayFieldType =
  | 'uint32[]'
  | 'uint64[]'
  | 'sint32[]'
  | 'sint64[]'
  | 'int32[]'
  | 'int64[]'
  | 'enum[]'
  | 'bool[]'
  | 'string[]'
  | 'bytes[]'
  | 'float32[]'
  | 'float64[]'
  | 'fixed32[]'
  | 'fixed64[]'
  | 'sfixed32[]'
  | 'sfixed64[]'
  | 'submsg[]';

export type FieldType = ScalarFieldType | ArrayFieldType | 'submsg' | 'map';

export type WireOverride =
  'uint' | 'sint' | 'fixed32' | 'fixed64' | 'string' | 'bytes' | 'bool' | 'submsg' | 'map';

export interface FieldSpec {
  /** Field number (1..4294967295). */
  fieldNum: number;
  /** Field type. */
  type: FieldType;
  /** Optional wire name emitted in Field #0 SchemaMeta (defaults to property key). */
  name?: string;
  /** Optional JS/TS localName (camelCase, matching `@bufbuild/protobuf` `DescField.localName`). */
  localName?: string;
  /** Optional explicit wire encoding override (matching Go struct tag `wire=...`). */
  wire?: WireOverride;
  /** When true, skips encoding when the field holds its zero value or empty array/map. */
  omitEmpty?: boolean;
  /**
   * For `submsg` fields: when true (default for optional/pointer sub-messages),
   * `null` or `undefined` is omitted on the wire; when false (value struct like Go's `Location`),
   * always writes a `WireSubMsg` container even when default.
   * For scalar/enum fields: when true (or `explicitPresence: true`), models Protobuf explicit presence
   * (`proto3_optional` / `proto2` optional), defaulting to `undefined` when unset and omitting `undefined` on the wire.
   */
  optional?: boolean;
  /** Explicit field presence for scalar/enum fields (`proto3_optional` / `proto2` optional). */
  explicitPresence?: boolean;
  /** Optional `oneof` group name (`localName`, e.g. `"result"`). */
  oneof?: string;
  /** Optional `.proto` `oneof` group name (`snake_case`, e.g. `"my_result"`). */
  oneofProtoName?: string;
  /** Nested message schema for `submsg`, `submsg[]`, or `map` with submsg values. Supports lazy thunk for recursive types. */
  subSchema?: MessageSchema<any> | (() => MessageSchema<any>);
  /** Map key type when `type === "map"`. */
  mapKey?: ScalarFieldType;
  /** Map value type when `type === "map"`. */
  mapVal?: ScalarFieldType | 'submsg';
  /** Use `bigint` when decoding 64-bit integer fields (`uint64`, `sint64`, `int64`, `fixed64`, `sfixed64`). */
  useBigInt?: boolean;
}

export interface MarshalOptions {
  /**
   * Sorts `WireMap` keys in ascending order so identical messages always produce
   * byte-for-byte identical wire output.
   */
  deterministic?: boolean;
  /**
   * Emits Field #0 (`Tag = 0x0B`, `WireSubMsg = 5`, `omnibuf.v1.SchemaMeta`)
   * at byte 0 of the root message with field names and nested children schemas.
   */
  selfDescribing?: boolean;
  /**
   * Write unknown fields stored on `message.$unknown` to the wire.
   */
  writeUnknownFields?: boolean;
}

export interface CompiledOneof {
  readonly localName: string;
  readonly protoName: string;
  readonly fields: CompiledField[];
}

export interface CompiledField {
  readonly propKey: string;
  readonly fieldNum: number;
  readonly name: string;
  readonly localName: string;
  readonly altKey?: string;
  readonly type: FieldType;
  readonly effectiveType: FieldType;
  readonly wireType: number;
  readonly omitEmpty: boolean;
  readonly optional: boolean;
  readonly explicitPresence: boolean;
  readonly oneof?: string;
  readonly oneofProtoName?: string;
  readonly useBigInt: boolean;
  mapKeyType?: ScalarFieldType;
  mapValType?: ScalarFieldType | 'submsg';
  mapKeyWT?: number;
  mapValWT?: number;
  readonly resolveSubSchema?: () => MessageSchema<any>;
}

function resolveEffectiveType(type: FieldType, wire?: WireOverride): FieldType {
  if (!wire) return type;
  const isArray = type.endsWith('[]');
  if (isArray) {
    switch (wire) {
      case 'uint':
        return type === 'uint64[]' || type === 'int64[]' || type === 'sint64[]'
          ? 'uint64[]'
          : 'uint32[]';
      case 'sint':
        return type === 'uint64[]' || type === 'int64[]' || type === 'sint64[]'
          ? 'sint64[]'
          : 'sint32[]';
      case 'fixed32':
        return type === 'float32[]' ? 'float32[]' : 'fixed32[]';
      case 'fixed64':
        return type === 'float64[]' ? 'float64[]' : 'fixed64[]';
      case 'string':
        return 'string[]';
      case 'bytes':
        return 'bytes[]';
      default:
        return type;
    }
  }
  switch (wire) {
    case 'uint':
      return type === 'uint64' || type === 'int64' || type === 'sint64' ? 'uint64' : 'uint32';
    case 'sint':
      return type === 'uint64' || type === 'int64' || type === 'sint64' ? 'sint64' : 'sint32';
    case 'fixed32':
      return type === 'float32' ? 'float32' : 'fixed32';
    case 'fixed64':
      return type === 'float64' ? 'float64' : 'fixed64';
    case 'string':
      return 'string';
    case 'bytes':
      return 'bytes';
    default:
      return type;
  }
}

function wireTypeForEffectiveType(t: FieldType): number {
  switch (t) {
    case 'uint32':
    case 'uint64':
    case 'enum':
      return WireUint;
    case 'sint32':
    case 'sint64':
    case 'int32':
    case 'int64':
      return WireSint;
    case 'bool':
      return WireBoolTrue;
    case 'string':
      return WireString;
    case 'bytes':
      return WireBytes;
    case 'submsg':
      return WireSubMsg;
    case 'float32':
    case 'fixed32':
    case 'sfixed32':
      return WireFixed32;
    case 'float64':
    case 'fixed64':
    case 'sfixed64':
      return WireFixed64;
    case 'string[]':
    case 'bytes[]':
      return WireStringArr;
    case 'uint32[]':
    case 'uint64[]':
    case 'enum[]':
    case 'bool[]':
      return WireUintArr;
    case 'sint32[]':
    case 'sint64[]':
    case 'int32[]':
    case 'int64[]':
      return WireSintArr;
    case 'float32[]':
    case 'float64[]':
    case 'fixed32[]':
    case 'fixed64[]':
    case 'sfixed32[]':
    case 'sfixed64[]':
      return WireFixedArr;
    case 'submsg[]':
      return WireSubMsgArr;
    case 'map':
      return WireMap;
  }
}

function scalarWireType(t: ScalarFieldType | 'submsg'): number {
  if (t === 'submsg') return WireSubMsg;
  return wireTypeForEffectiveType(t);
}

/**
 * Optional generated fast-path hooks attached to a `MessageSchema<T>` by `protoc-gen-omnibuf-es`.
 */
export interface GeneratedCodecHooks<T extends object = Record<string, any>> {
  create?: () => T;
  encode?: (enc: Encoder, msg: Partial<T>, options?: MarshalOptions) => void;
  decode?: (data: Uint8Array, target?: T, depth?: number, options?: BinaryReadOptions) => T;
}

const sharedEncoder = new Encoder(8192);
let sharedEncoderInUse = false;

/**
 * Compiled schema codec for a TypeScript interface, plain object, or decorated class.
 * Modeled after `@bufbuild/protobuf` v2 `GenMessage<T>` / `DescMessage`.
 */
export class MessageSchema<
  T extends object = Record<string, any>,
  TypeName extends string = string,
> {
  readonly typeName: TypeName;
  readonly shortName: string;
  readonly fields: readonly CompiledField[];
  readonly oneofs: readonly CompiledOneof[];
  private readonly byNum = new Map<number, CompiledField>();
  private readonly byKey = new Map<string, CompiledField>();
  private readonly oneofByName = new Map<string, CompiledOneof>();
  private readonly factory?: () => T;
  private generatedHooks?: GeneratedCodecHooks<T>;
  private readonly typeNameDesc: PropertyDescriptor;
  private cachedMeta: SchemaMeta | null = null;
  private cachedShallowMeta: SchemaMeta | null = null;
  private cachedField0Det: Uint8Array | null = null;
  private cachedCyclicOrDeep: boolean | null = null;

  constructor(
    typeName: TypeName,
    specs: Record<string, FieldSpec>,
    factory?: () => T,
    generatedHooks?: GeneratedCodecHooks<T>,
  ) {
    this.typeName = typeName;
    this.shortName = shortMessageName(typeName);
    this.factory = factory;
    this.generatedHooks = generatedHooks;
    this.typeNameDesc = {
      value: typeName,
      enumerable: false,
      writable: true,
      configurable: true,
    };
    const compiled: CompiledField[] = [];
    const oneofMap = new Map<string, CompiledOneof>();

    for (const [propKey, spec] of Object.entries(specs)) {
      if (!Number.isInteger(spec.fieldNum) || spec.fieldNum < 1 || spec.fieldNum > 0xffffffff) {
        throw new Error(
          `omnibuf: field number ${spec.fieldNum} on ${typeName}.${propKey} out of range (1..4294967295)`,
        );
      }
      if (this.byNum.has(spec.fieldNum)) {
        throw new Error(`omnibuf: duplicate field number ${spec.fieldNum} on ${typeName}`);
      }
      const effectiveType = resolveEffectiveType(spec.type, spec.wire);
      const wireType = wireTypeForEffectiveType(effectiveType);
      const subOpt = spec.subSchema;
      const resolveSubSchema = subOpt
        ? typeof subOpt === 'function'
          ? (subOpt as () => MessageSchema<any>)
          : () => subOpt
        : undefined;

      const wireName = spec.name ?? propKey;
      const localName = spec.localName ?? safeObjectProperty(protoCamelCase(wireName));
      const altKey =
        propKey !== wireName ? wireName : propKey !== localName ? localName : undefined;

      const oneofLocal = spec.oneof ? safeObjectProperty(protoCamelCase(spec.oneof)) : undefined;
      const oneofProto = spec.oneofProtoName ?? spec.oneof;
      const explicitPresence =
        spec.explicitPresence ?? (effectiveType !== 'submsg' && spec.optional === true);

      const cf: CompiledField = {
        propKey,
        fieldNum: spec.fieldNum,
        name: wireName,
        localName,
        altKey,
        type: spec.type,
        effectiveType,
        wireType,
        omitEmpty: spec.omitEmpty ?? false,
        optional: spec.optional ?? effectiveType === 'submsg',
        explicitPresence,
        oneof: oneofLocal,
        oneofProtoName: oneofProto,
        useBigInt: spec.useBigInt ?? false,
        resolveSubSchema,
      };

      if (effectiveType === 'map') {
        const mk = spec.mapKey ?? 'string';
        const mv = spec.mapVal ?? 'uint64';
        cf.mapKeyType = mk;
        cf.mapValType = mv;
        cf.mapKeyWT = mk === 'bool' ? WireUint : scalarWireType(mk);
        cf.mapValWT = mv === 'bool' ? WireUint : scalarWireType(mv);
        validateMapTypes(cf.mapKeyWT, cf.mapValWT);
      }

      if (oneofLocal) {
        let group = oneofMap.get(oneofLocal);
        if (!group) {
          group = {
            localName: oneofLocal,
            protoName: oneofProto ?? oneofLocal,
            fields: [],
          };
          oneofMap.set(oneofLocal, group);
          this.oneofByName.set(group.localName, group);
          this.oneofByName.set(group.protoName, group);
        }
        group.fields.push(cf);
      }

      compiled.push(cf);
      this.byNum.set(cf.fieldNum, cf);
      this.byKey.set(cf.propKey, cf);
      this.byKey.set(cf.name, cf);
      this.byKey.set(cf.localName, cf);
    }

    // Sort fields by ascending fieldNum for deterministic output
    compiled.sort((a, b) => a.fieldNum - b.fieldNum);
    this.fields = compiled;
    this.oneofs = Array.from(oneofMap.values());
  }

  /**
   * Look up a compiled field by number, `localName` (`camelCase`), `.proto` `name` (`snake_case`),
   * or a `@bufbuild/protobuf` `DescField`-compatible object.
   */
  getField(
    fieldNameOrNum: string | number | { readonly number: number },
  ): CompiledField | undefined {
    if (typeof fieldNameOrNum === 'number') {
      return this.byNum.get(fieldNameOrNum);
    }
    if (
      typeof fieldNameOrNum === 'object' &&
      fieldNameOrNum !== null &&
      'number' in fieldNameOrNum
    ) {
      return this.byNum.get(fieldNameOrNum.number);
    }
    return this.byKey.get(fieldNameOrNum);
  }

  private ensureAccessors(obj: Record<string, any>): void {
    if (!('$typeName' in obj)) {
      Object.defineProperty(obj, '$typeName', {
        value: this.typeName,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    for (const oneof of this.oneofs) {
      if (!(oneof.localName in obj) || obj[oneof.localName] === undefined) {
        obj[oneof.localName] = { case: undefined };
      }
      if (oneof.protoName !== oneof.localName && !(oneof.protoName in obj)) {
        const ln = oneof.localName;
        Object.defineProperty(obj, oneof.protoName, {
          get() {
            return this[ln];
          },
          set(v: any) {
            this[ln] = v;
          },
          enumerable: false,
          configurable: true,
        });
      }
    }
    for (const f of this.fields) {
      if (f.oneof) {
        const oneofKey = f.oneof;
        const caseName = f.localName;
        const altCaseName = f.name;
        const propDesc = Object.getOwnPropertyDescriptor(obj, f.propKey);
        if (!propDesc || 'value' in propDesc) {
          const initialPlainVal = propDesc?.value;
          Object.defineProperty(obj, f.propKey, {
            get() {
              const g = this[oneofKey];
              if (
                g &&
                typeof g === 'object' &&
                (g.case === caseName || g.case === altCaseName || g.case === f.propKey)
              ) {
                return g.value;
              }
              return undefined;
            },
            set(v: any) {
              if (v === undefined || v === null) {
                const g = this[oneofKey];
                if (
                  g &&
                  typeof g === 'object' &&
                  (g.case === caseName || g.case === altCaseName || g.case === f.propKey)
                ) {
                  this[oneofKey] = { case: undefined };
                }
              } else {
                this[oneofKey] = { case: caseName, value: v };
              }
            },
            enumerable: false,
            configurable: true,
          });
          if (initialPlainVal !== undefined && initialPlainVal !== null) {
            obj[oneofKey] = { case: caseName, value: initialPlainVal };
          }
        }
        if (f.altKey && !(f.altKey in obj)) {
          const pk = f.propKey;
          Object.defineProperty(obj, f.altKey, {
            get() {
              return this[pk];
            },
            set(v: any) {
              this[pk] = v;
            },
            enumerable: false,
            configurable: true,
          });
        }
        continue;
      }
      if (f.altKey && !(f.altKey in obj)) {
        const pk = f.propKey;
        Object.defineProperty(obj, f.altKey, {
          get() {
            return this[pk];
          },
          set(v: any) {
            this[pk] = v;
          },
          enumerable: false,
          configurable: true,
        });
      }
    }
  }

  /**
   * Attaches generated fast-path hooks (`create`, `encode`, `decode`) to this schema.
   */
  setGeneratedCodec(hooks: GeneratedCodecHooks<T>): this {
    this.generatedHooks = hooks;
    return this;
  }

  /**
   * Creates a default instance with initialized zero/empty fields and `$typeName`.
   * Follows `@bufbuild/protobuf` v2 `create()` semantics:
   * - If `init` is already a message of this schema (`isMessage(init, this)`), returns `init` directly.
   * - Accepts both `camelCase` (`localName`) and `snake_case` (`.proto` `name`) keys in `init`.
   * - Recursively initializes nested message fields, arrays, maps, and `oneof` case/value objects.
   */
  create(init?: Partial<T> & Record<string, any>, creatingAncestors?: Set<MessageSchema<any>>): T {
    if (init === undefined && this.generatedHooks?.create) {
      return this.generatedHooks.create();
    }
    if (init !== undefined && isMessage(init, this)) {
      return init as T;
    }
    const obj: any = this.generatedHooks?.create
      ? this.generatedHooks.create()
      : this.factory
        ? this.factory()
        : {};
    this.ensureAccessors(obj);

    let nextCreating: Set<MessageSchema<any>> | undefined;
    if (this.isCyclicOrDeep()) {
      nextCreating = new Set(creatingAncestors);
      nextCreating.add(this);
    }

    for (let i = 0; i < this.fields.length; i++) {
      const f = this.fields[i]!;
      if (f.oneof) continue;
      if (f.explicitPresence) {
        if (!(f.propKey in obj)) {
          obj[f.propKey] = undefined;
        }
        continue;
      }
      if (obj[f.propKey] === undefined) {
        obj[f.propKey] = defaultFieldValue(f, nextCreating);
      }
    }

    if (init) {
      for (const oneof of this.oneofs) {
        const initOneof =
          (init as any)[oneof.localName] ??
          (oneof.protoName !== oneof.localName ? (init as any)[oneof.protoName] : undefined);
        if (initOneof && typeof initOneof === 'object' && 'case' in initOneof) {
          if (initOneof.case === undefined) {
            obj[oneof.localName] = { case: undefined };
          } else {
            const matchingField = oneof.fields.find(
              (f) =>
                f.localName === initOneof.case ||
                f.name === initOneof.case ||
                f.propKey === initOneof.case,
            );
            if (matchingField) {
              obj[oneof.localName] = {
                case: matchingField.localName,
                value: initFieldValue(matchingField, initOneof.value),
              };
            }
          }
        }
      }
      for (const f of this.fields) {
        const initVal =
          (init as any)[f.propKey] !== undefined
            ? (init as any)[f.propKey]
            : f.altKey !== undefined
              ? (init as any)[f.altKey]
              : undefined;
        if (initVal !== undefined) {
          if (f.oneof) {
            obj[f.oneof] = {
              case: f.localName,
              value: initFieldValue(f, initVal),
            };
          } else {
            obj[f.propKey] = initFieldValue(f, initVal);
          }
        }
      }
      if (Array.isArray((init as any).$unknown) && (init as any).$unknown.length > 0) {
        Object.defineProperty(obj, '$unknown', {
          value: (init as any).$unknown.map((u: UnknownField) => ({
            no: u.no,
            wireType: u.wireType,
            data: u.data.slice(),
          })),
          enumerable: false,
          writable: true,
          configurable: true,
        });
      }
    }
    return obj as T;
  }

  /**
   * Resets a field or `oneof` group on `msg` back to its default/zero state (matching `@bufbuild/protobuf` `clearField`).
   */
  clearField(
    msg: T,
    fieldNameOrNum: keyof T | string | number | { readonly number: number },
  ): void {
    if (typeof fieldNameOrNum === 'string') {
      const oneofGroup = this.oneofByName.get(fieldNameOrNum);
      if (oneofGroup) {
        (msg as any)[oneofGroup.localName] = { case: undefined };
        return;
      }
    }
    const f = this.getField(fieldNameOrNum as string | number);
    if (!f) {
      throw new Error(`omnibuf: unknown field "${String(fieldNameOrNum)}" on ${this.typeName}`);
    }
    if (f.oneof) {
      const g = (msg as any)[f.oneof];
      if (
        g &&
        typeof g === 'object' &&
        (g.case === f.localName || g.case === f.name || g.case === f.propKey)
      ) {
        (msg as any)[f.oneof] = { case: undefined };
      }
      return;
    }
    if (f.explicitPresence) {
      (msg as any)[f.propKey] = undefined;
      return;
    }
    (msg as any)[f.propKey] = defaultFieldValue(f);
  }

  /**
   * Deep-clones `msg`, including nested messages, arrays, maps, `oneof` groups, `Uint8Array` buffers, and `$unknown` fields.
   */
  clone(msg: T): T {
    const out: any = this.create();
    const src = msg as Record<string, any>;
    for (const f of this.fields) {
      const val = getFieldFromMsg(src, f);
      if (f.oneof) {
        if (val !== undefined) {
          out[f.oneof] = {
            case: f.localName,
            value: cloneFieldValue(f, val),
          };
        }
      } else if (f.explicitPresence) {
        out[f.propKey] = val === undefined ? undefined : cloneFieldValue(f, val);
      } else {
        out[f.propKey] = cloneFieldValue(f, val);
      }
    }
    if (Array.isArray(src.$unknown) && src.$unknown.length > 0) {
      Object.defineProperty(out, '$unknown', {
        value: src.$unknown.map((u: UnknownField) => ({
          no: u.no,
          wireType: u.wireType,
          data: u.data.slice(),
        })),
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    return out as T;
  }

  /**
   * Compares two messages of this schema for deep equality (matching `@bufbuild/protobuf` `equals`).
   */
  equals(
    a: T | null | undefined,
    b: T | null | undefined,
    options?: { unknown?: boolean },
  ): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    const ma = a as Record<string, any>;
    const mb = b as Record<string, any>;
    if (ma.$typeName !== undefined && mb.$typeName !== undefined && ma.$typeName !== mb.$typeName) {
      return false;
    }
    for (const f of this.fields) {
      const va = getFieldFromMsg(ma, f);
      const vb = getFieldFromMsg(mb, f);
      if (f.oneof || f.explicitPresence) {
        const aPresent = va !== undefined && va !== null;
        const bPresent = vb !== undefined && vb !== null;
        if (aPresent !== bPresent) return false;
        if (!aPresent) continue;
      }
      if (!fieldValuesEqual(f, va, vb, options)) {
        return false;
      }
    }
    if (options?.unknown) {
      const ua: UnknownField[] = ma.$unknown ?? [];
      const ub: UnknownField[] = mb.$unknown ?? [];
      if (ua.length !== ub.length) return false;
      for (let i = 0; i < ua.length; i++) {
        const xa = ua[i]!;
        const xb = ub[i]!;
        if (xa.no !== xb.no || xa.wireType !== xb.wireType || !bytesEqual(xa.data, xb.data)) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Returns a shallow (depth-0 fields only) `SchemaMeta` for cycle termination.
   */
  getShallowSchemaMeta(): SchemaMeta {
    if (this.cachedShallowMeta) return this.cachedShallowMeta;
    const fieldsMap: Record<number, string> = {};
    for (const f of this.fields) {
      fieldsMap[f.fieldNum] = f.name;
    }
    this.cachedShallowMeta = {
      typeName: this.shortName,
      fields: fieldsMap,
    };
    return this.cachedShallowMeta;
  }

  /**
   * Detects whether this schema has recursive (cyclic) sub-message edges.
   */
  isCyclicOrDeep(): boolean {
    if (this.cachedCyclicOrDeep !== null) {
      return this.cachedCyclicOrDeep;
    }
    const visiting = new Set<MessageSchema<any>>();
    const visited = new Set<MessageSchema<any>>();
    const dfs = (node: MessageSchema<any>, depth: number): boolean => {
      if (depth > MaxNestingDepth) return true;
      if (visiting.has(node)) return true;
      if (visited.has(node)) return false;
      visiting.add(node);
      for (const f of node.fields) {
        if (f.resolveSubSchema) {
          const sub = f.resolveSubSchema();
          if (sub && dfs(sub, depth + 1)) {
            return true;
          }
        }
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    };
    this.cachedCyclicOrDeep = dfs(this, 0);
    return this.cachedCyclicOrDeep;
  }

  /**
   * Builds the `Field #0` `SchemaMeta` descriptor for this schema up to `MaxNestingDepth` (32).
   * For recursive schemas, follows the actual populated structure of `msg` when provided,
   * and terminates static cycle edges cleanly without exponential expansion.
   */
  getSchemaMeta(
    depth = 0,
    msg?: Record<string, any>,
    ancestors?: Set<MessageSchema<any>>,
  ): SchemaMeta {
    if (depth === 0 && !msg && this.cachedMeta) {
      return this.cachedMeta;
    }
    if (depth === 0 && msg && !this.isCyclicOrDeep() && this.cachedMeta) {
      return this.cachedMeta;
    }
    const fieldsMap: Record<number, string> = {};
    const childrenMap: Record<number, SchemaMeta> = {};
    const pathAncestors = ancestors ?? new Set<MessageSchema<any>>();
    const nextAncestors = new Set(pathAncestors);
    nextAncestors.add(this);

    for (const f of this.fields) {
      fieldsMap[f.fieldNum] = f.name;
      if (f.resolveSubSchema && depth < MaxNestingDepth) {
        const sub = f.resolveSubSchema();
        if (!sub) continue;

        if (msg && typeof msg === 'object') {
          const rawVal = getFieldFromMsg(msg, f);
          if (f.effectiveType === 'submsg') {
            if (rawVal && typeof rawVal === 'object') {
              childrenMap[f.fieldNum] = sub.getSchemaMeta(depth + 1, rawVal, nextAncestors);
            } else if (!pathAncestors.has(sub)) {
              childrenMap[f.fieldNum] = sub.getSchemaMeta(depth + 1, undefined, nextAncestors);
            }
          } else if (f.effectiveType === 'submsg[]') {
            if (Array.isArray(rawVal) && rawVal.length > 0) {
              let merged: SchemaMeta | null = null;
              for (let i = 0; i < rawVal.length; i++) {
                const elem = rawVal[i];
                if (elem && typeof elem === 'object') {
                  merged = mergeSchemaMeta(
                    merged,
                    sub.getSchemaMeta(depth + 1, elem, nextAncestors),
                  );
                }
              }
              if (merged) {
                childrenMap[f.fieldNum] = merged;
              }
            } else if (!pathAncestors.has(sub)) {
              childrenMap[f.fieldNum] = sub.getSchemaMeta(depth + 1, undefined, nextAncestors);
            }
          } else if (f.effectiveType === 'map' && f.mapValType === 'submsg') {
            const vals =
              rawVal instanceof Map
                ? Array.from(rawVal.values())
                : rawVal && typeof rawVal === 'object'
                  ? Object.values(rawVal)
                  : [];
            if (vals.length > 0) {
              let merged: SchemaMeta | null = null;
              for (let i = 0; i < vals.length; i++) {
                const v = vals[i];
                if (v && typeof v === 'object') {
                  merged = mergeSchemaMeta(merged, sub.getSchemaMeta(depth + 1, v, nextAncestors));
                }
              }
              if (merged) {
                childrenMap[f.fieldNum] = merged;
              }
            } else if (!pathAncestors.has(sub)) {
              childrenMap[f.fieldNum] = sub.getSchemaMeta(depth + 1, undefined, nextAncestors);
            }
          }
        } else if (!pathAncestors.has(sub)) {
          childrenMap[f.fieldNum] = sub.getSchemaMeta(depth + 1, undefined, nextAncestors);
        } else {
          childrenMap[f.fieldNum] = sub.getShallowSchemaMeta();
        }
      }
    }
    const meta: SchemaMeta = {
      typeName: this.shortName,
      fields: fieldsMap,
    };
    if (Object.keys(childrenMap).length > 0) {
      meta.children = childrenMap;
    }
    if (depth === 0 && !msg) {
      this.cachedMeta = meta;
    }
    return meta;
  }

  /**
   * Returns pre-encoded deterministic Field #0 bytes.
   */
  getField0Bytes(deterministic = true): Uint8Array {
    if (deterministic && this.cachedField0Det) {
      return this.cachedField0Det;
    }
    const bytes = encodeField0SchemaMeta(this.getSchemaMeta(0), deterministic);
    if (deterministic) {
      this.cachedField0Det = bytes;
    }
    return bytes;
  }

  /**
   * Encodes `msg` into a new `Uint8Array`.
   */
  encode(msg: T, options?: BinaryWriteOptions): Uint8Array {
    if (!sharedEncoderInUse) {
      sharedEncoderInUse = true;
      try {
        const startPos = sharedEncoder.beginMessage();
        this.encodeInto(sharedEncoder, msg, options);
        return sharedEncoder.endMessage(startPos);
      } finally {
        sharedEncoderInUse = false;
      }
    }
    const enc = new Encoder(512);
    this.encodeInto(enc, msg, options);
    return enc.finish();
  }

  /**
   * Encodes `msg` into `enc` in a single forward pass.
   */
  encodeInto(enc: Encoder, msg: T, options?: BinaryWriteOptions): void {
    const deterministic = options?.deterministic ?? false;
    const writeUnknown = options?.writeUnknownFields ?? false;
    if (options?.selfDescribing) {
      if (deterministic && !this.isCyclicOrDeep()) {
        enc.writeRaw(this.getField0Bytes(true));
      } else {
        writeField0SchemaMeta(
          enc,
          this.getSchemaMeta(0, msg as Record<string, any>),
          deterministic,
        );
      }
    }
    if (this.generatedHooks?.encode) {
      this.generatedHooks.encode(enc, msg, options);
      return;
    }
    this.encodeBody(enc, msg as Record<string, any>, deterministic, writeUnknown);
  }

  /**
   * Internal single-pass body encoder (used for root and nested sub-messages).
   */
  encodeBody(
    enc: Encoder,
    msg: Record<string, any>,
    deterministic: boolean,
    writeUnknown = false,
  ): void {
    if (this.generatedHooks?.encode) {
      this.generatedHooks.encode(enc, msg as Partial<T>, {
        deterministic,
        writeUnknownFields: writeUnknown,
      });
      return;
    }
    for (let i = 0; i < this.fields.length; i++) {
      const f = this.fields[i]!;
      const rawVal = getFieldFromMsg(msg, f);

      if (f.oneof || f.explicitPresence) {
        if (rawVal === undefined || rawVal === null) {
          continue;
        }
      }

      if (f.effectiveType === 'submsg') {
        if (rawVal === null || rawVal === undefined) {
          if (f.optional || f.omitEmpty) {
            continue;
          }
        }
        const subSchema = f.resolveSubSchema?.();
        if (!subSchema) continue;
        if (f.omitEmpty && !f.oneof && rawVal && subSchema.isEmptyInstance(rawVal)) {
          continue;
        }
        enc.beginSubMsg(f.fieldNum);
        if (rawVal) {
          subSchema.encodeBody(enc, rawVal, deterministic, writeUnknown);
        } else if (!f.optional) {
          subSchema.encodeBody(enc, subSchema.create(), deterministic, writeUnknown);
        }
        enc.endSubMsg();
        continue;
      }

      if (f.omitEmpty && !f.oneof && !f.explicitPresence && isFieldValueEmpty(f, rawVal)) {
        continue;
      }

      encodeFieldValue(enc, f, rawVal, deterministic, writeUnknown);
    }

    if (writeUnknown && msg && Array.isArray(msg.$unknown)) {
      const unknown: UnknownField[] = msg.$unknown;
      for (let i = 0; i < unknown.length; i++) {
        const uf = unknown[i]!;
        enc.writeTag(uf.no, uf.wireType);
        enc.writeRaw(uf.data);
      }
    }
  }

  isEmptyInstance(msg: Record<string, any>): boolean {
    if (!msg) return true;
    for (const f of this.fields) {
      const val = getFieldFromMsg(msg, f);
      if (f.oneof || f.explicitPresence) {
        if (val !== undefined && val !== null) return false;
        continue;
      }
      if (!isFieldValueEmpty(f, val)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Decodes `data` into `target` (or a newly created instance if omitted).
   */
  decode(data: Uint8Array, target?: T, depth = 0, options?: BinaryReadOptions): T {
    if (this.generatedHooks?.decode) {
      return this.generatedHooks.decode(data, target, depth, options);
    }
    const maxDepth = options?.recursionLimit ?? MaxNestingDepth;
    const readUnknown = options?.readUnknownFields ?? true;
    if (depth > maxDepth) {
      throw new Error(`omnibuf: nesting depth ${depth} exceeds MaxNestingDepth (${maxDepth})`);
    }
    const out: Record<string, any> = (target ?? this.create()) as Record<string, any>;
    if (target) {
      if (this.oneofs.length > 0) {
        this.ensureAccessors(out);
      } else if (!('$typeName' in out)) {
        Object.defineProperty(out, '$typeName', this.typeNameDesc);
      }
    }
    const n = data.length;
    let pos = 0;
    let seenMask = 0;
    let seenSet: Set<number> | null = null;
    let unknownFields: UnknownField[] | null = Array.isArray(out.$unknown) ? out.$unknown : null;

    while (pos < n) {
      let tag = 0;
      const b0 = data[pos]!;
      if ((b0 & 1) !== 0) {
        tag = b0 >>> 1;
        pos += 1;
      } else if ((b0 & 2) !== 0) {
        if (pos + 2 > n) {
          throw new Error(`omnibuf: truncated tag at ${pos}`);
        }
        tag = ((b0 | (data[pos + 1]! << 8)) >>> 2) >>> 0;
        pos += 2;
      } else {
        const [t64, tn] = decodeVarintBigInt(data, pos);
        if (tn === 0 || t64 >> 4n > 0xffffffffn) {
          throw new Error(`omnibuf: truncated or invalid multi-byte tag at ${pos}`);
        }
        tag = Number(t64);
        pos += tn;
      }

      const fieldNum = tag <= 0x7fffffff ? tag >>> 4 : Math.floor(tag / 16);
      const wt = tag & 0x0f;

      if (fieldNum === 0) {
        if (wt !== WireSubMsg) {
          throw new Error(`omnibuf: invalid Field #0 wire type ${wt}`);
        }
        const [meta, nextPos] = readLenSlice(data, pos, 0);
        decodeSchemaMeta(meta, depth + 1, maxDepth);
        pos = nextPos;
        continue;
      }

      const f = this.byNum.get(fieldNum);
      if (
        !f ||
        (f.effectiveType !== 'bool' && f.wireType !== wt) ||
        (f.effectiveType === 'bool' && wt !== WireBoolFalse && wt !== WireBoolTrue)
      ) {
        const valStart = pos;
        pos = validateValue(data, pos, wt, depth, maxDepth);
        if (readUnknown) {
          if (!unknownFields) unknownFields = [];
          unknownFields.push({
            no: fieldNum,
            wireType: wt,
            data: data.subarray(valStart, pos).slice(),
          });
        }
        continue;
      }

      let alreadySeen = Boolean(options?.merge);
      if (fieldNum <= 30) {
        const bit = 1 << fieldNum;
        if ((seenMask & bit) !== 0) alreadySeen = true;
        seenMask |= bit;
      } else {
        if (!seenSet) seenSet = new Set<number>();
        if (seenSet.has(fieldNum)) alreadySeen = true;
        seenSet.add(fieldNum);
      }

      pos = decodeCompiledFieldValue(data, pos, wt, f, out, alreadySeen, depth, options);
    }

    if (unknownFields && unknownFields.length > 0 && !('$unknown' in out)) {
      Object.defineProperty(out, '$unknown', {
        value: unknownFields,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }

    return out as T;
  }
}

function getFieldFromMsg(msg: Record<string, any> | null | undefined, f: CompiledField): any {
  if (!msg) return undefined;
  if (f.oneof) {
    const group = msg[f.oneof] ?? (f.oneofProtoName ? msg[f.oneofProtoName] : undefined);
    if (group && typeof group === 'object' && 'case' in group) {
      if (group.case === f.localName || group.case === f.name || group.case === f.propKey) {
        return group.value;
      }
      return undefined;
    }
  }
  const v = msg[f.propKey];
  if (v !== undefined) return v;
  if (f.altKey !== undefined) return msg[f.altKey];
  return undefined;
}

function coerce64(val: any, useBigInt: boolean, unsigned: boolean): number | bigint {
  if (useBigInt) {
    const b = typeof val === 'bigint' ? val : BigInt(val ?? 0);
    return unsigned ? BigInt.asUintN(64, b) : BigInt.asIntN(64, b);
  }
  if (typeof val === 'bigint') {
    return val >= -9007199254740991n && val <= 9007199254740991n ? Number(val) : val;
  }
  return Number(val ?? 0);
}

function initFieldValue(f: CompiledField, val: any): unknown {
  if (val === null || val === undefined) {
    return defaultFieldValue(f);
  }
  if (f.effectiveType === 'submsg') {
    const sub = f.resolveSubSchema?.();
    if (!sub) return val;
    return sub.create(val);
  }
  if (f.effectiveType === 'submsg[]') {
    const sub = f.resolveSubSchema?.();
    if (!Array.isArray(val)) return [];
    return sub ? val.map((item) => sub.create(item)) : Array.from(val);
  }
  if (f.effectiveType.endsWith('[]')) {
    if (!Array.isArray(val) && !ArrayBuffer.isView(val)) return [];
    const arr = Array.from(val as ArrayLike<any>);
    if (f.effectiveType === 'bytes[]') {
      return arr.map((b) =>
        b instanceof Uint8Array
          ? b.slice()
          : typeof b === 'string'
            ? base64ToUint8Array(b)
            : new Uint8Array(0),
      );
    }
    if (f.effectiveType === 'uint64[]' || f.effectiveType === 'fixed64[]') {
      return arr.map((x) => coerce64(x, f.useBigInt, true));
    }
    if (
      f.effectiveType === 'sint64[]' ||
      f.effectiveType === 'int64[]' ||
      f.effectiveType === 'sfixed64[]'
    ) {
      return arr.map((x) => coerce64(x, f.useBigInt, false));
    }
    return arr;
  }
  if (f.effectiveType === 'map') {
    const sub = f.resolveSubSchema?.();
    const isSubMsgVal = f.mapValType === 'submsg' && sub;
    if (val instanceof Map) {
      const m = new Map();
      for (const [k, v] of val.entries()) {
        m.set(k, isSubMsgVal ? sub.create(v) : v);
      }
      return m;
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val as Record<string, any>)) {
      out[k] = isSubMsgVal ? sub.create(v) : v;
    }
    return out;
  }
  switch (f.effectiveType) {
    case 'bytes':
      return val instanceof Uint8Array
        ? val.slice()
        : typeof val === 'string'
          ? base64ToUint8Array(val)
          : new Uint8Array(0);
    case 'uint64':
    case 'fixed64':
      return coerce64(val, f.useBigInt, true);
    case 'sint64':
    case 'int64':
    case 'sfixed64':
      return coerce64(val, f.useBigInt, false);
    default:
      return val;
  }
}

function cloneFieldValue(f: CompiledField, val: any): unknown {
  if (val === null || val === undefined) {
    return f.effectiveType === 'submsg' && f.optional ? null : defaultFieldValue(f);
  }
  if (f.effectiveType === 'submsg') {
    const sub = f.resolveSubSchema?.();
    return sub ? sub.clone(val) : { ...val };
  }
  if (f.effectiveType === 'submsg[]') {
    const sub = f.resolveSubSchema?.();
    if (!Array.isArray(val)) return [];
    return sub ? val.map((item) => sub.clone(item)) : val.map((x) => ({ ...x }));
  }
  if (f.effectiveType === 'bytes') {
    return val instanceof Uint8Array ? val.slice() : new Uint8Array(0);
  }
  if (f.effectiveType === 'bytes[]') {
    return Array.isArray(val)
      ? val.map((b: Uint8Array) => (b instanceof Uint8Array ? b.slice() : new Uint8Array(0)))
      : [];
  }
  if (f.effectiveType.endsWith('[]')) {
    return Array.isArray(val) ? val.slice() : [];
  }
  if (f.effectiveType === 'map') {
    const sub = f.resolveSubSchema?.();
    const isSubMsgVal = f.mapValType === 'submsg' && sub;
    if (val instanceof Map) {
      const m = new Map();
      for (const [k, v] of val.entries()) {
        m.set(k, isSubMsgVal ? sub.clone(v) : v);
      }
      return m;
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val as Record<string, any>)) {
      out[k] = isSubMsgVal ? sub.clone(v) : v;
    }
    return out;
  }
  return val;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function scalarValuesEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (
    (typeof a === 'number' || typeof a === 'bigint') &&
    (typeof b === 'number' || typeof b === 'bigint')
  ) {
    try {
      return BigInt(a) === BigInt(b);
    } catch {
      return false;
    }
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return bytesEqual(a, b);
  }
  return false;
}

function fieldValuesEqual(
  f: CompiledField,
  a: any,
  b: any,
  options?: { unknown?: boolean },
): boolean {
  if (f.effectiveType === 'submsg') {
    const sub = f.resolveSubSchema?.();
    if (!a && !b) return true;
    if (!a || !b) return false;
    return sub ? sub.equals(a, b, options) : a === b;
  }
  if (f.effectiveType === 'submsg[]') {
    const sub = f.resolveSubSchema?.();
    const arrA = Array.isArray(a) ? a : [];
    const arrB = Array.isArray(b) ? b : [];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (sub && !sub.equals(arrA[i], arrB[i], options)) return false;
    }
    return true;
  }
  if (f.effectiveType.endsWith('[]')) {
    const arrA = Array.isArray(a) ? a : [];
    const arrB = Array.isArray(b) ? b : [];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (!scalarValuesEqual(arrA[i], arrB[i])) return false;
    }
    return true;
  }
  if (f.effectiveType === 'map') {
    const sub = f.resolveSubSchema?.();
    const isSubMsgVal = f.mapValType === 'submsg' && sub;
    const entriesA: [string, any][] =
      a instanceof Map
        ? Array.from(a.entries()).map(([k, v]) => [String(k), v])
        : a && typeof a === 'object'
          ? Object.entries(a)
          : [];
    const entriesB: Map<string, any> =
      b instanceof Map
        ? new Map(Array.from(b.entries()).map(([k, v]) => [String(k), v]))
        : b && typeof b === 'object'
          ? new Map(Object.entries(b))
          : new Map();
    if (entriesA.length !== entriesB.size) return false;
    for (const [k, va] of entriesA) {
      if (!entriesB.has(k)) return false;
      const vb = entriesB.get(k);
      if (isSubMsgVal) {
        if (!sub.equals(va, vb, options)) return false;
      } else if (!scalarValuesEqual(va, vb)) {
        return false;
      }
    }
    return true;
  }
  if (f.effectiveType === 'bytes') {
    const ba = a instanceof Uint8Array ? a : new Uint8Array(0);
    const bb = b instanceof Uint8Array ? b : new Uint8Array(0);
    return bytesEqual(ba, bb);
  }
  return scalarValuesEqual(a ?? defaultFieldValue(f), b ?? defaultFieldValue(f));
}

/**
 * Checks whether `arg` is a `Message` instance, optionally verifying its `$typeName` matches `schema`.
 * Modeled after `@bufbuild/protobuf` v2 `isMessage(arg, schema?)`.
 */
export function isMessage<T extends Message<any> = Message>(
  arg: unknown,
  schema?: { readonly typeName: string; readonly shortName?: string },
): arg is T {
  if (
    typeof arg !== 'object' ||
    arg === null ||
    !('$typeName' in arg) ||
    typeof (arg as any).$typeName !== 'string'
  ) {
    return false;
  }
  if (schema === undefined) {
    return true;
  }
  const actualType = (arg as any).$typeName;
  return (
    actualType === schema.typeName ||
    (schema.shortName !== undefined && actualType === schema.shortName)
  );
}

function defaultFieldValue(f: CompiledField, creatingAncestors?: Set<MessageSchema<any>>): unknown {
  if (f.explicitPresence) return undefined;
  if (f.effectiveType.endsWith('[]')) return [];
  if (f.effectiveType === 'map') return {};
  if (f.effectiveType === 'submsg') {
    if (f.optional) return null;
    const sub = f.resolveSubSchema?.();
    if (!sub) return {};
    if (creatingAncestors?.has(sub)) return null;
    return sub.create(undefined, creatingAncestors);
  }
  switch (f.effectiveType) {
    case 'bool':
      return false;
    case 'string':
      return '';
    case 'bytes':
      return new Uint8Array(0);
    default:
      return f.useBigInt ? 0n : 0;
  }
}

function isFieldValueEmpty(f: CompiledField, val: any): boolean {
  if (val === null || val === undefined) return true;
  if (f.effectiveType.endsWith('[]')) {
    return !Array.isArray(val) && !ArrayBuffer.isView(val)
      ? true
      : (val as ArrayLike<any>).length === 0;
  }
  if (f.effectiveType === 'map') {
    if (val instanceof Map) return val.size === 0;
    return Object.keys(val).length === 0;
  }
  switch (f.effectiveType) {
    case 'bool':
      return val === false;
    case 'string':
      return val === '';
    case 'bytes':
      return (val as Uint8Array).length === 0;
    case 'submsg': {
      const sub = f.resolveSubSchema?.();
      return sub ? sub.isEmptyInstance(val) : true;
    }
    default:
      return val === 0 || val === 0n;
  }
}

function encodeFieldValue(
  enc: Encoder,
  f: CompiledField,
  rawVal: any,
  deterministic: boolean,
  writeUnknown = false,
): void {
  const fnum = f.fieldNum;
  switch (f.effectiveType) {
    case 'uint32':
    case 'enum':
      enc.writeUint(fnum, Number(rawVal ?? 0) >>> 0);
      break;
    case 'uint64': {
      const v = rawVal ?? 0;
      enc.writeUint(
        fnum,
        typeof v === 'bigint' ? BigInt.asUintN(64, v) : v < 0 ? BigInt.asUintN(64, BigInt(v)) : v,
      );
      break;
    }
    case 'sint32':
    case 'int32':
      enc.writeInt(fnum, Number(rawVal ?? 0) | 0);
      break;
    case 'sint64':
    case 'int64':
      enc.writeInt(fnum, rawVal ?? 0);
      break;
    case 'bool':
      enc.writeBool(fnum, Boolean(rawVal));
      break;
    case 'string':
      enc.writeString(fnum, String(rawVal ?? ''));
      break;
    case 'bytes':
      enc.writeBytes(
        fnum,
        rawVal instanceof Uint8Array
          ? rawVal
          : typeof rawVal === 'string'
            ? base64ToUint8Array(rawVal)
            : new Uint8Array(0),
      );
      break;
    case 'float32':
      enc.writeFloat32(fnum, Number(rawVal ?? 0));
      break;
    case 'fixed32':
    case 'sfixed32':
      enc.writeFixed32(fnum, Number(rawVal ?? 0) >>> 0);
      break;
    case 'float64':
      enc.writeFloat64(fnum, Number(rawVal ?? 0));
      break;
    case 'fixed64':
    case 'sfixed64':
      enc.writeFixed64(fnum, rawVal ?? 0);
      break;
    case 'string[]':
      enc.writeStringArr(fnum, Array.isArray(rawVal) ? rawVal : []);
      break;
    case 'bytes[]':
      enc.writeBytesArr(fnum, Array.isArray(rawVal) ? rawVal : []);
      break;
    case 'bool[]':
      enc.writeBoolArr(fnum, Array.isArray(rawVal) ? rawVal : []);
      break;
    case 'uint32[]':
    case 'enum[]':
      enc.writeUint32Arr(fnum, rawVal ?? []);
      break;
    case 'uint64[]':
      enc.writeUintArr(fnum, rawVal ?? []);
      break;
    case 'sint32[]':
    case 'int32[]':
    case 'sint64[]':
    case 'int64[]':
      enc.writeSintArr(fnum, rawVal ?? []);
      break;
    case 'float32[]':
      enc.writeFloat32Arr(fnum, rawVal ?? []);
      break;
    case 'fixed32[]':
    case 'sfixed32[]':
      enc.writeFixed32Arr(fnum, rawVal ?? []);
      break;
    case 'float64[]':
      enc.writeFloat64Arr(fnum, rawVal ?? []);
      break;
    case 'fixed64[]':
    case 'sfixed64[]':
      enc.writeFixed64Arr(fnum, rawVal ?? []);
      break;
    case 'submsg[]': {
      const subSchema = f.resolveSubSchema?.();
      if (!subSchema) break;
      const items: any[] = Array.isArray(rawVal) ? rawVal : [];
      enc.beginSubMsgArr(fnum);
      for (let i = 0; i < items.length; i++) {
        enc.beginSubMsgElem();
        if (items[i] !== null && items[i] !== undefined) {
          subSchema.encodeBody(enc, items[i], deterministic, writeUnknown);
        }
        enc.endSubMsgElem();
      }
      enc.endSubMsgArr();
      break;
    }
    case 'map': {
      encodeMapField(enc, f, rawVal, deterministic, writeUnknown);
      break;
    }
  }
}

function encodeMapScalarEntry(enc: Encoder, t: ScalarFieldType, val: any): void {
  switch (t) {
    case 'string':
      enc.writeRawStringPayload(String(val ?? ''));
      break;
    case 'bytes':
      enc.writeRawBytesPayload(
        val instanceof Uint8Array
          ? val
          : typeof val === 'string'
            ? base64ToUint8Array(val)
            : new Uint8Array(0),
      );
      break;
    case 'uint32':
    case 'enum':
      enc.writeRawVarint(Number(val ?? 0) >>> 0);
      break;
    case 'uint64': {
      const v =
        typeof val === 'bigint'
          ? BigInt.asUintN(64, val)
          : typeof val === 'string'
            ? BigInt.asUintN(64, BigInt(val))
            : val < 0
              ? BigInt.asUintN(64, BigInt(val))
              : Number(val ?? 0);
      enc.writeRawVarint(v);
      break;
    }
    case 'sint32':
    case 'int32':
      enc.writeRawVarint(encodeZigZagNumber(Number(val ?? 0) | 0));
      break;
    case 'sint64':
    case 'int64': {
      const v =
        typeof val === 'bigint' ? val : typeof val === 'string' ? BigInt(val) : Number(val ?? 0);
      enc.writeRawVarint(encodeZigZag(v));
      break;
    }
    case 'float32':
      enc.writeRawFloat32(Number(val ?? 0));
      break;
    case 'fixed32':
    case 'sfixed32':
      enc.writeRawFixed32(Number(val ?? 0) >>> 0);
      break;
    case 'float64':
      enc.writeRawFloat64(Number(val ?? 0));
      break;
    case 'fixed64':
    case 'sfixed64': {
      const v =
        typeof val === 'bigint' ? val : typeof val === 'string' ? BigInt(val) : Number(val ?? 0);
      enc.writeRawFixed64(v);
      break;
    }
    case 'bool': {
      const b = val === true || val === 'true' || val === 1;
      enc.writeRawVarint(b ? 1 : 0);
      break;
    }
  }
}

function compareMapKeys(keyType: ScalarFieldType, a: any, b: any): number {
  switch (keyType) {
    case 'string': {
      const sa = String(a);
      const sb = String(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    case 'bool': {
      const ba = a === true || a === 'true' ? 1 : 0;
      const bb = b === true || b === 'true' ? 1 : 0;
      return ba - bb;
    }
    default: {
      const na = BigInt(a);
      const nb = BigInt(b);
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
  }
}

function encodeMapField(
  enc: Encoder,
  f: CompiledField,
  rawVal: any,
  deterministic: boolean,
  writeUnknown = false,
): void {
  const keyWT = f.mapKeyWT ?? WireString;
  const valWT = f.mapValWT ?? WireUint;
  const keyType = f.mapKeyType ?? 'string';
  const valType = f.mapValType ?? 'uint64';
  const subSchema = f.resolveSubSchema?.();

  const entries: [any, any][] =
    rawVal instanceof Map
      ? Array.from(rawVal.entries())
      : rawVal && typeof rawVal === 'object'
        ? Object.entries(rawVal)
        : [];

  enc.writeTag(f.fieldNum, WireMap);
  enc.beginContainer();
  enc.writeByte(mapHeaderByte(keyWT, valWT));
  enc.writeRawVarint(entries.length);

  if (deterministic && entries.length > 1) {
    entries.sort((a, b) => compareMapKeys(keyType, a[0], b[0]));
  }

  for (let i = 0; i < entries.length; i++) {
    const [k, v] = entries[i]!;
    encodeMapScalarEntry(enc, keyType, k);
    if (valType === 'submsg') {
      enc.beginContainer();
      if (v && subSchema) {
        subSchema.encodeBody(enc, v, deterministic, writeUnknown);
      }
      enc.endContainer();
    } else {
      encodeMapScalarEntry(enc, valType, v);
    }
  }
  enc.endContainer();
}

function decodeCompiledFieldValue(
  data: Uint8Array,
  pos: number,
  wt: number,
  f: CompiledField,
  out: Record<string, any>,
  alreadySeen: boolean,
  depth: number,
  options?: BinaryReadOptions,
): number {
  const key = f.propKey;
  const n = data.length;

  switch (f.effectiveType) {
    case 'uint32':
    case 'enum': {
      if (pos < n && (data[pos]! & 7) !== 0) {
        const [v, vn] = decodeVarint(data, pos);
        if (vn === 0) throw new Error(`omnibuf: truncated uint32 at ${pos}`);
        out[key] = v >>> 0;
        return pos + vn;
      }
      const [v, vn] = decodeVarintBigInt(data, pos);
      if (vn === 0) throw new Error(`omnibuf: truncated uint32 at ${pos}`);
      out[key] = Number(v & 0xffffffffn) >>> 0;
      return pos + vn;
    }
    case 'uint64': {
      const [v, vn] = f.useBigInt ? decodeVarintBigInt(data, pos) : decodeVarintAuto(data, pos);
      if (vn === 0) throw new Error(`omnibuf: truncated uint64 at ${pos}`);
      out[key] = v;
      return pos + vn;
    }
    case 'sint32':
    case 'int32': {
      if (pos < n && (data[pos]! & 7) !== 0) {
        const [v, vn] = decodeVarint(data, pos);
        if (vn === 0) throw new Error(`omnibuf: truncated int32 at ${pos}`);
        out[key] = decodeZigZag(v) | 0;
        return pos + vn;
      }
      const [v, vn] = decodeVarintBigInt(data, pos);
      if (vn === 0) throw new Error(`omnibuf: truncated int32 at ${pos}`);
      out[key] = decodeZigZag(v) | 0;
      return pos + vn;
    }
    case 'sint64':
    case 'int64': {
      const [v, vn] = decodeVarintBigInt(data, pos);
      if (vn === 0) throw new Error(`omnibuf: truncated int64 at ${pos}`);
      out[key] = f.useBigInt ? decodeZigZagBigInt(v) : decodeZigZagAuto(v);
      return pos + vn;
    }
    case 'bool': {
      out[key] = wt === WireBoolTrue;
      return pos;
    }
    case 'string': {
      const [s, nextPos] = readLenSlice(data, pos, 0);
      out[key] = decodeUTF8(s);
      return nextPos;
    }
    case 'bytes': {
      const [b, nextPos] = readLenSlice(data, pos, 0);
      out[key] = b.slice();
      return nextPos;
    }
    case 'float32': {
      if (n - pos < 4) throw new Error(`omnibuf: truncated fixed32 at ${pos}`);
      const bits =
        (data[pos]! | (data[pos + 1]! << 8) | (data[pos + 2]! << 16) | (data[pos + 3]! << 24)) >>>
        0;
      out[key] = roundFloat32Shortest(float32FromBits(bits));
      return pos + 4;
    }
    case 'fixed32': {
      if (n - pos < 4) throw new Error(`omnibuf: truncated fixed32 at ${pos}`);
      const bits =
        (data[pos]! | (data[pos + 1]! << 8) | (data[pos + 2]! << 16) | (data[pos + 3]! << 24)) >>>
        0;
      out[key] = bits;
      return pos + 4;
    }
    case 'sfixed32': {
      if (n - pos < 4) throw new Error(`omnibuf: truncated sfixed32 at ${pos}`);
      const bits =
        data[pos]! | (data[pos + 1]! << 8) | (data[pos + 2]! << 16) | (data[pos + 3]! << 24);
      out[key] = bits | 0;
      return pos + 4;
    }
    case 'float64': {
      if (n - pos < 8) throw new Error(`omnibuf: truncated fixed64 at ${pos}`);
      out[key] = readFloat64At(data, pos);
      return pos + 8;
    }
    case 'fixed64': {
      if (n - pos < 8) throw new Error(`omnibuf: truncated fixed64 at ${pos}`);
      let u64 = 0n;
      for (let b = 7; b >= 0; b--) {
        u64 = (u64 << 8n) | BigInt(data[pos + b]!);
      }
      out[key] = !f.useBigInt && u64 <= 9007199254740991n ? Number(u64) : u64;
      return pos + 8;
    }
    case 'sfixed64': {
      if (n - pos < 8) throw new Error(`omnibuf: truncated sfixed64 at ${pos}`);
      let u64 = 0n;
      for (let b = 7; b >= 0; b--) {
        u64 = (u64 << 8n) | BigInt(data[pos + b]!);
      }
      const s64 = BigInt.asIntN(64, u64);
      out[key] =
        !f.useBigInt && s64 >= -9007199254740991n && s64 <= 9007199254740991n ? Number(s64) : s64;
      return pos + 8;
    }
    case 'string[]': {
      const [body, nextPos] = readLenSlice(data, pos, 1);
      const prev: string[] = alreadySeen && Array.isArray(out[key]) ? out[key] : [];
      const [arr, ok] = appendStringArrBody(prev, body);
      if (!ok) throw new Error(`omnibuf: invalid string array at ${pos}`);
      out[key] = arr;
      return nextPos;
    }
    case 'bytes[]': {
      const [body, nextPos] = readLenSlice(data, pos, 1);
      const prev: Uint8Array[] = alreadySeen && Array.isArray(out[key]) ? out[key] : [];
      const [arr, ok] = appendBytesArrBody(prev, body, false);
      if (!ok) throw new Error(`omnibuf: invalid bytes array at ${pos}`);
      out[key] = arr;
      return nextPos;
    }
    case 'bool[]': {
      const [body, nextPos] = readLenSlice(data, pos, 1);
      const prev: boolean[] = alreadySeen && Array.isArray(out[key]) ? out[key] : [];
      const [arr, ok] = appendBoolArrBody(prev, body);
      if (!ok) throw new Error(`omnibuf: invalid bool array at ${pos}`);
      out[key] = arr;
      return nextPos;
    }
    case 'uint32[]':
    case 'enum[]': {
      const [body, nextPos] = readLenSlice(data, pos, 1);
      const prev: number[] = alreadySeen && Array.isArray(out[key]) ? out[key] : [];
      const [arr, ok] = appendUint32ArrBody(prev, body);
      if (!ok) throw new Error(`omnibuf: invalid uint32 array at ${pos}`);
      out[key] = arr;
      return nextPos;
    }
    case 'uint64[]': {
      const [body, nextPos] = readLenSlice(data, pos, 1);
      const prev: (number | bigint)[] = alreadySeen && Array.isArray(out[key]) ? out[key] : [];
      const [arr, ok] = appendUintArrAutoBody(prev, body);
      if (!ok) throw new Error(`omnibuf: invalid uint64 array at ${pos}`);
      out[key] = f.useBigInt ? arr.map((x) => BigInt(x)) : arr;
      return nextPos;
    }
    case 'sint32[]':
    case 'int32[]':
    case 'sint64[]':
    case 'int64[]': {
      const [body, nextPos] = readLenSlice(data, pos, 1);
      const prev: (number | bigint)[] = alreadySeen && Array.isArray(out[key]) ? out[key] : [];
      const [arr, ok] = appendSintArrAutoBody(prev, body);
      if (!ok) throw new Error(`omnibuf: invalid sint array at ${pos}`);
      const is64 = f.effectiveType === 'sint64[]' || f.effectiveType === 'int64[]';
      out[key] = f.useBigInt && is64 ? arr.map((x) => BigInt(x)) : arr;
      return nextPos;
    }
    case 'float32[]': {
      const [body, nextPos] = readLenSlice(data, pos, 1);
      const prev: number[] = alreadySeen && Array.isArray(out[key]) ? out[key] : [];
      const [arr, ok] = appendFloat32ArrBody(prev, body);
      if (!ok) throw new Error(`omnibuf: invalid float32 array at ${pos}`);
      out[key] = arr.map(roundFloat32Shortest);
      return nextPos;
    }
    case 'fixed32[]': {
      const [body, nextPos] = readLenSlice(data, pos, 1);
      if (body.length < 1 || body[0] !== WireFixed32 || (body.length - 1) % 4 !== 0) {
        throw new Error(`omnibuf: invalid fixed32 array at ${pos}`);
      }
      const prev: number[] = alreadySeen && Array.isArray(out[key]) ? out[key] : [];
      const c = (body.length - 1) / 4;
      for (let i = 0; i < c; i++) {
        const off = 1 + i * 4;
        prev.push(
          (body[off]! | (body[off + 1]! << 8) | (body[off + 2]! << 16) | (body[off + 3]! << 24)) >>>
            0,
        );
      }
      out[key] = prev;
      return nextPos;
    }
    case 'sfixed32[]': {
      const [body, nextPos] = readLenSlice(data, pos, 1);
      if (body.length < 1 || body[0] !== WireFixed32 || (body.length - 1) % 4 !== 0) {
        throw new Error(`omnibuf: invalid sfixed32 array at ${pos}`);
      }
      const prev: number[] = alreadySeen && Array.isArray(out[key]) ? out[key] : [];
      const c = (body.length - 1) / 4;
      for (let i = 0; i < c; i++) {
        const off = 1 + i * 4;
        prev.push(
          body[off]! | (body[off + 1]! << 8) | (body[off + 2]! << 16) | (body[off + 3]! << 24) | 0,
        );
      }
      out[key] = prev;
      return nextPos;
    }
    case 'float64[]': {
      const [body, nextPos] = readLenSlice(data, pos, 1);
      const prev: number[] = alreadySeen && Array.isArray(out[key]) ? out[key] : [];
      const [arr, ok] = appendFloat64ArrBody(prev, body);
      if (!ok) throw new Error(`omnibuf: invalid float64 array at ${pos}`);
      out[key] = arr;
      return nextPos;
    }
    case 'fixed64[]':
    case 'sfixed64[]': {
      const [body, nextPos] = readLenSlice(data, pos, 1);
      if (body.length < 1 || body[0] !== WireFixed64 || (body.length - 1) % 8 !== 0) {
        throw new Error(`omnibuf: invalid fixed64 array at ${pos}`);
      }
      const prev: (number | bigint)[] = alreadySeen && Array.isArray(out[key]) ? out[key] : [];
      const c = (body.length - 1) / 8;
      const isSigned = f.effectiveType === 'sfixed64[]';
      for (let i = 0; i < c; i++) {
        const off = 1 + i * 8;
        let u64 = 0n;
        for (let b = 7; b >= 0; b--) {
          u64 = (u64 << 8n) | BigInt(body[off + b]!);
        }
        if (isSigned) {
          const s64 = BigInt.asIntN(64, u64);
          prev.push(
            !f.useBigInt && s64 >= -9007199254740991n && s64 <= 9007199254740991n
              ? Number(s64)
              : s64,
          );
        } else {
          prev.push(!f.useBigInt && u64 <= 9007199254740991n ? Number(u64) : u64);
        }
      }
      out[key] = prev;
      return nextPos;
    }
    case 'submsg': {
      const [subBytes, nextPos] = readLenSlice(data, pos, 0);
      const subSchema = f.resolveSubSchema?.();
      if (!subSchema) {
        throw new Error(`omnibuf: missing subSchema on ${key}`);
      }
      const existing = out[key];
      const targetSub = existing && typeof existing === 'object' ? existing : subSchema.create();
      out[key] = subSchema.decode(subBytes, targetSub, depth + 1, {
        ...options,
        merge: alreadySeen,
      });
      return nextPos;
    }
    case 'submsg[]': {
      const [arrPayload, nextPos] = readLenSlice(data, pos, 0);
      const [elemCount, ok] = countSubMsgArrElems(arrPayload);
      if (!ok) {
        throw new Error(`omnibuf: corrupt submsg array at ${pos}`);
      }
      const subSchema = f.resolveSubSchema?.();
      if (!subSchema) {
        throw new Error(`omnibuf: missing subSchema on ${key}`);
      }
      const elems: any[] = alreadySeen && Array.isArray(out[key]) ? out[key] : [];
      let p = 0;
      for (let i = 0; i < elemCount; i++) {
        const [el, en] = decodeVarintBigInt(arrPayload, p);
        p += en;
        const elNum = Number(el);
        const elemObj = subSchema.decode(
          arrPayload.subarray(p, p + elNum),
          subSchema.create(),
          depth + 1,
          options,
        );
        elems.push(elemObj);
        p += elNum;
      }
      out[key] = elems;
      return nextPos;
    }
    case 'map': {
      const [body, nextPos] = readLenSlice(data, pos, 2);
      decodeMapFieldBody(f, out, body, alreadySeen, depth, options);
      return nextPos;
    }
  }
}

function decodeMapScalarEntry(
  body: Uint8Array,
  p: number,
  wt: number,
  subSchema: MessageSchema<any> | undefined,
  depth: number,
  options?: BinaryReadOptions,
): [val: any, nextPos: number] {
  switch (wt) {
    case WireString: {
      const [sBytes, nextP] = readLenSlice(body, p, 0);
      return [decodeUTF8(sBytes), nextP];
    }
    case WireBytes: {
      const [bBytes, nextP] = readLenSlice(body, p, 0);
      return [bBytes.slice(), nextP];
    }
    case WireUint: {
      const [v, vn] = decodeVarintAuto(body, p);
      if (vn === 0) throw new Error(`omnibuf: truncated WireMap uint at ${p}`);
      return [v, p + vn];
    }
    case WireSint: {
      const [v, vn] = decodeVarintBigInt(body, p);
      if (vn === 0) throw new Error(`omnibuf: truncated WireMap sint at ${p}`);
      return [decodeZigZagAuto(v), p + vn];
    }
    case WireFixed32: {
      if (body.length - p < 4) {
        throw new Error(`omnibuf: truncated WireMap fixed32 at ${p}`);
      }
      const bits =
        (body[p]! | (body[p + 1]! << 8) | (body[p + 2]! << 16) | (body[p + 3]! << 24)) >>> 0;
      return [bits, p + 4];
    }
    case WireFixed64: {
      if (body.length - p < 8) {
        throw new Error(`omnibuf: truncated WireMap fixed64 at ${p}`);
      }
      let u64 = 0n;
      for (let b = 7; b >= 0; b--) {
        u64 = (u64 << 8n) | BigInt(body[p + b]!);
      }
      return [u64 <= 9007199254740991n ? Number(u64) : u64, p + 8];
    }
    case WireBoolTrue:
    case WireBoolFalse: {
      if (body.length - p < 1) {
        throw new Error(`omnibuf: truncated WireMap bool at ${p}`);
      }
      const b = body[p]!;
      if (b !== 0 && b !== 1) {
        throw new Error(`omnibuf: invalid WireMap bool ${b} at ${p}`);
      }
      return [b === 1, p + 1];
    }
    case WireSubMsg: {
      const [subBytes, nextP] = readLenSlice(body, p, 0);
      if (!subSchema) {
        throw new Error(`omnibuf: missing subSchema for WireMap submsg value`);
      }
      const subObj = subSchema.decode(subBytes, subSchema.create(), depth + 1, options);
      return [subObj, nextP];
    }
    default:
      throw new Error(`omnibuf: invalid WireMap entry wire type ${wt}`);
  }
}

function decodeMapFieldBody(
  f: CompiledField,
  out: Record<string, any>,
  body: Uint8Array,
  alreadySeen: boolean,
  depth: number,
  options?: BinaryReadOptions,
): void {
  const expHeader = mapHeaderByte(f.mapKeyWT ?? WireString, f.mapValWT ?? WireUint);
  if (body.length < 2 || body[0] !== expHeader) {
    throw new Error(
      `omnibuf: WireMap header mismatch (got 0x${body[0]?.toString(16)}, want 0x${expHeader.toString(16)})`,
    );
  }
  const [count, cn] = decodeVarintBigInt(body, 1);
  if (cn === 0 || count * 2n > BigInt(body.length - (1 + cn))) {
    throw new Error(`omnibuf: invalid WireMap count ${count}`);
  }
  const subSchema = f.resolveSubSchema?.();
  const existing = out[f.propKey];
  const isMapInstance = existing instanceof Map;
  let targetMap: Map<any, any> | Record<string, any>;
  if (isMapInstance) {
    if (!alreadySeen) existing.clear();
    targetMap = existing;
  } else {
    targetMap = alreadySeen && existing && typeof existing === 'object' ? existing : {};
    out[f.propKey] = targetMap;
  }

  const isVal64 =
    f.useBigInt &&
    (f.mapValType === 'uint64' ||
      f.mapValType === 'sint64' ||
      f.mapValType === 'int64' ||
      f.mapValType === 'fixed64' ||
      f.mapValType === 'sfixed64');

  let p = 1 + cn;
  const c = Number(count);
  for (let i = 0; i < c; i++) {
    const [kv, nextP] = decodeMapScalarEntry(
      body,
      p,
      f.mapKeyWT ?? WireString,
      undefined,
      depth,
      options,
    );
    const [rawVv, nextP2] = decodeMapScalarEntry(
      body,
      nextP,
      f.mapValWT ?? WireUint,
      subSchema,
      depth,
      options,
    );
    const convert = (v: any, type: ScalarFieldType | 'submsg' | undefined): any => {
      if (type === 'bool') return v !== 0 && v !== 0n;
      if (type === 'float32') return float32FromBits(Number(v));
      if (type === 'float64') return float64FromBits(BigInt(v));
      if (type === 'sfixed32' || type === 'int32' || type === 'sint32') return Number(v) | 0;
      if (type === 'sfixed64') {
        const signed = BigInt.asIntN(64, BigInt(v));
        return f.useBigInt || signed < -9007199254740991n || signed > 9007199254740991n
          ? signed
          : Number(signed);
      }
      return v;
    };
    const vv = convert(isVal64 ? BigInt(rawVv) : rawVv, f.mapValType);
    const key = convert(kv, f.mapKeyType);
    p = nextP2;
    if (targetMap instanceof Map) {
      targetMap.set(key, vv);
    } else {
      Object.defineProperty(targetMap, String(key), {
        value: vv,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  if (p !== body.length) {
    throw new Error(`omnibuf: WireMap trailing bytes (${p} !== ${body.length})`);
  }
}

/**
 * Defines a declarative `MessageSchema<T>` for plain TypeScript objects or classes.
 */
export function defineMessage<
  T extends object = Record<string, any>,
  TypeName extends string = string,
>(
  typeName: TypeName,
  fields: Record<string, FieldSpec>,
  factory?: () => T,
  generatedHooks?: GeneratedCodecHooks<T>,
): MessageSchema<T, TypeName> {
  return new MessageSchema<T, TypeName>(typeName, fields, factory, generatedHooks);
}

// ============================================================================
// TypeScript Class & Field Decorators (Stage 3 Standard + Legacy Experimental)
// ============================================================================

const SCHEMA_SYMBOL = Symbol.for('omnibuf.schema');
const PENDING_FIELDS_SYMBOL = Symbol.for('omnibuf.pendingFields');

const classPendingFields = new WeakMap<object, Record<string, FieldSpec>>();
const classSchemaRegistry = new WeakMap<object, MessageSchema<any>>();

export type DecoratorFieldOptions = Partial<Omit<FieldSpec, 'fieldNum'>>;

/**
 * Field decorator for declaring OmniBuf field metadata on a TypeScript class property.
 * Supports both Stage 3 standard decorators (`(target, context: ClassFieldDecoratorContext)`)
 * and legacy experimental decorators (`(target, propertyKey)`).
 */
export function omnibufField(fieldNum: number, options: DecoratorFieldOptions = {}): any {
  const spec: FieldSpec = {
    ...options,
    fieldNum,
    type: options.type ?? 'string',
  };

  return function (target: any, contextOrPropKey: any): any {
    // Stage 3 standard decorator: contextOrPropKey is ClassFieldDecoratorContext
    if (
      contextOrPropKey &&
      typeof contextOrPropKey === 'object' &&
      'kind' in contextOrPropKey &&
      'name' in contextOrPropKey
    ) {
      const propKey = String(contextOrPropKey.name);
      if (contextOrPropKey.metadata) {
        const metaObj = contextOrPropKey.metadata as Record<symbol, any>;
        if (!metaObj[PENDING_FIELDS_SYMBOL]) {
          metaObj[PENDING_FIELDS_SYMBOL] = {};
        }
        metaObj[PENDING_FIELDS_SYMBOL][propKey] = spec;
      }
      // Also attach an initializer so instances without Symbol.metadata still register on constructor
      if (typeof contextOrPropKey.addInitializer === 'function') {
        contextOrPropKey.addInitializer(function (this: any) {
          const ctor = this?.constructor;
          if (ctor) {
            let map = classPendingFields.get(ctor);
            if (!map) {
              map = {};
              classPendingFields.set(ctor, map);
            }
            map[propKey] = spec;
          }
        });
      }
      return;
    }

    // Legacy experimental decorator: target is prototype, contextOrPropKey is string | symbol
    const ctor = typeof target === 'function' ? target : target?.constructor;
    const propKey = String(contextOrPropKey);
    if (ctor) {
      let map = classPendingFields.get(ctor);
      if (!map) {
        map = {};
        classPendingFields.set(ctor, map);
      }
      map[propKey] = spec;
    }
  };
}

/**
 * Class decorator that compiles and registers an OmniBuf `MessageSchema` for the class.
 */
export function omnibufMessage(typeName?: string): any {
  return function (target: any, context?: any): any {
    const name =
      typeName ||
      (context && typeof context === 'object' && context.name
        ? String(context.name)
        : target.name || 'Message');

    const symMeta = (Symbol as any).metadata;
    const metadataFields =
      context?.metadata?.[PENDING_FIELDS_SYMBOL] ??
      (symMeta ? (target as any)[symMeta]?.[PENDING_FIELDS_SYMBOL] : undefined);

    if (metadataFields) {
      let map = classPendingFields.get(target);
      if (!map) {
        map = {};
        classPendingFields.set(target, map);
      }
      Object.assign(map, metadataFields);
    }

    (target as any).__omnibufTypeName = name;
    return target;
  };
}

/**
 * Explicitly binds a `MessageSchema<T>` to a class constructor.
 */
export function registerClassSchema<T extends object>(
  ctor: new (...args: any[]) => T,
  schema: MessageSchema<T>,
): void {
  classSchemaRegistry.set(ctor, schema);
  (ctor as any)[SCHEMA_SYMBOL] = schema;
}

/**
 * Retrieves or compiles the `MessageSchema<T>` for a decorated class constructor or instance.
 */
export function getClassSchema<T extends object>(
  ctorOrInstance: (new (...args: any[]) => T) | T,
): MessageSchema<T> | null {
  const ctor: any =
    typeof ctorOrInstance === 'function' ? ctorOrInstance : ctorOrInstance?.constructor;
  if (!ctor || ctor === Object) return null;

  const existing = classSchemaRegistry.get(ctor) ?? ctor[SCHEMA_SYMBOL];
  if (existing) return existing;

  // Trigger a dummy instantiation if Stage 3 addInitializer hasn't run yet
  if (!classPendingFields.has(ctor)) {
    try {
      new ctor();
    } catch {
      // ignore if constructor requires args
    }
  }

  const symMeta = (Symbol as any).metadata;
  const pending =
    classPendingFields.get(ctor) ?? (symMeta ? ctor[symMeta]?.[PENDING_FIELDS_SYMBOL] : undefined);
  if (!pending || Object.keys(pending).length === 0) {
    return null;
  }

  const name = ctor.__omnibufTypeName || ctor.name || 'Message';
  const schema = new MessageSchema<T>(name, pending, () => new ctor());
  classSchemaRegistry.set(ctor, schema);
  ctor[SCHEMA_SYMBOL] = schema;
  return schema;
}
