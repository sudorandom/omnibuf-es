import {
  ProtoScalarType,
  parseFieldDescriptorType,
  protoCamelCase,
  safeObjectProperty,
  type DescriptorProtoJSON,
  type EnumDescriptorProtoJSON,
  type FileDescriptorProtoJSON,
  type FileDescriptorSetJSON,
} from '@omnibuf/core';

export interface GeneratedFile {
  name: string;
  content: string;
}

function isRepeated(label: string | number | undefined): boolean {
  return label === 3 || label === 'LABEL_REPEATED';
}

function toPascalCase(snake: string): string {
  return snake
    .split('_')
    .map((p) => (p.length > 0 ? p[0]!.toUpperCase() + p.slice(1) : ''))
    .join('');
}

function posixRelativeImport(fromProto: string, toProto: string): string {
  const fromParts = fromProto.replace(/\\/g, '/').split('/');
  fromParts.pop();
  const toBase = toProto.replace(/\\/g, '/').replace(/\.proto$/, '') + '_omnibuf.pb.js';
  const toParts = toBase.split('/');

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  const upCount = fromParts.length - common;
  const relParts: string[] = [];
  for (let i = 0; i < upCount; i++) relParts.push('..');
  for (let i = common; i < toParts.length; i++) relParts.push(toParts[i]!);
  const rel = relParts.join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

interface MessageSymbolInfo {
  fullProtoName: string; // e.g. "pkg.Outer.Inner" (no leading dot)
  fileProtoName: string; // e.g. "dir/file.proto"
  exportName: string; // e.g. "Outer_Inner" in its defining file
  desc: DescriptorProtoJSON;
}

interface EnumSymbolInfo {
  fullProtoName: string;
  fileProtoName: string;
  exportName: string;
  desc: EnumDescriptorProtoJSON;
}

interface MapEntryInfo {
  keyType: number;
  valType: number;
  valTypeName?: string;
}

interface SymbolRegistry {
  messages: Map<string, MessageSymbolInfo>;
  enums: Map<string, EnumSymbolInfo>;
  mapEntries: Map<string, MapEntryInfo>;
}

function buildSymbolRegistry(files: FileDescriptorProtoJSON[]): SymbolRegistry {
  const messages = new Map<string, MessageSymbolInfo>();
  const enums = new Map<string, EnumSymbolInfo>();
  const mapEntries = new Map<string, MapEntryInfo>();

  for (const file of files) {
    const fileName = file.name ?? 'messages.proto';
    const pkg = file.package ?? '';
    const usedExportNames = new Set<string>();
    const allocateExportName = (base: string): string => {
      let candidate = base;
      let suffix = 1;
      while (usedExportNames.has(candidate)) {
        candidate = `${base}$${suffix++}`;
      }
      usedExportNames.add(candidate);
      return candidate;
    };

    for (const en of file.enumType ?? []) {
      const enName = en.name ?? 'Enum';
      const fullProtoName = pkg ? `${pkg}.${enName}` : enName;
      enums.set(fullProtoName, {
        fullProtoName,
        fileProtoName: fileName,
        exportName: allocateExportName(enName),
        desc: en,
      });
    }

    const visitMessage = (
      protoPrefix: string,
      tsPrefix: string,
      msg: DescriptorProtoJSON,
    ): void => {
      const msgName = msg.name ?? 'Message';
      const fullProtoName = protoPrefix ? `${protoPrefix}.${msgName}` : msgName;
      const rawExportName = tsPrefix ? `${tsPrefix}_${msgName}` : msgName;

      if (msg.options?.mapEntry) {
        const kf = (msg.field ?? []).find((x) => x.number === 1);
        const vf = (msg.field ?? []).find((x) => x.number === 2);
        mapEntries.set(fullProtoName, {
          keyType: parseFieldDescriptorType(kf?.type),
          valType: parseFieldDescriptorType(vf?.type),
          valTypeName: vf?.typeName,
        });
        return;
      }

      const exportName = allocateExportName(rawExportName);
      messages.set(fullProtoName, {
        fullProtoName,
        fileProtoName: fileName,
        exportName,
        desc: msg,
      });

      for (const en of msg.enumType ?? []) {
        const enName = en.name ?? 'Enum';
        const enFull = `${fullProtoName}.${enName}`;
        enums.set(enFull, {
          fullProtoName: enFull,
          fileProtoName: fileName,
          exportName: allocateExportName(`${exportName}_${enName}`),
          desc: en,
        });
      }

      for (const nested of msg.nestedType ?? []) {
        visitMessage(fullProtoName, exportName, nested);
      }
    };

    for (const msg of file.messageType ?? []) {
      visitMessage(pkg, '', msg);
    }
  }

  return { messages, enums, mapEntries };
}

function resolveCandidateName<T>(
  rawTypeName: string | undefined,
  enclosingFullProtoName: string,
  pkg: string,
  table: Map<string, T>,
): T | undefined {
  if (!rawTypeName) return undefined;
  if (rawTypeName.startsWith('.')) {
    const clean = rawTypeName.slice(1);
    return table.get(clean);
  }
  // Relative lookup from innermost enclosing message scope outward to package and root
  const parts = enclosingFullProtoName ? enclosingFullProtoName.split('.') : [];
  for (let i = parts.length; i >= 0; i--) {
    const scope = parts.slice(0, i).join('.');
    const candidate = scope ? `${scope}.${rawTypeName}` : rawTypeName;
    const hit = table.get(candidate);
    if (hit) return hit;
  }
  if (pkg) {
    const hit = table.get(`${pkg}.${rawTypeName}`);
    if (hit) return hit;
  }
  return table.get(rawTypeName);
}

interface ResolvedOneof {
  index: number;
  protoName: string;
  localName: string;
  emitProtoAlias: boolean;
  fields: ResolvedField[];
}

interface ResolvedField {
  number: number;
  name: string;
  localName: string;
  emitNameAlias: boolean;
  pascalName: string;
  storageProp: string;
  getterName: string;
  setterName: string;
  shorthandMethods: string[];
  type: number;
  repeated: boolean;
  isMap: boolean;
  mapKeyType: number;
  mapValType: number;
  subMsgSymbol?: string;
  mapValMsgSymbol?: string;
  enumSymbol?: string;
  oneofLocalName?: string;
  oneofProtoName?: string;
  explicitPresence: boolean;
}

function tsTypeForField(f: ResolvedField): string {
  if (f.isMap) {
    const valTs = tsTypeForField({
      ...f,
      isMap: false,
      repeated: false,
      type: f.mapValType,
      subMsgSymbol: f.mapValMsgSymbol,
      oneofLocalName: undefined,
      explicitPresence: false,
    }).replace(' | null', '');
    return `Record<string, ${valTs}>`;
  }
  let base = 'number';
  switch (f.type) {
    case ProtoScalarType.UINT64:
    case ProtoScalarType.INT64:
    case ProtoScalarType.SINT64:
    case ProtoScalarType.FIXED64:
    case ProtoScalarType.SFIXED64:
      base = '(number | bigint)';
      break;
    case ProtoScalarType.STRING:
      base = 'string';
      break;
    case ProtoScalarType.BOOL:
      base = 'boolean';
      break;
    case ProtoScalarType.BYTES:
      base = 'Uint8Array';
      break;
    case ProtoScalarType.ENUM:
      base = f.enumSymbol ?? 'number';
      break;
    case ProtoScalarType.MESSAGE:
      base = f.subMsgSymbol ?? 'Record<string, any>';
      break;
    default:
      base = 'number';
      break;
  }
  if (f.repeated) return `${base}[]`;
  if (f.type === ProtoScalarType.MESSAGE) {
    return f.oneofLocalName ? `${base} | null | undefined` : `${base} | null`;
  }
  if (f.explicitPresence || f.oneofLocalName) return `${base} | undefined`;
  return base;
}

function defaultValueExprForField(f: ResolvedField): string {
  if (f.isMap) return '{}';
  if (f.repeated) return '[]';
  if (f.explicitPresence) return 'undefined';
  switch (f.type) {
    case ProtoScalarType.STRING:
      return "''";
    case ProtoScalarType.BOOL:
      return 'false';
    case ProtoScalarType.BYTES:
      return 'new Uint8Array(0)';
    case ProtoScalarType.MESSAGE:
      return 'null';
    case ProtoScalarType.ENUM:
      return '0 as any';
    default:
      return '0';
  }
}

function schemaTypeString(f: { type: number; repeated: boolean; isMap: boolean }): string {
  if (f.isMap) return 'map';
  const suffix = f.repeated ? '[]' : '';
  switch (f.type) {
    case ProtoScalarType.UINT32:
      return `uint32${suffix}`;
    case ProtoScalarType.UINT64:
      return `uint64${suffix}`;
    case ProtoScalarType.INT32:
      return `int32${suffix}`;
    case ProtoScalarType.ENUM:
      return `enum${suffix}`;
    case ProtoScalarType.INT64:
      return `int64${suffix}`;
    case ProtoScalarType.SINT32:
      return `sint32${suffix}`;
    case ProtoScalarType.SINT64:
      return `sint64${suffix}`;
    case ProtoScalarType.FIXED32:
      return `fixed32${suffix}`;
    case ProtoScalarType.SFIXED32:
      return `sfixed32${suffix}`;
    case ProtoScalarType.FIXED64:
      return `fixed64${suffix}`;
    case ProtoScalarType.SFIXED64:
      return `sfixed64${suffix}`;
    case ProtoScalarType.FLOAT:
      return `float32${suffix}`;
    case ProtoScalarType.DOUBLE:
      return `float64${suffix}`;
    case ProtoScalarType.BOOL:
      return `bool${suffix}`;
    case ProtoScalarType.STRING:
      return `string${suffix}`;
    case ProtoScalarType.BYTES:
      return `bytes${suffix}`;
    case ProtoScalarType.MESSAGE:
      return `submsg${suffix}`;
    default:
      return `uint32${suffix}`;
  }
}

function mapWireType(type: number): number {
  switch (type) {
    case ProtoScalarType.STRING:
      return 3;
    case ProtoScalarType.BYTES:
      return 4;
    case ProtoScalarType.MESSAGE:
      return 5;
    case ProtoScalarType.FLOAT:
    case ProtoScalarType.FIXED32:
    case ProtoScalarType.SFIXED32:
      return 10;
    case ProtoScalarType.DOUBLE:
    case ProtoScalarType.FIXED64:
    case ProtoScalarType.SFIXED64:
      return 11;
    case ProtoScalarType.INT32:
    case ProtoScalarType.INT64:
    case ProtoScalarType.SINT32:
    case ProtoScalarType.SINT64:
      return 12;
    default:
      return 0;
  }
}

function emitMapPayload(type: number, subMsgSymbol: string | undefined, value: string): string {
  switch (type) {
    case ProtoScalarType.STRING:
      return `enc.writeRawStringPayload(${value});`;
    case ProtoScalarType.BYTES:
      return `enc.writeRawBytesPayload(${value});`;
    case ProtoScalarType.BOOL:
      return `enc.writeRawVarint(${value} === true || String(${value}) === 'true' ? 1 : 0);`;
    case ProtoScalarType.MESSAGE:
      return `enc.beginContainer(); if (${value}) encode${subMsgSymbol}(enc, ${value}, options); enc.endContainer();`;
    case ProtoScalarType.FLOAT:
      return `enc.writeRawFloat32(Number(${value}));`;
    case ProtoScalarType.DOUBLE:
      return `enc.writeRawFloat64(Number(${value}));`;
    case ProtoScalarType.FIXED32:
    case ProtoScalarType.SFIXED32:
      return `enc.writeRawFixed32(Number(${value}));`;
    case ProtoScalarType.FIXED64:
    case ProtoScalarType.SFIXED64:
      return `enc.writeRawFixed64(BigInt(${value}));`;
    case ProtoScalarType.INT32:
    case ProtoScalarType.INT64:
    case ProtoScalarType.SINT32:
    case ProtoScalarType.SINT64:
      return `enc.writeRawVarint(encodeZigZag(BigInt(${value})));`;
    case ProtoScalarType.UINT32:
    case ProtoScalarType.ENUM:
      return `enc.writeRawVarint(Number(${value}) >>> 0);`;
    default:
      return `enc.writeRawVarint(BigInt(${value}));`;
  }
}

function emitFieldValueAccess(f: ResolvedField, objExpr: string): string {
  if (f.oneofLocalName) {
    const g = `((${objExpr} as any).${f.oneofLocalName} ?? ${f.oneofProtoName && f.oneofProtoName !== f.oneofLocalName ? `(${objExpr} as any).${f.oneofProtoName}` : 'undefined'})`;
    return `((${g} && typeof ${g} === 'object' && 'case' in ${g}) ? ((${g}.case === ${JSON.stringify(f.localName)} || ${g}.case === ${JSON.stringify(f.name)}) ? (${g}.value as any) : undefined) : ((${objExpr} as any).${f.localName} ?? ${f.emitNameAlias ? `(${objExpr} as any).${f.name}` : 'undefined'}))`;
  }
  return f.emitNameAlias
    ? `(${objExpr}.${f.localName} ?? ${objExpr}.${f.name})`
    : `${objExpr}.${f.localName}`;
}

function emitEncodeField(f: ResolvedField, objExpr: string, indent: string): string {
  const rawAccess = emitFieldValueAccess(f, objExpr);

  if (f.oneofLocalName || f.explicitPresence) {
    const innerField: ResolvedField = {
      ...f,
      oneofLocalName: undefined,
      explicitPresence: false,
    };
    const innerCode = emitEncodeScalarOrSubMsgWithVar(innerField, '__v', `${indent}  `);
    return [
      `${indent}{`,
      `${indent}  const __v = ${rawAccess};`,
      `${indent}  if (__v !== undefined && __v !== null) {`,
      innerCode,
      `${indent}  }`,
      `${indent}}`,
    ].join('\n');
  }

  return emitEncodeScalarOrSubMsgWithVar(f, rawAccess, indent);
}

function emitEncodeScalarOrSubMsgWithVar(f: ResolvedField, val: string, indent: string): string {
  const num = f.number;
  if (f.isMap) {
    const kw = mapWireType(f.mapKeyType);
    const vw = mapWireType(f.mapValType);
    const sort =
      f.mapKeyType === ProtoScalarType.STRING
        ? 'a < b ? -1 : a > b ? 1 : 0'
        : f.mapKeyType === ProtoScalarType.BOOL
          ? 'Number(a === "true") - Number(b === "true")'
          : 'BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0';
    return [
      `${indent}{`,
      `${indent}  const entries = Object.entries(${val} ?? {});`,
      `${indent}  if (options?.deterministic) entries.sort(([a], [b]) => ${sort});`,
      `${indent}  enc.writeTag(${num}, 9); enc.beginContainer();`,
      `${indent}  enc.writeByte(${(kw << 4) | vw}); enc.writeRawVarint(entries.length);`,
      `${indent}  for (const [k, v] of entries) {`,
      `${indent}    ${emitMapPayload(f.mapKeyType, undefined, 'k')}`,
      `${indent}    ${emitMapPayload(f.mapValType, f.mapValMsgSymbol, 'v')}`,
      `${indent}  }`,
      `${indent}  enc.endContainer();`,
      `${indent}}`,
    ].join('\n');
  }
  if (f.repeated) {
    switch (f.type) {
      case ProtoScalarType.UINT32:
      case ProtoScalarType.ENUM:
        return `${indent}enc.writeUint32Arr(${num}, ${val} ?? []);`;
      case ProtoScalarType.UINT64:
        return `${indent}enc.writeUintArr(${num}, ${val} ?? []);`;
      case ProtoScalarType.INT32:
      case ProtoScalarType.INT64:
      case ProtoScalarType.SINT32:
      case ProtoScalarType.SINT64:
        return `${indent}enc.writeSintArr(${num}, ${val} ?? []);`;
      case ProtoScalarType.FIXED32:
      case ProtoScalarType.SFIXED32:
        return `${indent}enc.writeFixed32Arr(${num}, ${val} ?? []);`;
      case ProtoScalarType.FIXED64:
      case ProtoScalarType.SFIXED64:
        return `${indent}enc.writeFixed64Arr(${num}, ${val} ?? []);`;
      case ProtoScalarType.FLOAT:
        return `${indent}enc.writeFloat32Arr(${num}, ${val} ?? []);`;
      case ProtoScalarType.DOUBLE:
        return `${indent}enc.writeFloat64Arr(${num}, ${val} ?? []);`;
      case ProtoScalarType.BOOL:
        return `${indent}enc.writeBoolArr(${num}, ${val} ?? []);`;
      case ProtoScalarType.BYTES:
        return `${indent}enc.writeBytesArr(${num}, ${val} ?? []);`;
      case ProtoScalarType.STRING:
        return `${indent}enc.writeStringArr(${num}, ${val} ?? []);`;
      case ProtoScalarType.MESSAGE: {
        const sub = f.subMsgSymbol!;
        return [
          `${indent}{`,
          `${indent}  const arr = ${val} ?? [];`,
          `${indent}  enc.beginSubMsgArr(${num});`,
          `${indent}  for (let i = 0; i < arr.length; i++) {`,
          `${indent}    enc.beginSubMsgElem();`,
          `${indent}    encode${sub}(enc, arr[i]!, options);`,
          `${indent}    enc.endSubMsgElem();`,
          `${indent}  }`,
          `${indent}  enc.endSubMsgArr();`,
          `${indent}}`,
        ].join('\n');
      }
      default:
        return '';
    }
  }

  switch (f.type) {
    case ProtoScalarType.UINT32:
    case ProtoScalarType.ENUM:
      return `${indent}enc.writeUint(${num}, Number(${val} ?? 0) >>> 0);`;
    case ProtoScalarType.UINT64:
      return `${indent}enc.writeUint(${num}, ${val} ?? 0);`;
    case ProtoScalarType.INT32:
    case ProtoScalarType.INT64:
    case ProtoScalarType.SINT32:
    case ProtoScalarType.SINT64:
      return `${indent}enc.writeInt(${num}, ${val} ?? 0);`;
    case ProtoScalarType.FIXED32:
    case ProtoScalarType.SFIXED32:
      return `${indent}enc.writeFixed32(${num}, ${val} ?? 0);`;
    case ProtoScalarType.FIXED64:
    case ProtoScalarType.SFIXED64:
      return `${indent}enc.writeFixed64(${num}, ${val} ?? 0);`;
    case ProtoScalarType.FLOAT:
      return `${indent}enc.writeFloat32(${num}, ${val} ?? 0);`;
    case ProtoScalarType.DOUBLE:
      return `${indent}enc.writeFloat64(${num}, ${val} ?? 0);`;
    case ProtoScalarType.BOOL:
      return `${indent}enc.writeBool(${num}, Boolean(${val}));`;
    case ProtoScalarType.STRING:
      return `${indent}enc.writeString(${num}, ${val} ?? '');`;
    case ProtoScalarType.BYTES:
      return `${indent}enc.writeBytes(${num}, ${val} ?? new Uint8Array(0));`;
    case ProtoScalarType.MESSAGE: {
      const sub = f.subMsgSymbol!;
      return [
        `${indent}{`,
        `${indent}  const subVal = ${val};`,
        `${indent}  if (subVal !== null && subVal !== undefined) {`,
        `${indent}    enc.beginSubMsg(${num});`,
        `${indent}    encode${sub}(enc, subVal, options);`,
        `${indent}    enc.endSubMsg();`,
        `${indent}  }`,
        `${indent}}`,
      ].join('\n');
    }
    default:
      return '';
  }
}

function expectedWireTypeExpr(f: ResolvedField, wtVar: string): string {
  if (f.isMap) return `${wtVar} === 9`;
  if (f.repeated) {
    switch (f.type) {
      case ProtoScalarType.STRING:
      case ProtoScalarType.BYTES:
        return `${wtVar} === 6`;
      case ProtoScalarType.UINT32:
      case ProtoScalarType.UINT64:
      case ProtoScalarType.ENUM:
      case ProtoScalarType.BOOL:
        return `${wtVar} === 7`;
      case ProtoScalarType.INT32:
      case ProtoScalarType.INT64:
      case ProtoScalarType.SINT32:
      case ProtoScalarType.SINT64:
        return `${wtVar} === 13`;
      case ProtoScalarType.FLOAT:
      case ProtoScalarType.DOUBLE:
      case ProtoScalarType.FIXED32:
      case ProtoScalarType.SFIXED32:
      case ProtoScalarType.FIXED64:
      case ProtoScalarType.SFIXED64:
        return `${wtVar} === 14`;
      case ProtoScalarType.MESSAGE:
        return `${wtVar} === 8`;
      default:
        return `${wtVar} === 7`;
    }
  }
  switch (f.type) {
    case ProtoScalarType.UINT32:
    case ProtoScalarType.UINT64:
    case ProtoScalarType.ENUM:
      return `${wtVar} === 0`;
    case ProtoScalarType.INT32:
    case ProtoScalarType.INT64:
    case ProtoScalarType.SINT32:
    case ProtoScalarType.SINT64:
      return `${wtVar} === 12`;
    case ProtoScalarType.BOOL:
      return `(${wtVar} === 1 || ${wtVar} === 2)`;
    case ProtoScalarType.STRING:
      return `${wtVar} === 3`;
    case ProtoScalarType.BYTES:
      return `${wtVar} === 4`;
    case ProtoScalarType.MESSAGE:
      return `${wtVar} === 5`;
    case ProtoScalarType.FLOAT:
    case ProtoScalarType.FIXED32:
    case ProtoScalarType.SFIXED32:
      return `${wtVar} === 10`;
    case ProtoScalarType.DOUBLE:
    case ProtoScalarType.FIXED64:
    case ProtoScalarType.SFIXED64:
      return `${wtVar} === 11`;
    default:
      return `${wtVar} === 0`;
  }
}

function emitAssignDecodedField(f: ResolvedField, valExpr: string): string {
  if (f.oneofLocalName) {
    return `(out as any).${f.oneofLocalName} = { case: ${JSON.stringify(f.localName)}, value: ${valExpr} };`;
  }
  return `out.${f.localName} = ${valExpr};`;
}

function emitDecodeMapEntryInline(
  type: number,
  subMsgSymbol: string | undefined,
  wtVar: string,
  targetVar: string,
  indent: string,
): string {
  switch (type) {
    case ProtoScalarType.STRING:
      return [
        `${indent}if (${wtVar} !== 3) throw new Error('omnibuf: invalid map string wire type');`,
        `${indent}const [__s, __np] = readLenSlice(body, p, 0);`,
        `${indent}${targetVar} = decodeUTF8(__s); p = __np;`,
      ].join('\n');
    case ProtoScalarType.BYTES:
      return [
        `${indent}if (${wtVar} !== 4) throw new Error('omnibuf: invalid map bytes wire type');`,
        `${indent}const [__b, __np] = readLenSlice(body, p, 0);`,
        `${indent}${targetVar} = __b.slice(); p = __np;`,
      ].join('\n');
    case ProtoScalarType.BOOL:
      return [
        `${indent}if (${wtVar} !== 0) throw new Error('omnibuf: invalid map bool wire type');`,
        `${indent}const [__u, __un] = decodeVarintBigInt(body, p);`,
        `${indent}if (__un === 0) throw new Error('omnibuf: truncated map bool');`,
        `${indent}${targetVar} = __u !== 0n; p += __un;`,
      ].join('\n');
    case ProtoScalarType.UINT32:
      return [
        `${indent}if (${wtVar} !== 0) throw new Error('omnibuf: invalid map uint32 wire type');`,
        `${indent}const [__u, __un] = decodeVarintBigInt(body, p);`,
        `${indent}if (__un === 0) throw new Error('omnibuf: truncated map uint32');`,
        `${indent}${targetVar} = Number(__u & 0xffffffffn) >>> 0; p += __un;`,
      ].join('\n');
    case ProtoScalarType.ENUM:
      return [
        `${indent}if (${wtVar} !== 0) throw new Error('omnibuf: invalid map enum wire type');`,
        `${indent}const [__u, __un] = decodeVarintBigInt(body, p);`,
        `${indent}if (__un === 0) throw new Error('omnibuf: truncated map enum');`,
        `${indent}${targetVar} = Number(__u & 0xffffffffn) | 0; p += __un;`,
      ].join('\n');
    case ProtoScalarType.UINT64:
      return [
        `${indent}if (${wtVar} !== 0) throw new Error('omnibuf: invalid map uint64 wire type');`,
        `${indent}const [__u, __un] = decodeVarintAuto(body, p);`,
        `${indent}if (__un === 0) throw new Error('omnibuf: truncated map uint64');`,
        `${indent}${targetVar} = __u; p += __un;`,
      ].join('\n');
    case ProtoScalarType.INT32:
    case ProtoScalarType.SINT32:
      return [
        `${indent}if (${wtVar} !== 12) throw new Error('omnibuf: invalid map sint32 wire type');`,
        `${indent}const [__u, __un] = decodeVarintBigInt(body, p);`,
        `${indent}if (__un === 0) throw new Error('omnibuf: truncated map sint32');`,
        `${indent}${targetVar} = decodeZigZag(__u) | 0; p += __un;`,
      ].join('\n');
    case ProtoScalarType.INT64:
    case ProtoScalarType.SINT64:
      return [
        `${indent}if (${wtVar} !== 12) throw new Error('omnibuf: invalid map sint64 wire type');`,
        `${indent}const [__u, __un] = decodeVarintBigInt(body, p);`,
        `${indent}if (__un === 0) throw new Error('omnibuf: truncated map sint64');`,
        `${indent}${targetVar} = decodeZigZagAuto(__u); p += __un;`,
      ].join('\n');
    case ProtoScalarType.FLOAT:
      return [
        `${indent}if (${wtVar} !== 10 || body.length - p < 4) throw new Error('omnibuf: invalid map float32');`,
        `${indent}const __bits = (body[p]! | (body[p + 1]! << 8) | (body[p + 2]! << 16) | (body[p + 3]! << 24)) >>> 0;`,
        `${indent}${targetVar} = roundFloat32Shortest(float32FromBits(__bits)); p += 4;`,
      ].join('\n');
    case ProtoScalarType.FIXED32:
      return [
        `${indent}if (${wtVar} !== 10 || body.length - p < 4) throw new Error('omnibuf: invalid map fixed32');`,
        `${indent}${targetVar} = (body[p]! | (body[p + 1]! << 8) | (body[p + 2]! << 16) | (body[p + 3]! << 24)) >>> 0; p += 4;`,
      ].join('\n');
    case ProtoScalarType.SFIXED32:
      return [
        `${indent}if (${wtVar} !== 10 || body.length - p < 4) throw new Error('omnibuf: invalid map sfixed32');`,
        `${indent}${targetVar} = (body[p]! | (body[p + 1]! << 8) | (body[p + 2]! << 16) | (body[p + 3]! << 24)) | 0; p += 4;`,
      ].join('\n');
    case ProtoScalarType.DOUBLE:
      return [
        `${indent}if (${wtVar} !== 11 || body.length - p < 8) throw new Error('omnibuf: invalid map float64');`,
        `${indent}let __u64 = 0n; for (let b = 7; b >= 0; b--) __u64 = (__u64 << 8n) | BigInt(body[p + b]!);`,
        `${indent}${targetVar} = float64FromBits(__u64); p += 8;`,
      ].join('\n');
    case ProtoScalarType.FIXED64:
      return [
        `${indent}if (${wtVar} !== 11 || body.length - p < 8) throw new Error('omnibuf: invalid map fixed64');`,
        `${indent}let __u64 = 0n; for (let b = 7; b >= 0; b--) __u64 = (__u64 << 8n) | BigInt(body[p + b]!);`,
        `${indent}${targetVar} = __u64 <= 9007199254740991n ? Number(__u64) : __u64; p += 8;`,
      ].join('\n');
    case ProtoScalarType.SFIXED64:
      return [
        `${indent}if (${wtVar} !== 11 || body.length - p < 8) throw new Error('omnibuf: invalid map sfixed64');`,
        `${indent}let __u64 = 0n; for (let b = 7; b >= 0; b--) __u64 = (__u64 << 8n) | BigInt(body[p + b]!);`,
        `${indent}const __s64 = BigInt.asIntN(64, __u64);`,
        `${indent}${targetVar} = __s64 >= -9007199254740991n && __s64 <= 9007199254740991n ? Number(__s64) : __s64; p += 8;`,
      ].join('\n');
    case ProtoScalarType.MESSAGE:
      return [
        `${indent}if (${wtVar} !== 5) throw new Error('omnibuf: invalid map submsg wire type');`,
        `${indent}const [__sub, __np] = readLenSlice(body, p, 0);`,
        `${indent}${targetVar} = decode${subMsgSymbol}(__sub, undefined, depth + 1, options); p = __np;`,
      ].join('\n');
    default:
      return '';
  }
}

function emitDecodeFieldCaseBody(f: ResolvedField, indent: string): string {
  const prop = `out.${f.localName}`;
  if (f.isMap) {
    return [
      `${indent}const [body, nextPos] = readLenSlice(buf, pos, 2);`,
      `${indent}const mapType = body[0]!;`,
      `${indent}const keyWT = mapType >>> 4;`,
      `${indent}const valWT = mapType & 0x0f;`,
      `${indent}validateMapTypes(keyWT, valWT);`,
      `${indent}const [count, cn] = decodeVarintBigInt(body, 1);`,
      `${indent}if (cn === 0 || count * 2n > BigInt(body.length - (1 + cn))) throw new Error('omnibuf: invalid map count');`,
      `${indent}const dst: Record<string, any> = alreadySeen && ${prop} && typeof ${prop} === 'object' ? ${prop} : {};`,
      `${indent}let p = 1 + cn;`,
      `${indent}const c = Number(count);`,
      `${indent}for (let i = 0; i < c; i++) {`,
      `${indent}  let kVal: any;`,
      `${indent}  let vVal: any;`,
      `${indent}  {`,
      emitDecodeMapEntryInline(f.mapKeyType, undefined, 'keyWT', 'kVal', `${indent}    `),
      `${indent}  }`,
      `${indent}  {`,
      emitDecodeMapEntryInline(f.mapValType, f.mapValMsgSymbol, 'valWT', 'vVal', `${indent}    `),
      `${indent}  }`,
      `${indent}  Object.defineProperty(dst, String(kVal), { value: vVal, writable: true, enumerable: true, configurable: true });`,
      `${indent}}`,
      `${indent}if (p !== body.length) throw new Error('omnibuf: map trailing bytes');`,
      `${indent}${prop} = dst;`,
      `${indent}pos = nextPos;`,
    ].join('\n');
  }

  if (f.repeated) {
    switch (f.type) {
      case ProtoScalarType.STRING:
        return [
          `${indent}const [body, nextPos] = readLenSlice(buf, pos, 1);`,
          `${indent}const prev = alreadySeen && Array.isArray(${prop}) ? ${prop} : [];`,
          `${indent}const [arr, ok] = appendStringArrBody(prev, body);`,
          `${indent}if (!ok) throw new Error('omnibuf: invalid string array');`,
          `${indent}${prop} = arr; pos = nextPos;`,
        ].join('\n');
      case ProtoScalarType.BYTES:
        return [
          `${indent}const [body, nextPos] = readLenSlice(buf, pos, 1);`,
          `${indent}const prev = alreadySeen && Array.isArray(${prop}) ? ${prop} : [];`,
          `${indent}const [arr, ok] = appendBytesArrBody(prev, body, false);`,
          `${indent}if (!ok) throw new Error('omnibuf: invalid bytes array');`,
          `${indent}${prop} = arr; pos = nextPos;`,
        ].join('\n');
      case ProtoScalarType.BOOL:
        return [
          `${indent}const [body, nextPos] = readLenSlice(buf, pos, 1);`,
          `${indent}const prev = alreadySeen && Array.isArray(${prop}) ? ${prop} : [];`,
          `${indent}const [arr, ok] = appendBoolArrBody(prev, body);`,
          `${indent}if (!ok) throw new Error('omnibuf: invalid bool array');`,
          `${indent}${prop} = arr; pos = nextPos;`,
        ].join('\n');
      case ProtoScalarType.UINT32:
        return [
          `${indent}const [body, nextPos] = readLenSlice(buf, pos, 1);`,
          `${indent}const prev = alreadySeen && Array.isArray(${prop}) ? ${prop} : [];`,
          `${indent}const [arr, ok] = appendUint32ArrBody(prev, body);`,
          `${indent}if (!ok) throw new Error('omnibuf: invalid uint32 array');`,
          `${indent}${prop} = arr as any; pos = nextPos;`,
        ].join('\n');
      case ProtoScalarType.ENUM:
        return [
          `${indent}const [body, nextPos] = readLenSlice(buf, pos, 1);`,
          `${indent}const prev = alreadySeen && Array.isArray(${prop}) ? ${prop} : [];`,
          `${indent}const [arr, ok] = appendEnumArrBody(prev, body);`,
          `${indent}if (!ok) throw new Error('omnibuf: invalid enum array');`,
          `${indent}${prop} = arr as any; pos = nextPos;`,
        ].join('\n');
      case ProtoScalarType.UINT64:
        return [
          `${indent}const [body, nextPos] = readLenSlice(buf, pos, 1);`,
          `${indent}const prev = alreadySeen && Array.isArray(${prop}) ? ${prop} : [];`,
          `${indent}const [arr, ok] = appendUintArrAutoBody(prev, body);`,
          `${indent}if (!ok) throw new Error('omnibuf: invalid uint64 array');`,
          `${indent}${prop} = arr; pos = nextPos;`,
        ].join('\n');
      case ProtoScalarType.INT32:
      case ProtoScalarType.SINT32:
      case ProtoScalarType.INT64:
      case ProtoScalarType.SINT64:
        return [
          `${indent}const [body, nextPos] = readLenSlice(buf, pos, 1);`,
          `${indent}const prev = alreadySeen && Array.isArray(${prop}) ? ${prop} : [];`,
          `${indent}const [arr, ok] = appendSintArrAutoBody(prev, body);`,
          `${indent}if (!ok) throw new Error('omnibuf: invalid sint array');`,
          `${indent}${prop} = arr as any; pos = nextPos;`,
        ].join('\n');
      case ProtoScalarType.FLOAT:
        return [
          `${indent}const [body, nextPos] = readLenSlice(buf, pos, 1);`,
          `${indent}const prev = alreadySeen && Array.isArray(${prop}) ? ${prop} : [];`,
          `${indent}const [arr, ok] = appendFloat32ArrBody(prev, body);`,
          `${indent}if (!ok) throw new Error('omnibuf: invalid float32 array');`,
          `${indent}${prop} = arr.map(roundFloat32Shortest); pos = nextPos;`,
        ].join('\n');
      case ProtoScalarType.DOUBLE:
        return [
          `${indent}const [body, nextPos] = readLenSlice(buf, pos, 1);`,
          `${indent}const prev = alreadySeen && Array.isArray(${prop}) ? ${prop} : [];`,
          `${indent}const [arr, ok] = appendFloat64ArrBody(prev, body);`,
          `${indent}if (!ok) throw new Error('omnibuf: invalid float64 array');`,
          `${indent}${prop} = arr; pos = nextPos;`,
        ].join('\n');
      case ProtoScalarType.FIXED32:
      case ProtoScalarType.SFIXED32: {
        const castOp = f.type === ProtoScalarType.SFIXED32 ? '| 0' : '>>> 0';
        return [
          `${indent}const [body, nextPos] = readLenSlice(buf, pos, 1);`,
          `${indent}if (body.length < 1 || body[0] !== 10 || (body.length - 1) % 4 !== 0) throw new Error('omnibuf: invalid fixed32 array');`,
          `${indent}const prev = alreadySeen && Array.isArray(${prop}) ? ${prop} : [];`,
          `${indent}const c = (body.length - 1) / 4;`,
          `${indent}for (let i = 0; i < c; i++) {`,
          `${indent}  const off = 1 + i * 4;`,
          `${indent}  prev.push((body[off]! | (body[off + 1]! << 8) | (body[off + 2]! << 16) | (body[off + 3]! << 24)) ${castOp});`,
          `${indent}}`,
          `${indent}${prop} = prev; pos = nextPos;`,
        ].join('\n');
      }
      case ProtoScalarType.FIXED64:
      case ProtoScalarType.SFIXED64: {
        const isSigned = f.type === ProtoScalarType.SFIXED64;
        return [
          `${indent}const [body, nextPos] = readLenSlice(buf, pos, 1);`,
          `${indent}if (body.length < 1 || body[0] !== 11 || (body.length - 1) % 8 !== 0) throw new Error('omnibuf: invalid fixed64 array');`,
          `${indent}const prev = alreadySeen && Array.isArray(${prop}) ? ${prop} : [];`,
          `${indent}const c = (body.length - 1) / 8;`,
          `${indent}for (let i = 0; i < c; i++) {`,
          `${indent}  const off = 1 + i * 8;`,
          `${indent}  let u64 = 0n; for (let b = 7; b >= 0; b--) u64 = (u64 << 8n) | BigInt(body[off + b]!);`,
          isSigned
            ? `${indent}  const s64 = BigInt.asIntN(64, u64); prev.push(s64 >= -9007199254740991n && s64 <= 9007199254740991n ? Number(s64) : s64);`
            : `${indent}  prev.push(u64 <= 9007199254740991n ? Number(u64) : u64);`,
          `${indent}}`,
          `${indent}${prop} = prev; pos = nextPos;`,
        ].join('\n');
      }
      case ProtoScalarType.MESSAGE: {
        const sub = f.subMsgSymbol!;
        return [
          `${indent}const [arrPayload, nextPos] = readLenSlice(buf, pos, 0);`,
          `${indent}const [elemCount, ok] = countSubMsgArrElems(arrPayload);`,
          `${indent}if (!ok) throw new Error('omnibuf: corrupt submsg array');`,
          `${indent}const elems = alreadySeen && Array.isArray(${prop}) ? ${prop} : [];`,
          `${indent}let p = 0;`,
          `${indent}for (let i = 0; i < elemCount; i++) {`,
          `${indent}  const [el, en] = decodeVarintBigInt(arrPayload, p);`,
          `${indent}  p += en;`,
          `${indent}  const elNum = Number(el);`,
          `${indent}  elems.push(decode${sub}(arrPayload.subarray(p, p + elNum), undefined, depth + 1, options));`,
          `${indent}  p += elNum;`,
          `${indent}}`,
          `${indent}${prop} = elems; pos = nextPos;`,
        ].join('\n');
      }
      default:
        return '';
    }
  }

  switch (f.type) {
    case ProtoScalarType.UINT32:
      return [
        `${indent}const [v, vn] = decodeVarintBigInt(buf, pos);`,
        `${indent}if (vn === 0) throw new Error('omnibuf: truncated uint32');`,
        `${indent}${emitAssignDecodedField(f, '(Number(v & 0xffffffffn) >>> 0) as any')}`,
        `${indent}pos += vn;`,
      ].join('\n');
    case ProtoScalarType.ENUM:
      return [
        `${indent}const [v, vn] = decodeVarintBigInt(buf, pos);`,
        `${indent}if (vn === 0) throw new Error('omnibuf: truncated enum');`,
        `${indent}${emitAssignDecodedField(f, '(Number(v & 0xffffffffn) | 0) as any')}`,
        `${indent}pos += vn;`,
      ].join('\n');
    case ProtoScalarType.UINT64:
      return [
        `${indent}const [v, vn] = decodeVarintAuto(buf, pos);`,
        `${indent}if (vn === 0) throw new Error('omnibuf: truncated uint64');`,
        `${indent}${emitAssignDecodedField(f, 'v')}`,
        `${indent}pos += vn;`,
      ].join('\n');
    case ProtoScalarType.INT32:
    case ProtoScalarType.SINT32:
      return [
        `${indent}const [v, vn] = decodeVarintBigInt(buf, pos);`,
        `${indent}if (vn === 0) throw new Error('omnibuf: truncated int32');`,
        `${indent}${emitAssignDecodedField(f, 'decodeZigZag(v) | 0')}`,
        `${indent}pos += vn;`,
      ].join('\n');
    case ProtoScalarType.INT64:
    case ProtoScalarType.SINT64:
      return [
        `${indent}const [v, vn] = decodeVarintBigInt(buf, pos);`,
        `${indent}if (vn === 0) throw new Error('omnibuf: truncated int64');`,
        `${indent}${emitAssignDecodedField(f, 'decodeZigZagAuto(v)')}`,
        `${indent}pos += vn;`,
      ].join('\n');
    case ProtoScalarType.BOOL:
      return `${indent}${emitAssignDecodedField(f, 'wt === 2')}`;
    case ProtoScalarType.STRING:
      return [
        `${indent}const [s, nextPos] = readLenSlice(buf, pos, 0);`,
        `${indent}${emitAssignDecodedField(f, 'decodeUTF8(s)')}`,
        `${indent}pos = nextPos;`,
      ].join('\n');
    case ProtoScalarType.BYTES:
      return [
        `${indent}const [b, nextPos] = readLenSlice(buf, pos, 0);`,
        `${indent}${emitAssignDecodedField(f, 'b.slice()')}`,
        `${indent}pos = nextPos;`,
      ].join('\n');
    case ProtoScalarType.FLOAT:
      return [
        `${indent}if (n - pos < 4) throw new Error('omnibuf: truncated float32');`,
        `${indent}const bits = (buf[pos]! | (buf[pos + 1]! << 8) | (buf[pos + 2]! << 16) | (buf[pos + 3]! << 24)) >>> 0;`,
        `${indent}${emitAssignDecodedField(f, 'roundFloat32Shortest(float32FromBits(bits))')}`,
        `${indent}pos += 4;`,
      ].join('\n');
    case ProtoScalarType.FIXED32:
      return [
        `${indent}if (n - pos < 4) throw new Error('omnibuf: truncated fixed32');`,
        `${indent}const bits = (buf[pos]! | (buf[pos + 1]! << 8) | (buf[pos + 2]! << 16) | (buf[pos + 3]! << 24)) >>> 0;`,
        `${indent}${emitAssignDecodedField(f, 'bits')}`,
        `${indent}pos += 4;`,
      ].join('\n');
    case ProtoScalarType.SFIXED32:
      return [
        `${indent}if (n - pos < 4) throw new Error('omnibuf: truncated sfixed32');`,
        `${indent}const bits = (buf[pos]! | (buf[pos + 1]! << 8) | (buf[pos + 2]! << 16) | (buf[pos + 3]! << 24)) | 0;`,
        `${indent}${emitAssignDecodedField(f, 'bits')}`,
        `${indent}pos += 4;`,
      ].join('\n');
    case ProtoScalarType.DOUBLE:
      return [
        `${indent}if (n - pos < 8) throw new Error('omnibuf: truncated float64');`,
        `${indent}let u64 = 0n; for (let b = 7; b >= 0; b--) u64 = (u64 << 8n) | BigInt(buf[pos + b]!);`,
        `${indent}${emitAssignDecodedField(f, 'float64FromBits(u64)')}`,
        `${indent}pos += 8;`,
      ].join('\n');
    case ProtoScalarType.FIXED64:
      return [
        `${indent}if (n - pos < 8) throw new Error('omnibuf: truncated fixed64');`,
        `${indent}let u64 = 0n; for (let b = 7; b >= 0; b--) u64 = (u64 << 8n) | BigInt(buf[pos + b]!);`,
        `${indent}${emitAssignDecodedField(f, 'u64 <= 9007199254740991n ? Number(u64) : u64')}`,
        `${indent}pos += 8;`,
      ].join('\n');
    case ProtoScalarType.SFIXED64:
      return [
        `${indent}if (n - pos < 8) throw new Error('omnibuf: truncated sfixed64');`,
        `${indent}let u64 = 0n; for (let b = 7; b >= 0; b--) u64 = (u64 << 8n) | BigInt(buf[pos + b]!);`,
        `${indent}const s64 = BigInt.asIntN(64, u64);`,
        `${indent}${emitAssignDecodedField(f, 's64 >= -9007199254740991n && s64 <= 9007199254740991n ? Number(s64) : s64')}`,
        `${indent}pos += 8;`,
      ].join('\n');
    case ProtoScalarType.MESSAGE: {
      const sub = f.subMsgSymbol!;
      const existingExpr = f.oneofLocalName
        ? `((out as any).${f.oneofLocalName}?.case === ${JSON.stringify(f.localName)} ? (out as any).${f.oneofLocalName}.value : undefined)`
        : prop;
      const mergeExpr = f.oneofLocalName
        ? 'alreadySeen && existing !== undefined && existing !== null'
        : 'alreadySeen';
      return [
        `${indent}const [subBytes, nextPos] = readLenSlice(buf, pos, 0);`,
        `${indent}const existing = ${existingExpr};`,
        `${indent}const decodedSub = decode${sub}(subBytes, existing ?? undefined, depth + 1, { ...options, merge: ${mergeExpr} });`,
        `${indent}${emitAssignDecodedField(f, 'decodedSub')}`,
        `${indent}pos = nextPos;`,
      ].join('\n');
    }
    default:
      return '';
  }
}

function wireMaskForField(f: ResolvedField): number {
  switch (f.type) {
    case ProtoScalarType.UINT32:
    case ProtoScalarType.UINT64:
    case ProtoScalarType.ENUM:
      return 1 << 0;
    case ProtoScalarType.INT32:
    case ProtoScalarType.INT64:
    case ProtoScalarType.SINT32:
    case ProtoScalarType.SINT64:
      return 1 << 12;
    case ProtoScalarType.BOOL:
      return (1 << 1) | (1 << 2);
    case ProtoScalarType.STRING:
      return 1 << 3;
    case ProtoScalarType.BYTES:
      return 1 << 4;
    case ProtoScalarType.MESSAGE:
      return 1 << 5;
    case ProtoScalarType.FLOAT:
    case ProtoScalarType.FIXED32:
    case ProtoScalarType.SFIXED32:
      return 1 << 10;
    case ProtoScalarType.DOUBLE:
    case ProtoScalarType.FIXED64:
    case ProtoScalarType.SFIXED64:
      return 1 << 11;
    default:
      return 1 << 0;
  }
}

function emitOpaqueGetterBody(f: ResolvedField, oneof?: ResolvedOneof): string {
  const num = f.number;
  if (f.isMap) {
    const keyKind = schemaTypeString({ type: f.mapKeyType, repeated: false, isMap: false });
    const valKind = schemaTypeString({ type: f.mapValType, repeated: false, isMap: false });
    const subDecoder = f.mapValMsgSymbol ? `, (sub) => decode${f.mapValMsgSymbol}(sub)` : '';
    return `if (this.${f.storageProp} === undefined) { this.${f.storageProp} = readTypedMap(this._raw, ${num}, ${JSON.stringify(keyKind)}, ${JSON.stringify(valKind)}${subDecoder})[0]; } return this.${f.storageProp}!;`;
  }
  if (f.repeated) {
    let readExpr: string;
    switch (f.type) {
      case ProtoScalarType.STRING:
        readExpr = `readStringArr(this._raw, ${num})[0]`;
        break;
      case ProtoScalarType.BYTES:
        readExpr = `readBytesArr(this._raw, ${num})[0]`;
        break;
      case ProtoScalarType.BOOL:
        readExpr = `readBoolArr(this._raw, ${num})[0]`;
        break;
      case ProtoScalarType.UINT32:
        readExpr = `readUint32Arr(this._raw, ${num})[0] as any`;
        break;
      case ProtoScalarType.ENUM:
        readExpr = `readEnumArr(this._raw, ${num})[0] as any`;
        break;
      case ProtoScalarType.UINT64:
        readExpr = `readUintArr(this._raw, ${num})[0]`;
        break;
      case ProtoScalarType.SINT32:
      case ProtoScalarType.INT32:
        readExpr = `readSintArr(this._raw, ${num})[0] as number[]`;
        break;
      case ProtoScalarType.SINT64:
      case ProtoScalarType.INT64:
        readExpr = `readSintArr(this._raw, ${num})[0]`;
        break;
      case ProtoScalarType.FLOAT:
        readExpr = `readFloat32Arr(this._raw, ${num})[0].map(roundFloat32Shortest)`;
        break;
      case ProtoScalarType.DOUBLE:
        readExpr = `readFloat64Arr(this._raw, ${num})[0]`;
        break;
      case ProtoScalarType.FIXED32:
        readExpr = `readFixed32Arr(this._raw, ${num})[0]`;
        break;
      case ProtoScalarType.SFIXED32:
        readExpr = `readSfixed32Arr(this._raw, ${num})[0]`;
        break;
      case ProtoScalarType.FIXED64:
        readExpr = `readFixed64Arr(this._raw, ${num})[0]`;
        break;
      case ProtoScalarType.SFIXED64:
        readExpr = `readSfixed64Arr(this._raw, ${num})[0]`;
        break;
      case ProtoScalarType.MESSAGE:
        readExpr = `readSubMsgArrDecoded(this._raw, ${num}, (sub) => decode${f.subMsgSymbol}(sub))[0]`;
        break;
      default:
        readExpr = `[]`;
        break;
    }
    return `if (this.${f.storageProp} === undefined) { this.${f.storageProp} = ${readExpr}; } return this.${f.storageProp}!;`;
  }
  if (f.explicitPresence || f.oneofLocalName) {
    const srcExpr = oneof ? 'slice' : 'this._raw';
    const oneofPreamble = oneof
      ? `const slice = activeOneofSlice(this._raw, ${num}, [${oneof.fields.map((of) => `[${of.number}, ${wireMaskForField(of)}]`).join(', ')}]); if (!slice) return undefined; `
      : '';
    switch (f.type) {
      case ProtoScalarType.UINT32:
        return `${oneofPreamble}const [v, ok] = readUint(${srcExpr}, ${num}); return (ok ? v : undefined) as any;`;
      case ProtoScalarType.ENUM:
        return `${oneofPreamble}const [v, ok] = readEnum(${srcExpr}, ${num}); return (ok ? v : undefined) as any;`;
      case ProtoScalarType.UINT64:
        return `${oneofPreamble}const [v, ok] = readUintAuto(${srcExpr}, ${num}); return ok ? v : undefined;`;
      case ProtoScalarType.INT32:
      case ProtoScalarType.SINT32:
        return `${oneofPreamble}const [v, ok] = readInt(${srcExpr}, ${num}); return ok ? v : undefined;`;
      case ProtoScalarType.INT64:
      case ProtoScalarType.SINT64:
        return `${oneofPreamble}const [v, ok] = readIntAuto(${srcExpr}, ${num}); return ok ? v : undefined;`;
      case ProtoScalarType.BOOL:
        return `${oneofPreamble}const [v, ok] = readBool(${srcExpr}, ${num}); return ok ? v : undefined;`;
      case ProtoScalarType.STRING:
        return `${oneofPreamble}const [v, ok] = readString(${srcExpr}, ${num}); return ok ? v : undefined;`;
      case ProtoScalarType.BYTES:
        return `${oneofPreamble}const [v, ok] = readBytes(${srcExpr}, ${num}); return ok ? v : undefined;`;
      case ProtoScalarType.FIXED32:
        return `${oneofPreamble}const [v, ok] = readFixed32(${srcExpr}, ${num}); return ok ? v : undefined;`;
      case ProtoScalarType.SFIXED32:
        return `${oneofPreamble}const [v, ok] = readSfixed32(${srcExpr}, ${num}); return ok ? v : undefined;`;
      case ProtoScalarType.FLOAT:
        return `${oneofPreamble}const [v, ok] = readFloat32(${srcExpr}, ${num}); return ok ? roundFloat32Shortest(v) : undefined;`;
      case ProtoScalarType.FIXED64:
        return `${oneofPreamble}const [v, ok] = readFixed64Auto(${srcExpr}, ${num}); return ok ? v : undefined;`;
      case ProtoScalarType.SFIXED64:
        return `${oneofPreamble}const [v, ok] = readSfixed64Auto(${srcExpr}, ${num}); return ok ? v : undefined;`;
      case ProtoScalarType.DOUBLE:
        return `${oneofPreamble}const [v, ok] = readFloat64(${srcExpr}, ${num}); return ok ? v : undefined;`;
      case ProtoScalarType.MESSAGE:
        return `${oneofPreamble}const [v, ok] = readSubMsgMerged<${f.subMsgSymbol}>(${srcExpr}, ${num}, (sub, target, merge) => decode${f.subMsgSymbol}(sub, target, 0, { merge })); return ok ? v : undefined;`;
      default:
        return `return undefined as any;`;
    }
  }
  switch (f.type) {
    case ProtoScalarType.UINT32:
      return `return readUint(this._raw, ${num})[0] as any;`;
    case ProtoScalarType.ENUM:
      return `return readEnum(this._raw, ${num})[0] as any;`;
    case ProtoScalarType.UINT64:
      return `return readUintAuto(this._raw, ${num})[0];`;
    case ProtoScalarType.INT32:
    case ProtoScalarType.SINT32:
      return `return readInt(this._raw, ${num})[0];`;
    case ProtoScalarType.INT64:
    case ProtoScalarType.SINT64:
      return `return readIntAuto(this._raw, ${num})[0];`;
    case ProtoScalarType.BOOL:
      return `return readBool(this._raw, ${num})[0];`;
    case ProtoScalarType.STRING:
      return `return readString(this._raw, ${num})[0];`;
    case ProtoScalarType.BYTES:
      return `return readBytes(this._raw, ${num})[0];`;
    case ProtoScalarType.FIXED32:
      return `return readFixed32(this._raw, ${num})[0];`;
    case ProtoScalarType.SFIXED32:
      return `return readSfixed32(this._raw, ${num})[0];`;
    case ProtoScalarType.FLOAT:
      return `return roundFloat32Shortest(readFloat32(this._raw, ${num})[0]);`;
    case ProtoScalarType.FIXED64:
      return `return readFixed64Auto(this._raw, ${num})[0];`;
    case ProtoScalarType.SFIXED64:
      return `return readSfixed64Auto(this._raw, ${num})[0];`;
    case ProtoScalarType.DOUBLE:
      return `return readFloat64(this._raw, ${num})[0];`;
    case ProtoScalarType.MESSAGE:
      return `if (this.${f.storageProp} === undefined) { this.${f.storageProp} = readSubMsgMerged<${f.subMsgSymbol}>(this._raw, ${num}, (sub, target, merge) => decode${f.subMsgSymbol}(sub, target, 0, { merge }))[0]; } return this.${f.storageProp};`;
    default:
      return `return readUint(this._raw, ${num})[0];`;
  }
}

/**
 * Generate a TypeScript module (`*_omnibuf.pb.ts`) for a `FileDescriptorProtoJSON`.
 */
export function generateFileCode(
  file: FileDescriptorProtoJSON,
  allFiles?: FileDescriptorProtoJSON[],
): GeneratedFile {
  const fileName = file.name ?? 'messages.proto';
  const pkg = file.package ?? '';
  const registry = buildSymbolRegistry(allFiles ?? [file]);

  // Collect all enums and messages declared in THIS file in declaration order
  const localEnums: EnumSymbolInfo[] = [];
  const localMessages: MessageSymbolInfo[] = [];
  const localExportNames = new Set<string>([
    'Encoder',
    'MaxNestingDepth',
    'activeOneofSlice',
    'appendBoolArrBody',
    'appendBytesArrBody',
    'appendEnumArrBody',
    'appendFloat32ArrBody',
    'appendFloat64ArrBody',
    'appendSintArrAutoBody',
    'appendStringArrBody',
    'appendUint32ArrBody',
    'appendUintArrAutoBody',
    'countSubMsgArrElems',
    'decodeSchemaMeta',
    'decodeUTF8',
    'decodeVarintAuto',
    'decodeVarintBigInt',
    'decodeZigZag',
    'decodeZigZagAuto',
    'defineMessage',
    'encodeField0SchemaMeta',
    'encodeZigZag',
    'float32FromBits',
    'float64FromBits',
    'readBool',
    'readBoolArr',
    'readBytes',
    'readBytesArr',
    'readEnum',
    'readEnumArr',
    'readFixed32',
    'readFixed32Arr',
    'readFixed64Auto',
    'readFixed64Arr',
    'readFloat32',
    'readFloat32Arr',
    'readFloat64',
    'readFloat64Arr',
    'readInt',
    'readIntAuto',
    'readLenSlice',
    'readSfixed32',
    'readSfixed32Arr',
    'readSfixed64Auto',
    'readSfixed64Arr',
    'readSintArr',
    'readString',
    'readStringArr',
    'readSubMsgArrDecoded',
    'readSubMsgMerged',
    'readTypedMap',
    'readUint',
    'readUint32Arr',
    'readUintArr',
    'readUintAuto',
    'roundFloat32Shortest',
    'spliceFields',
    'validateMapTypes',
    'validateValue',
    'writeField0SchemaMeta',
    'BinaryReadOptions',
    'MarshalOptions',
    'Message',
    'MessageInitShape',
    'MessageSchema',
    'UnknownField',
  ]);

  const registerMessageExports = (exportName: string): void => {
    localExportNames.add(exportName);
    localExportNames.add(`${exportName}Msg`);
    localExportNames.add(`${exportName}Schema`);
    localExportNames.add(`create${exportName}`);
    localExportNames.add(`encode${exportName}`);
    localExportNames.add(`marshal${exportName}OmniBuf`);
    localExportNames.add(`decode${exportName}`);
    localExportNames.add(`unmarshal${exportName}OmniBuf`);
    localExportNames.add(`Opaque${exportName}`);
  };

  for (const en of file.enumType ?? []) {
    const enName = en.name ?? 'Enum';
    const fullProtoName = pkg ? `${pkg}.${enName}` : enName;
    const info = registry.enums.get(fullProtoName);
    if (info) {
      localEnums.push(info);
      localExportNames.add(info.exportName);
    }
  }

  const collectLocalMessages = (protoPrefix: string, msg: DescriptorProtoJSON): void => {
    const msgName = msg.name ?? 'Message';
    const fullProtoName = protoPrefix ? `${protoPrefix}.${msgName}` : msgName;
    if (msg.options?.mapEntry) return;
    const info = registry.messages.get(fullProtoName);
    if (info) {
      localMessages.push(info);
      registerMessageExports(info.exportName);
    }
    for (const en of msg.enumType ?? []) {
      const enFull = `${fullProtoName}.${en.name ?? 'Enum'}`;
      const enInfo = registry.enums.get(enFull);
      if (enInfo) {
        localEnums.push(enInfo);
        localExportNames.add(enInfo.exportName);
      }
    }
    for (const nested of msg.nestedType ?? []) {
      collectLocalMessages(fullProtoName, nested);
    }
  };

  for (const msg of file.messageType ?? []) {
    collectLocalMessages(pkg, msg);
  }

  // Track external imports by fileProtoName -> Map<originalExport, localAlias>
  const externalImports = new Map<string, Map<string, string>>();

  const hasImportedMessageCollision = (candidate: string): boolean =>
    localExportNames.has(candidate) ||
    localExportNames.has(`${candidate}Schema`) ||
    localExportNames.has(`encode${candidate}`) ||
    localExportNames.has(`decode${candidate}`);

  const ensureImportedSymbol = (
    targetFile: string,
    exportName: string,
    fullProtoName: string,
    isMessage: boolean,
  ): string => {
    if (targetFile === fileName) {
      return exportName;
    }
    let fileImports = externalImports.get(targetFile);
    if (!fileImports) {
      fileImports = new Map<string, string>();
      externalImports.set(targetFile, fileImports);
    }
    const existingAlias = fileImports.get(exportName);
    if (existingAlias) return existingAlias;

    let alias = exportName;
    if (isMessage ? hasImportedMessageCollision(alias) : localExportNames.has(alias)) {
      alias = fullProtoName.replace(/\./g, '_');
    }
    while (isMessage ? hasImportedMessageCollision(alias) : localExportNames.has(alias)) {
      alias = `${alias}$`;
    }
    localExportNames.add(alias);
    fileImports.set(exportName, alias);
    if (isMessage) {
      localExportNames.add(`${alias}Schema`);
      localExportNames.add(`encode${alias}`);
      localExportNames.add(`decode${alias}`);
      fileImports.set(`${exportName}Schema`, `${alias}Schema`);
      fileImports.set(`encode${exportName}`, `encode${alias}`);
      fileImports.set(`decode${exportName}`, `decode${alias}`);
    }
    return alias;
  };

  const resolveMessageSymbol = (
    rawTypeName: string | undefined,
    enclosingFullProtoName: string,
  ): string => {
    const info = resolveCandidateName(rawTypeName, enclosingFullProtoName, pkg, registry.messages);
    if (!info) {
      const clean = (rawTypeName ?? 'unknown').replace(/^\./, '');
      const parts = clean.split('.');
      return parts[parts.length - 1] || clean;
    }
    return ensureImportedSymbol(info.fileProtoName, info.exportName, info.fullProtoName, true);
  };

  const resolveEnumSymbol = (
    rawTypeName: string | undefined,
    enclosingFullProtoName: string,
  ): string | undefined => {
    const info = resolveCandidateName(rawTypeName, enclosingFullProtoName, pkg, registry.enums);
    if (!info) return undefined;
    return ensureImportedSymbol(info.fileProtoName, info.exportName, info.fullProtoName, false);
  };

  // Pre-resolve fields and oneofs for all local messages so imports are populated first
  const resolvedByMessage = new Map<string, { fields: ResolvedField[]; oneofs: ResolvedOneof[] }>();

  for (const msgInfo of localMessages) {
    const msg = msgInfo.desc;
    const fullProtoName = msgInfo.fullProtoName;
    const fields: ResolvedField[] = [];
    const oneofsMap = new Map<number, ResolvedOneof>();
    const usedInterfaceProps = new Set<string>([
      '$typeName',
      '$unknown',
      'constructor',
      'toString',
      'toJSON',
      'valueOf',
    ]);

    // Pre-allocate real oneof group names first so fields cannot collide with their enclosing oneof property
    for (let idx = 0; idx < (msg.oneofDecl ?? []).length; idx++) {
      const decl = msg.oneofDecl![idx]!;
      const isSyntheticOptional = (msg.field ?? []).some(
        (fld) => fld.oneofIndex === idx && fld.proto3Optional,
      );
      if (isSyntheticOptional || !decl.name) continue;
      const protoName = decl.name;
      let localName = safeObjectProperty(protoCamelCase(protoName));
      while (usedInterfaceProps.has(localName)) {
        localName = `${localName}$`;
      }
      usedInterfaceProps.add(localName);
      oneofsMap.set(idx, {
        index: idx,
        protoName,
        localName,
        emitProtoAlias: false,
        fields: [],
      });
    }

    for (const f of msg.field ?? []) {
      const num = f.number ?? 0;
      const name = f.name ?? `field_${num}`;
      let localName = safeObjectProperty(protoCamelCase(name));
      while (usedInterfaceProps.has(localName)) {
        localName = `${localName}$`;
      }
      usedInterfaceProps.add(localName);

      const type = parseFieldDescriptorType(f.type);
      const rep = isRepeated(f.label);

      const mapEntry =
        type === ProtoScalarType.MESSAGE
          ? resolveCandidateName(f.typeName, fullProtoName, pkg, registry.mapEntries)
          : undefined;

      const oneofGroup =
        f.oneofIndex !== undefined && !f.proto3Optional ? oneofsMap.get(f.oneofIndex) : undefined;
      const oneofProtoName = oneofGroup?.protoName;
      const oneofLocalName = oneofGroup?.localName;
      const explicitPresence = !oneofLocalName && Boolean(f.proto3Optional);

      let rf: ResolvedField;
      if (type === ProtoScalarType.MESSAGE && mapEntry) {
        rf = {
          number: num,
          name,
          localName,
          emitNameAlias: false,
          pascalName: toPascalCase(name),
          storageProp: '',
          getterName: '',
          setterName: '',
          shorthandMethods: [],
          type,
          repeated: false,
          isMap: true,
          mapKeyType: mapEntry.keyType,
          mapValType: mapEntry.valType,
          mapValMsgSymbol:
            mapEntry.valType === ProtoScalarType.MESSAGE
              ? resolveMessageSymbol(mapEntry.valTypeName, fullProtoName)
              : undefined,
          explicitPresence: false,
        };
      } else {
        rf = {
          number: num,
          name,
          localName,
          emitNameAlias: false,
          pascalName: toPascalCase(name),
          storageProp: '',
          getterName: '',
          setterName: '',
          shorthandMethods: [],
          type,
          repeated: rep,
          isMap: false,
          mapKeyType: ProtoScalarType.STRING,
          mapValType: ProtoScalarType.UINT64,
          subMsgSymbol:
            type === ProtoScalarType.MESSAGE
              ? resolveMessageSymbol(f.typeName, fullProtoName)
              : undefined,
          enumSymbol:
            type === ProtoScalarType.ENUM
              ? resolveEnumSymbol(f.typeName, fullProtoName)
              : undefined,
          oneofLocalName,
          oneofProtoName,
          explicitPresence,
        };
      }

      if (oneofGroup) {
        oneofGroup.fields.push(rf);
      }

      fields.push(rf);
    }

    fields.sort((a, b) => a.number - b.number);

    // Allocate optional snake_case aliases on the interface only if they don't collide
    for (const oneof of oneofsMap.values()) {
      if (oneof.protoName !== oneof.localName && !usedInterfaceProps.has(oneof.protoName)) {
        oneof.emitProtoAlias = true;
        usedInterfaceProps.add(oneof.protoName);
      }
    }
    for (const f of fields) {
      if (f.name !== f.localName && !usedInterfaceProps.has(f.name)) {
        f.emitNameAlias = true;
        usedInterfaceProps.add(f.name);
      }
    }

    // Allocate Opaque<Message> member names (storage, getX/setX, and non-colliding shorthand methods)
    const usedOpaqueMembers = new Set<string>([
      'constructor',
      '_raw',
      '_dirtyMask',
      'raw',
      'marshal',
      'toString',
      'toJSON',
      'valueOf',
    ]);

    for (const f of fields) {
      let storageProp = `_${f.localName}`;
      while (usedOpaqueMembers.has(storageProp)) {
        storageProp = `${storageProp}$`;
      }
      usedOpaqueMembers.add(storageProp);
      f.storageProp = storageProp;

      let getterName = `get${f.pascalName}`;
      let setterName = `set${f.pascalName}`;
      while (usedOpaqueMembers.has(getterName) || usedOpaqueMembers.has(setterName)) {
        getterName = `${getterName}$`;
        setterName = `${setterName}$`;
      }
      usedOpaqueMembers.add(getterName);
      usedOpaqueMembers.add(setterName);
      f.getterName = getterName;
      f.setterName = setterName;
    }

    for (const f of fields) {
      if (!usedOpaqueMembers.has(f.localName)) {
        usedOpaqueMembers.add(f.localName);
        f.shorthandMethods.push(f.localName);
      }
      if (f.name !== f.localName && !usedOpaqueMembers.has(f.name)) {
        usedOpaqueMembers.add(f.name);
        f.shorthandMethods.push(f.name);
      }
    }

    resolvedByMessage.set(msgInfo.exportName, {
      fields,
      oneofs: Array.from(oneofsMap.values()).filter((o) => o.fields.length > 0),
    });
  }

  const lines: string[] = [];
  lines.push('// Code generated by protoc-gen-omnibuf-es. DO NOT EDIT.');
  lines.push(`// source: ${fileName}`);
  lines.push('');
  lines.push('import {');
  lines.push('  Encoder,');
  lines.push('  MaxNestingDepth,');
  lines.push('  activeOneofSlice,');
  lines.push('  appendBoolArrBody,');
  lines.push('  appendBytesArrBody,');
  lines.push('  appendEnumArrBody,');
  lines.push('  appendFloat32ArrBody,');
  lines.push('  appendFloat64ArrBody,');
  lines.push('  appendSintArrAutoBody,');
  lines.push('  appendStringArrBody,');
  lines.push('  appendUint32ArrBody,');
  lines.push('  appendUintArrAutoBody,');
  lines.push('  countSubMsgArrElems,');
  lines.push('  decodeSchemaMeta,');
  lines.push('  decodeUTF8,');
  lines.push('  decodeVarintAuto,');
  lines.push('  decodeVarintBigInt,');
  lines.push('  decodeZigZag,');
  lines.push('  decodeZigZagAuto,');
  lines.push('  defineMessage,');
  lines.push('  encodeField0SchemaMeta,');
  lines.push('  encodeZigZag,');
  lines.push('  float32FromBits,');
  lines.push('  float64FromBits,');
  lines.push('  readBool,');
  lines.push('  readBoolArr,');
  lines.push('  readBytes,');
  lines.push('  readBytesArr,');
  lines.push('  readEnum,');
  lines.push('  readEnumArr,');
  lines.push('  readFixed32,');
  lines.push('  readFixed32Arr,');
  lines.push('  readFixed64Auto,');
  lines.push('  readFixed64Arr,');
  lines.push('  readFloat32,');
  lines.push('  readFloat32Arr,');
  lines.push('  readFloat64,');
  lines.push('  readFloat64Arr,');
  lines.push('  readInt,');
  lines.push('  readIntAuto,');
  lines.push('  readLenSlice,');
  lines.push('  readSfixed32,');
  lines.push('  readSfixed32Arr,');
  lines.push('  readSfixed64Auto,');
  lines.push('  readSfixed64Arr,');
  lines.push('  readSintArr,');
  lines.push('  readString,');
  lines.push('  readStringArr,');
  lines.push('  readSubMsgArrDecoded,');
  lines.push('  readSubMsgMerged,');
  lines.push('  readTypedMap,');
  lines.push('  readUint,');
  lines.push('  readUint32Arr,');
  lines.push('  readUintArr,');
  lines.push('  readUintAuto,');
  lines.push('  roundFloat32Shortest,');
  lines.push('  spliceFields,');
  lines.push('  validateMapTypes,');
  lines.push('  validateValue,');
  lines.push('  writeField0SchemaMeta,');
  lines.push('  type BinaryReadOptions,');
  lines.push('  type MarshalOptions,');
  lines.push('  type Message,');
  lines.push('  type MessageInitShape,');
  lines.push('  type MessageSchema,');
  lines.push('  type UnknownField,');
  lines.push("} from '@omnibuf/core';");

  for (const [depFile, specMap] of externalImports.entries()) {
    const specs: string[] = [];
    for (const [orig, alias] of specMap.entries()) {
      specs.push(orig === alias ? orig : `${orig} as ${alias}`);
    }
    const importPath = posixRelativeImport(fileName, depFile);
    lines.push(`import { ${specs.join(', ')} } from ${JSON.stringify(importPath)};`);
  }
  lines.push('');

  // Emit Enums
  for (const enInfo of localEnums) {
    lines.push(`export enum ${enInfo.exportName} {`);
    for (const val of enInfo.desc.value ?? []) {
      if (val.name !== undefined && val.number !== undefined) {
        lines.push(`  ${val.name} = ${val.number},`);
      }
    }
    lines.push('}');
    lines.push('');
  }

  // Emit Messages
  for (const msgInfo of localMessages) {
    const msgName = msgInfo.exportName;
    const fullTypeName = msgInfo.fullProtoName;
    const { fields, oneofs } = resolvedByMessage.get(msgName)!;
    const oneofByLocalName = new Map<string, ResolvedOneof>();
    for (const oneof of oneofs) {
      oneofByLocalName.set(oneof.localName, oneof);
    }
    const maxField = fields.reduce((acc, f) => Math.max(acc, f.number), 0);

    // 1. Interface (extending protobuf-es Message<FullTypeName>)
    lines.push(`export interface ${msgName} extends Message<${JSON.stringify(fullTypeName)}> {`);
    for (const oneof of oneofs) {
      const variants = oneof.fields.map(
        (f) =>
          `{ case: ${JSON.stringify(f.localName)}; value: ${tsTypeForField({ ...f, oneofLocalName: undefined, explicitPresence: false }).replace(' | null', '')} }`,
      );
      variants.push('{ case: undefined; value?: undefined }');
      lines.push(`  ${oneof.localName}: ${variants.join(' | ')};`);
      if (oneof.emitProtoAlias) {
        lines.push(`  ${oneof.protoName}?: ${variants.join(' | ')};`);
      }
    }
    for (const f of fields) {
      if (f.oneofLocalName) {
        lines.push(`  ${f.localName}?: ${tsTypeForField(f)};`);
        if (f.emitNameAlias) {
          lines.push(`  ${f.name}?: ${tsTypeForField(f)};`);
        }
      } else {
        const optMod = f.explicitPresence ? '?' : '';
        lines.push(`  ${f.localName}${optMod}: ${tsTypeForField(f)};`);
        if (f.emitNameAlias) {
          lines.push(`  ${f.name}?: ${tsTypeForField(f)};`);
        }
      }
    }
    lines.push('}');
    lines.push('');

    // 2. Compiled MessageSchema
    lines.push(
      `export const ${msgName}Schema: MessageSchema<${msgName}, ${JSON.stringify(fullTypeName)}> = defineMessage<${msgName}, ${JSON.stringify(fullTypeName)}>(`,
    );
    lines.push(`  ${JSON.stringify(fullTypeName)},`);
    lines.push('  {');
    for (const f of fields) {
      const st = schemaTypeString(f);
      const nameProp = f.localName !== f.name ? `, name: ${JSON.stringify(f.name)}` : '';
      const oneofProp = f.oneofLocalName
        ? `, oneof: ${JSON.stringify(f.oneofLocalName)}, oneofProtoName: ${JSON.stringify(f.oneofProtoName)}`
        : '';
      const presenceProp = f.explicitPresence ? ', explicitPresence: true' : '';
      if (f.isMap) {
        const key = schemaTypeString({ type: f.mapKeyType, repeated: false, isMap: false });
        const value = schemaTypeString({ type: f.mapValType, repeated: false, isMap: false });
        const sub = f.mapValMsgSymbol ? `, subSchema: () => ${f.mapValMsgSymbol}Schema` : '';
        lines.push(
          `    ${f.localName}: { fieldNum: ${f.number}${nameProp}, type: 'map', mapKey: '${key}', mapVal: '${value}'${sub} },`,
        );
      } else if (f.subMsgSymbol) {
        lines.push(
          `    ${f.localName}: { fieldNum: ${f.number}${nameProp}${oneofProp}${presenceProp}, type: '${st}', subSchema: () => ${f.subMsgSymbol}Schema },`,
        );
      } else {
        lines.push(
          `    ${f.localName}: { fieldNum: ${f.number}${nameProp}${oneofProp}${presenceProp}, type: '${st}' },`,
        );
      }
    }
    lines.push('  }');
    lines.push(');');
    lines.push('');

    // 2b. Hidden-Class Message Implementation
    lines.push(`class ${msgName}Msg implements ${msgName} {`);
    lines.push(`  declare $typeName: ${JSON.stringify(fullTypeName)};`);
    for (const oneof of oneofs) {
      const variants = oneof.fields.map(
        (f) =>
          `{ case: ${JSON.stringify(f.localName)}; value: ${tsTypeForField({ ...f, oneofLocalName: undefined, explicitPresence: false }).replace(' | null', '')} }`,
      );
      variants.push('{ case: undefined; value?: undefined }');
      const unionTs = variants.join(' | ');
      lines.push(`  ${oneof.localName}: ${unionTs} = { case: undefined };`);
      if (oneof.emitProtoAlias) {
        lines.push(`  get ${oneof.protoName}(): ${unionTs} { return this.${oneof.localName}; }`);
        lines.push(
          `  set ${oneof.protoName}(v: ${unionTs} | undefined) { this.${oneof.localName} = v ?? { case: undefined }; }`,
        );
      }
    }
    for (const f of fields) {
      if (f.oneofLocalName) {
        const caseCheck =
          f.name !== f.localName
            ? `g?.case === ${JSON.stringify(f.localName)} || g?.case === ${JSON.stringify(f.name)}`
            : `g?.case === ${JSON.stringify(f.localName)}`;
        lines.push(
          `  get ${f.localName}(): ${tsTypeForField(f)} { const g = this.${f.oneofLocalName} as any; return (${caseCheck}) ? g.value : undefined; }`,
        );
        lines.push(
          `  set ${f.localName}(v: ${tsTypeForField(f)}) { if (v === undefined || v === null) { const g = this.${f.oneofLocalName} as any; if (${caseCheck}) this.${f.oneofLocalName} = { case: undefined }; } else { this.${f.oneofLocalName} = { case: ${JSON.stringify(f.localName)}, value: v as any }; } }`,
        );
        if (f.emitNameAlias) {
          lines.push(`  get ${f.name}(): ${tsTypeForField(f)} { return this.${f.localName}; }`);
          lines.push(`  set ${f.name}(v: ${tsTypeForField(f)}) { this.${f.localName} = v; }`);
        }
      } else {
        lines.push(`  ${f.localName}: ${tsTypeForField(f)} = ${defaultValueExprForField(f)};`);
        if (f.emitNameAlias) {
          lines.push(`  get ${f.name}(): ${tsTypeForField(f)} { return this.${f.localName}; }`);
          lines.push(
            `  set ${f.name}(v: ${tsTypeForField(f)} | undefined) { this.${f.localName} = v as any; }`,
          );
        }
      }
    }
    lines.push('}');
    lines.push(
      `Object.defineProperty(${msgName}Msg.prototype, '$typeName', { value: ${JSON.stringify(fullTypeName)}, enumerable: false, writable: true, configurable: true });`,
    );
    lines.push('');

    // 3. Factory
    lines.push(
      `export function create${msgName}(init?: MessageInitShape<typeof ${msgName}Schema>): ${msgName} {`,
    );
    lines.push(`  if (init === undefined) return new ${msgName}Msg();`);
    lines.push(`  return ${msgName}Schema.create(init);`);
    lines.push('}');
    lines.push('');

    // 4. Single-pass Encoder
    lines.push(
      `export function encode${msgName}(enc: Encoder, msg: Partial<${msgName}>, options?: MarshalOptions): void {`,
    );
    for (const f of fields) {
      lines.push(emitEncodeField(f, 'msg', '  '));
    }
    lines.push('  if (options?.writeUnknownFields && Array.isArray((msg as any).$unknown)) {');
    lines.push('    for (const uf of (msg as any).$unknown as UnknownField[]) {');
    lines.push('      enc.writeTag(uf.no, uf.wireType);');
    lines.push('      enc.writeRaw(uf.data);');
    lines.push('    }');
    lines.push('  }');
    lines.push('}');
    lines.push('');

    lines.push(
      `export function marshal${msgName}OmniBuf(msg: Partial<${msgName}>, options?: MarshalOptions): Uint8Array {`,
    );
    lines.push('  const enc = new Encoder(256);');
    lines.push('  if (options?.selfDescribing) {');
    lines.push(
      `    writeField0SchemaMeta(enc, ${msgName}Schema.getSchemaMeta(0, msg as Record<string, any>), Boolean(options.deterministic));`,
    );
    lines.push('  }');
    lines.push(`  encode${msgName}(enc, msg, options);`);
    lines.push('  return enc.finish();');
    lines.push('}');
    lines.push('');

    // 5. Reflection-Free Specialized Decoder
    const use32Mask = maxField <= 30;
    lines.push(
      `export function decode${msgName}(buf: Uint8Array, target?: ${msgName}, depth = 0, options?: BinaryReadOptions, startPos = 0, endPos = buf.length): ${msgName} {`,
    );
    lines.push('  const maxDepth = options?.recursionLimit ?? MaxNestingDepth;');
    lines.push('  const readUnknown = options?.readUnknownFields ?? true;');
    lines.push('  if (depth > maxDepth) {');
    lines.push(
      '    throw new Error(`omnibuf: nesting depth ${depth} exceeds MaxNestingDepth (${maxDepth})`);',
    );
    lines.push('  }');
    lines.push('  if (endPos < buf.length) buf = buf.subarray(0, endPos);');
    lines.push(`  const out: ${msgName} = target ?? new ${msgName}Msg();`);
    lines.push('  const n = endPos;');
    lines.push('  let pos = startPos;');
    if (use32Mask) {
      lines.push('  let seenMask = 0;');
    } else {
      lines.push('  let seenMask = 0;');
      lines.push('  let seenSet: Set<number> | null = null;');
    }
    lines.push(
      '  let unknownFields: UnknownField[] | null = Array.isArray((out as any).$unknown) ? (out as any).$unknown : null;',
    );
    lines.push('  while (pos < n) {');
    lines.push('    let tag = 0;');
    lines.push('    const b0 = buf[pos]!;');
    lines.push('    if ((b0 & 1) !== 0) {');
    lines.push('      tag = b0 >>> 1;');
    lines.push('      pos += 1;');
    lines.push('    } else if ((b0 & 2) !== 0) {');
    lines.push("      if (pos + 2 > n) throw new Error('omnibuf: truncated tag');");
    lines.push('      tag = ((b0 | (buf[pos + 1]! << 8)) >>> 2) >>> 0;');
    lines.push('      pos += 2;');
    lines.push('    } else {');
    lines.push('      const [t64, tn] = decodeVarintBigInt(buf, pos);');
    lines.push(
      "      if (tn === 0 || t64 >> 4n > 0xffffffffn) throw new Error('omnibuf: invalid tag');",
    );
    lines.push('      tag = Number(t64);');
    lines.push('      pos += tn;');
    lines.push('    }');
    lines.push('    const fieldNum = tag <= 0x7fffffff ? tag >>> 4 : Math.floor(tag / 16);');
    lines.push('    const wt = tag & 0x0f;');
    lines.push('    if (fieldNum === 0) {');
    lines.push("      if (wt !== 5) throw new Error('omnibuf: invalid Field #0 wire type');");
    lines.push('      const [meta, nextPos] = readLenSlice(buf, pos, 0);');
    lines.push('      decodeSchemaMeta(meta, depth + 1, maxDepth);');
    lines.push('      pos = nextPos;');
    lines.push('      continue;');
    lines.push('    }');
    lines.push('    const bit = fieldNum <= 30 ? 1 << fieldNum : 0;');
    if (use32Mask) {
      lines.push('    const alreadySeen = (seenMask & bit) !== 0 || Boolean(options?.merge);');
    } else {
      lines.push(
        '    const alreadySeen = (bit !== 0 ? (seenMask & bit) !== 0 : seenSet !== null && seenSet.has(fieldNum)) || Boolean(options?.merge);',
      );
    }
    lines.push('    switch (fieldNum) {');
    for (const f of fields) {
      lines.push(`      case ${f.number}: {`);
      lines.push(`        if (!(${expectedWireTypeExpr(f, 'wt')})) {`);
      lines.push('          const valStart = pos;');
      lines.push('          pos = validateValue(buf, pos, wt, depth, maxDepth);');
      lines.push('          if (readUnknown) {');
      lines.push('            if (!unknownFields) unknownFields = [];');
      lines.push(
        '            unknownFields.push({ no: fieldNum, wireType: wt, data: buf.subarray(valStart, pos).slice() });',
      );
      lines.push('          }');
      lines.push('          break;');
      lines.push('        }');
      if (f.number <= 30) {
        lines.push('        seenMask |= bit;');
      } else {
        lines.push('        if (!seenSet) seenSet = new Set<number>();');
        lines.push('        seenSet.add(fieldNum);');
      }
      lines.push(emitDecodeFieldCaseBody(f, '        '));
      lines.push('        break;');
      lines.push('      }');
    }
    lines.push('      default: {');
    lines.push('        const valStart = pos;');
    lines.push('        pos = validateValue(buf, pos, wt, depth, maxDepth);');
    lines.push('        if (readUnknown) {');
    lines.push('          if (!unknownFields) unknownFields = [];');
    lines.push(
      '          unknownFields.push({ no: fieldNum, wireType: wt, data: buf.subarray(valStart, pos).slice() });',
    );
    lines.push('        }');
    lines.push('        break;');
    lines.push('      }');
    lines.push('    }');
    lines.push('  }');
    lines.push("  if (unknownFields && unknownFields.length > 0 && !('$unknown' in out)) {");
    lines.push(
      "    Object.defineProperty(out, '$unknown', { value: unknownFields, enumerable: false, writable: true, configurable: true });",
    );
    lines.push('  }');
    lines.push('  return out;');
    lines.push('}');
    lines.push('');

    lines.push(
      `export function unmarshal${msgName}OmniBuf(buf: Uint8Array, options?: BinaryReadOptions): ${msgName} {`,
    );
    lines.push(`  return decode${msgName}(buf, undefined, 0, options);`);
    lines.push('}');
    lines.push('');
    lines.push(`${msgName}Schema.setGeneratedCodec({`);
    lines.push(`  create: () => new ${msgName}Msg(),`);
    lines.push(`  encode: encode${msgName},`);
    lines.push(`  decode: decode${msgName},`);
    lines.push('});');
    lines.push('');

    // 6. Lazy Opaque<Message> View with dirty bitmask & spliceFields
    const zeroMask = use32Mask ? '0' : '0n';
    lines.push(`export class Opaque${msgName} {`);
    lines.push('  private _raw: Uint8Array;');
    lines.push(`  private _dirtyMask = ${zeroMask};`);
    for (const f of fields) {
      lines.push(`  private ${f.storageProp}?: ${tsTypeForField(f)};`);
    }
    lines.push('');
    lines.push('  constructor(raw: Uint8Array) {');
    lines.push('    this._raw = raw;');
    lines.push('  }');
    lines.push('');
    lines.push('  raw(): Uint8Array {');
    lines.push('    return this._raw;');
    lines.push('  }');
    lines.push('');

    for (const f of fields) {
      const bit = use32Mask ? `1 << ${f.number}` : `1n << ${f.number}n`;
      const oneofGroup = f.oneofLocalName ? oneofByLocalName.get(f.oneofLocalName) : undefined;
      const dirtyMaskExpr = oneofGroup
        ? oneofGroup.fields
            .map((of) => (use32Mask ? `(1 << ${of.number})` : `(1n << ${of.number}n)`))
            .join(' | ')
        : bit;

      lines.push(`  ${f.getterName}(): ${tsTypeForField(f)} {`);
      lines.push(`    if ((this._dirtyMask & (${bit})) !== ${zeroMask}) {`);
      lines.push(`      return this.${f.storageProp}!;`);
      lines.push('    }');
      lines.push(`    ${emitOpaqueGetterBody(f, oneofGroup)}`);
      lines.push('  }');
      lines.push('');

      for (const shorthand of f.shorthandMethods) {
        lines.push(`  ${shorthand}(): ${tsTypeForField(f)} {`);
        lines.push(`    return this.${f.getterName}();`);
        lines.push('  }');
        lines.push('');
      }

      lines.push(`  ${f.setterName}(val: ${tsTypeForField(f)}): void {`);
      if (oneofGroup) {
        for (const ofld of oneofGroup.fields) {
          if (ofld.number !== f.number) {
            lines.push(`    this.${ofld.storageProp} = undefined;`);
          }
        }
      }
      lines.push(`    this.${f.storageProp} = val;`);
      lines.push(`    this._dirtyMask |= (${dirtyMaskExpr});`);
      lines.push('  }');
      lines.push('');
    }

    lines.push('  marshal(options?: MarshalOptions): Uint8Array {');
    lines.push(`    if (this._dirtyMask !== ${zeroMask}) {`);
    lines.push(
      `      this._raw = spliceFields(this._raw, this._dirtyMask, ${maxField}, (enc, fnum) => {`,
    );
    lines.push('        switch (fnum) {');
    for (const f of fields) {
      lines.push(`          case ${f.number}: {`);
      lines.push(
        `            const msg = { ${f.localName}: this.${f.storageProp}! } as Partial<${msgName}>;`,
      );
      lines.push(emitEncodeField(f, 'msg', '            '));
      lines.push('            break;');
      lines.push('          }');
    }
    lines.push('        }');
    lines.push('      });');
    lines.push(`      this._dirtyMask = ${zeroMask};`);
    lines.push('    }');
    lines.push(
      '    if (options?.selfDescribing && (this._raw.length === 0 || this._raw[0] !== 0x0b)) {',
    );
    lines.push(
      `      const f0 = encodeField0SchemaMeta(${msgName}Schema.getSchemaMeta(0), Boolean(options.deterministic));`,
    );
    lines.push('      const out = new Uint8Array(f0.length + this._raw.length);');
    lines.push('      out.set(f0, 0);');
    lines.push('      out.set(this._raw, f0.length);');
    lines.push('      return out;');
    lines.push('    }');
    lines.push('    return this._raw;');
    lines.push('  }');
    lines.push('}');
    lines.push('');
  }

  const baseName = fileName.replace(/\.proto$/, '');
  return {
    name: `${baseName}_omnibuf.pb.ts`,
    content: lines.join('\n'),
  };
}

/**
 * Generate TypeScript files for all files in a `FileDescriptorSetJSON`.
 */
export function generateFromDescriptorSet(fds: FileDescriptorSetJSON): GeneratedFile[] {
  const allFiles = fds.file ?? [];
  const out: GeneratedFile[] = [];
  for (const file of allFiles) {
    out.push(generateFileCode(file, allFiles));
  }
  return out;
}
