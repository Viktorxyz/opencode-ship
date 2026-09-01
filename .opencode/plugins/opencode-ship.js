// opencode-ship v1.1.7
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/state/durable-store.js
var durable_store_exports = {};
__export(durable_store_exports, {
  atomicReplaceJson: () => atomicReplaceJson,
  publishImmutableJson: () => publishImmutableJson,
  tryHardLink: () => tryHardLink,
  updateSnapshotCas: () => updateSnapshotCas,
  withResourceLock: () => withResourceLock
});
import {
  open as fsOpen,
  writeFile as writeFile2,
  readFile as readFile2,
  rename as rename2,
  link,
  mkdir as mkdir2,
  readdir,
  unlink,
  stat
} from "node:fs/promises";
import { existsSync as existsSync2 } from "node:fs";
import { dirname as dirname2, join as join3, resolve as resolve4 } from "node:path";
import { createHash as createHash2, randomBytes } from "node:crypto";
import { hostname as osHostname } from "node:os";
function randomToken() {
  return randomBytes(8).toString("hex");
}
function ensureString(value) {
  return JSON.stringify(value, null, 2) + "\n";
}
async function fsyncDir(path) {
  try {
    const handle = await fsOpen(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
  }
}
async function atomicReplaceJson(path, value) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("atomicReplaceJson: path must be a non-empty string");
  }
  const target = resolve4(path);
  const parent = dirname2(target);
  await mkdir2(parent, { recursive: true });
  const tmp = `${target}.${randomToken()}.tmp`;
  const handle = await fsOpen(tmp, "w", 384);
  try {
    await handle.writeFile(ensureString(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename2(tmp, target);
  await fsyncDir(parent);
}
async function publishImmutableJson(path, value) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("publishImmutableJson: path must be a non-empty string");
  }
  const target = resolve4(path);
  const parent = dirname2(target);
  await mkdir2(parent, { recursive: true });
  if (existsSync2(target)) {
    throw new Error(`publishImmutableJson: target already exists: ${target}`);
  }
  const tmp = `${target}.${randomToken()}.immutable.tmp`;
  const handle = await fsOpen(tmp, "w", 384);
  try {
    await handle.writeFile(ensureString(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const attempt = await tryHardLink(tmp, target);
  if (attempt === "exists") {
    await unlink(tmp).catch(() => null);
    throw new Error(`publishImmutableJson: target already exists: ${target}`);
  }
  if (attempt === "linked") {
    await unlink(tmp).catch(() => null);
  } else {
    try {
      await rename2(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => null);
      if (err && err.code === "EEXIST") {
        throw new Error(`publishImmutableJson: target already exists: ${target}`);
      }
      throw err;
    }
  }
  await fsyncDir(parent);
}
async function tryHardLink(src, dst) {
  try {
    await link(src, dst);
    return "linked";
  } catch (err) {
    if (err && err.code === "EEXIST") return "exists";
    if (err && (err.code === "ENOTSUP" || err.code === "EPERM" || err.code === "ENOSYS" || err.code === "EOPNOTSUPP" || err.code === "EXDEV")) {
      return "fallback";
    }
    throw err;
  }
}
async function withResourceLock(stateDir, resourceKey, input) {
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new Error("withResourceLock: stateDir must be a non-empty string");
  }
  if (typeof resourceKey !== "string" || resourceKey.length === 0) {
    throw new Error("withResourceLock: resourceKey must be a non-empty string");
  }
  const callback = typeof input === "function" ? input : input?.callback;
  const options = typeof input === "function" ? {} : input?.options ?? {};
  if (typeof callback !== "function") {
    throw new Error("withResourceLock: callback must be a function");
  }
  const acquireMode = options.acquire ?? "wait";
  const waitMs = Number.isInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : 30 * 1e3;
  const pollMs = Number.isInteger(options.pollMs) && options.pollMs > 0 ? options.pollMs : 25;
  const keyHash = createHash2("sha256").update(resourceKey).digest("hex");
  const lockDir = join3(stateDir, "locks", keyHash);
  const ownerPath = join3(lockDir, "owner.json");
  await mkdir2(stateDir, { recursive: true });
  const deadline = Date.now() + waitMs;
  let acquired = false;
  let quarantinedThisAcquire = false;
  while (!acquired) {
    try {
      await mkdir2(lockDir, { recursive: true });
      const handle = await fsOpen(ownerPath, "wx", 384);
      try {
        const owner = {
          pid: process.pid,
          hostname: osHostname(),
          resource: resourceKey,
          startedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        await handle.writeFile(JSON.stringify(owner, null, 2) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        const claimed = await maybeQuarantineStaleLock(lockDir, ownerPath, resourceKey);
        if (claimed) {
          quarantinedThisAcquire = true;
          continue;
        }
        if (acquireMode === "try") {
          throw new Error(`withResourceLock: resource is busy: ${resourceKey}`);
        }
        if (Date.now() >= deadline) {
          throw new Error(`withResourceLock: timed out waiting for ${resourceKey}`);
        }
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      throw err;
    }
  }
  try {
    return await callback();
  } finally {
    await unlink(ownerPath).catch(() => null);
    if (!quarantinedThisAcquire) {
      await unlink(lockDir).catch(() => null);
    }
  }
}
async function maybeQuarantineStaleLock(lockDir, ownerPath, resourceKey) {
  let raw;
  try {
    raw = await readFile2(ownerPath, "utf8");
  } catch {
    return false;
  }
  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!owner || typeof owner !== "object") return false;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  if (typeof owner.startedAt !== "string") return false;
  const start = Date.parse(owner.startedAt);
  if (!Number.isFinite(start)) return false;
  if (Date.now() - start < STALE_LOCK_MS) return false;
  if (owner.hostname !== osHostname()) return false;
  let alive = true;
  try {
    process.kill(owner.pid, 0);
  } catch (e) {
    alive = e?.code === "EPERM";
  }
  if (alive) return false;
  const stamp = new Date(start).toISOString().replace(/[:.]/g, "-");
  const quarantinePath = join3(lockDir, `stale-${stamp}-${resourceKey.replace(/[^A-Za-z0-9._-]+/g, "_")}.owner.json`);
  try {
    await rename2(ownerPath, quarantinePath);
  } catch {
    return false;
  }
  return "quarantined";
}
async function updateSnapshotCas(path, expectedGeneration, reducer, options = {}) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("updateSnapshotCas: path must be a non-empty string");
  }
  if (!Number.isInteger(expectedGeneration) || expectedGeneration < 0) {
    throw new Error("updateSnapshotCas: expectedGeneration must be a non-negative integer");
  }
  if (typeof reducer !== "function") {
    throw new Error("updateSnapshotCas: reducer must be a function");
  }
  const target = resolve4(path);
  const stateDir = typeof options.stateDir === "string" && options.stateDir.length > 0 ? options.stateDir : dirname2(target);
  const lockKey = `cas:${target}`;
  return withResourceLock(stateDir, lockKey, {
    callback: async () => {
      const parent = dirname2(target);
      await mkdir2(parent, { recursive: true });
      let current = null;
      let currentGeneration = 0;
      if (existsSync2(target)) {
        try {
          const raw = await readFile2(target, "utf8");
          const parsed = JSON.parse(raw);
          current = parsed?.value;
          currentGeneration = Number.isInteger(parsed?.generation) ? parsed.generation : 0;
        } catch (err) {
          throw new Error(`updateSnapshotCas: cannot read existing snapshot: ${err?.message ?? err}`);
        }
      }
      if (currentGeneration !== expectedGeneration) {
        throw new Error(
          `updateSnapshotCas: stale generation (expected ${expectedGeneration}, found ${currentGeneration})`
        );
      }
      const nextValue = reducer(current);
      const next = { generation: expectedGeneration + 1, value: nextValue };
      const tmp = `${target}.${randomToken()}.tmp`;
      const handle = await fsOpen(tmp, "w", 384);
      try {
        await handle.writeFile(JSON.stringify(next, null, 2) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename2(tmp, target);
      await fsyncDir(parent);
      if (existsSync2(tmp)) {
        await unlink(tmp).catch(() => null);
      }
      return next;
    },
    options: { waitMs: options.waitMs }
  });
}
var STALE_LOCK_MS;
var init_durable_store = __esm({
  "src/state/durable-store.js"() {
    STALE_LOCK_MS = 120 * 1e3;
  }
});

// node_modules/zod/v4/classic/external.js
var external_exports = {};
__export(external_exports, {
  $brand: () => $brand,
  $input: () => $input,
  $output: () => $output,
  NEVER: () => NEVER,
  TimePrecision: () => TimePrecision,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBase64: () => ZodBase64,
  ZodBase64URL: () => ZodBase64URL,
  ZodBigInt: () => ZodBigInt,
  ZodBigIntFormat: () => ZodBigIntFormat,
  ZodBoolean: () => ZodBoolean,
  ZodCIDRv4: () => ZodCIDRv4,
  ZodCIDRv6: () => ZodCIDRv6,
  ZodCUID: () => ZodCUID,
  ZodCUID2: () => ZodCUID2,
  ZodCatch: () => ZodCatch,
  ZodCodec: () => ZodCodec,
  ZodCustom: () => ZodCustom,
  ZodCustomStringFormat: () => ZodCustomStringFormat,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodE164: () => ZodE164,
  ZodEmail: () => ZodEmail,
  ZodEmoji: () => ZodEmoji,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFile: () => ZodFile,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodGUID: () => ZodGUID,
  ZodIPv4: () => ZodIPv4,
  ZodIPv6: () => ZodIPv6,
  ZodISODate: () => ZodISODate,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODuration: () => ZodISODuration,
  ZodISOTime: () => ZodISOTime,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodJWT: () => ZodJWT,
  ZodKSUID: () => ZodKSUID,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNanoID: () => ZodNanoID,
  ZodNever: () => ZodNever,
  ZodNonOptional: () => ZodNonOptional,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodNumberFormat: () => ZodNumberFormat,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodPipe: () => ZodPipe,
  ZodPrefault: () => ZodPrefault,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRealError: () => ZodRealError,
  ZodRecord: () => ZodRecord,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodStringFormat: () => ZodStringFormat,
  ZodSuccess: () => ZodSuccess,
  ZodSymbol: () => ZodSymbol,
  ZodTemplateLiteral: () => ZodTemplateLiteral,
  ZodTransform: () => ZodTransform,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodULID: () => ZodULID,
  ZodURL: () => ZodURL,
  ZodUUID: () => ZodUUID,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  ZodXID: () => ZodXID,
  _ZodString: () => _ZodString,
  _default: () => _default2,
  _function: () => _function,
  any: () => any,
  array: () => array,
  base64: () => base642,
  base64url: () => base64url2,
  bigint: () => bigint2,
  boolean: () => boolean2,
  catch: () => _catch2,
  check: () => check,
  cidrv4: () => cidrv42,
  cidrv6: () => cidrv62,
  clone: () => clone,
  codec: () => codec,
  coerce: () => coerce_exports,
  config: () => config,
  core: () => core_exports2,
  cuid: () => cuid3,
  cuid2: () => cuid22,
  custom: () => custom,
  date: () => date3,
  decode: () => decode2,
  decodeAsync: () => decodeAsync2,
  discriminatedUnion: () => discriminatedUnion,
  e164: () => e1642,
  email: () => email2,
  emoji: () => emoji2,
  encode: () => encode2,
  encodeAsync: () => encodeAsync2,
  endsWith: () => _endsWith,
  enum: () => _enum2,
  file: () => file,
  flattenError: () => flattenError,
  float32: () => float32,
  float64: () => float64,
  formatError: () => formatError,
  function: () => _function,
  getErrorMap: () => getErrorMap,
  globalRegistry: () => globalRegistry,
  gt: () => _gt,
  gte: () => _gte,
  guid: () => guid2,
  hash: () => hash,
  hex: () => hex2,
  hostname: () => hostname2,
  httpUrl: () => httpUrl,
  includes: () => _includes,
  instanceof: () => _instanceof,
  int: () => int,
  int32: () => int32,
  int64: () => int64,
  intersection: () => intersection,
  ipv4: () => ipv42,
  ipv6: () => ipv62,
  iso: () => iso_exports,
  json: () => json,
  jwt: () => jwt,
  keyof: () => keyof,
  ksuid: () => ksuid2,
  lazy: () => lazy,
  length: () => _length,
  literal: () => literal,
  locales: () => locales_exports,
  looseObject: () => looseObject,
  lowercase: () => _lowercase,
  lt: () => _lt,
  lte: () => _lte,
  map: () => map,
  maxLength: () => _maxLength,
  maxSize: () => _maxSize,
  mime: () => _mime,
  minLength: () => _minLength,
  minSize: () => _minSize,
  multipleOf: () => _multipleOf,
  nan: () => nan,
  nanoid: () => nanoid2,
  nativeEnum: () => nativeEnum,
  negative: () => _negative,
  never: () => never,
  nonnegative: () => _nonnegative,
  nonoptional: () => nonoptional,
  nonpositive: () => _nonpositive,
  normalize: () => _normalize,
  null: () => _null3,
  nullable: () => nullable,
  nullish: () => nullish2,
  number: () => number2,
  object: () => object,
  optional: () => optional,
  overwrite: () => _overwrite,
  parse: () => parse2,
  parseAsync: () => parseAsync2,
  partialRecord: () => partialRecord,
  pipe: () => pipe,
  positive: () => _positive,
  prefault: () => prefault,
  preprocess: () => preprocess,
  prettifyError: () => prettifyError,
  promise: () => promise,
  property: () => _property,
  readonly: () => readonly,
  record: () => record,
  refine: () => refine,
  regex: () => _regex,
  regexes: () => regexes_exports,
  registry: () => registry,
  safeDecode: () => safeDecode2,
  safeDecodeAsync: () => safeDecodeAsync2,
  safeEncode: () => safeEncode2,
  safeEncodeAsync: () => safeEncodeAsync2,
  safeParse: () => safeParse2,
  safeParseAsync: () => safeParseAsync2,
  set: () => set,
  setErrorMap: () => setErrorMap,
  size: () => _size,
  startsWith: () => _startsWith,
  strictObject: () => strictObject,
  string: () => string2,
  stringFormat: () => stringFormat,
  stringbool: () => stringbool,
  success: () => success,
  superRefine: () => superRefine,
  symbol: () => symbol,
  templateLiteral: () => templateLiteral,
  toJSONSchema: () => toJSONSchema,
  toLowerCase: () => _toLowerCase,
  toUpperCase: () => _toUpperCase,
  transform: () => transform,
  treeifyError: () => treeifyError,
  trim: () => _trim,
  tuple: () => tuple,
  uint32: () => uint32,
  uint64: () => uint64,
  ulid: () => ulid2,
  undefined: () => _undefined3,
  union: () => union,
  unknown: () => unknown,
  uppercase: () => _uppercase,
  url: () => url,
  util: () => util_exports,
  uuid: () => uuid2,
  uuidv4: () => uuidv4,
  uuidv6: () => uuidv6,
  uuidv7: () => uuidv7,
  void: () => _void2,
  xid: () => xid2
});

// node_modules/zod/v4/core/index.js
var core_exports2 = {};
__export(core_exports2, {
  $ZodAny: () => $ZodAny,
  $ZodArray: () => $ZodArray,
  $ZodAsyncError: () => $ZodAsyncError,
  $ZodBase64: () => $ZodBase64,
  $ZodBase64URL: () => $ZodBase64URL,
  $ZodBigInt: () => $ZodBigInt,
  $ZodBigIntFormat: () => $ZodBigIntFormat,
  $ZodBoolean: () => $ZodBoolean,
  $ZodCIDRv4: () => $ZodCIDRv4,
  $ZodCIDRv6: () => $ZodCIDRv6,
  $ZodCUID: () => $ZodCUID,
  $ZodCUID2: () => $ZodCUID2,
  $ZodCatch: () => $ZodCatch,
  $ZodCheck: () => $ZodCheck,
  $ZodCheckBigIntFormat: () => $ZodCheckBigIntFormat,
  $ZodCheckEndsWith: () => $ZodCheckEndsWith,
  $ZodCheckGreaterThan: () => $ZodCheckGreaterThan,
  $ZodCheckIncludes: () => $ZodCheckIncludes,
  $ZodCheckLengthEquals: () => $ZodCheckLengthEquals,
  $ZodCheckLessThan: () => $ZodCheckLessThan,
  $ZodCheckLowerCase: () => $ZodCheckLowerCase,
  $ZodCheckMaxLength: () => $ZodCheckMaxLength,
  $ZodCheckMaxSize: () => $ZodCheckMaxSize,
  $ZodCheckMimeType: () => $ZodCheckMimeType,
  $ZodCheckMinLength: () => $ZodCheckMinLength,
  $ZodCheckMinSize: () => $ZodCheckMinSize,
  $ZodCheckMultipleOf: () => $ZodCheckMultipleOf,
  $ZodCheckNumberFormat: () => $ZodCheckNumberFormat,
  $ZodCheckOverwrite: () => $ZodCheckOverwrite,
  $ZodCheckProperty: () => $ZodCheckProperty,
  $ZodCheckRegex: () => $ZodCheckRegex,
  $ZodCheckSizeEquals: () => $ZodCheckSizeEquals,
  $ZodCheckStartsWith: () => $ZodCheckStartsWith,
  $ZodCheckStringFormat: () => $ZodCheckStringFormat,
  $ZodCheckUpperCase: () => $ZodCheckUpperCase,
  $ZodCodec: () => $ZodCodec,
  $ZodCustom: () => $ZodCustom,
  $ZodCustomStringFormat: () => $ZodCustomStringFormat,
  $ZodDate: () => $ZodDate,
  $ZodDefault: () => $ZodDefault,
  $ZodDiscriminatedUnion: () => $ZodDiscriminatedUnion,
  $ZodE164: () => $ZodE164,
  $ZodEmail: () => $ZodEmail,
  $ZodEmoji: () => $ZodEmoji,
  $ZodEncodeError: () => $ZodEncodeError,
  $ZodEnum: () => $ZodEnum,
  $ZodError: () => $ZodError,
  $ZodFile: () => $ZodFile,
  $ZodFunction: () => $ZodFunction,
  $ZodGUID: () => $ZodGUID,
  $ZodIPv4: () => $ZodIPv4,
  $ZodIPv6: () => $ZodIPv6,
  $ZodISODate: () => $ZodISODate,
  $ZodISODateTime: () => $ZodISODateTime,
  $ZodISODuration: () => $ZodISODuration,
  $ZodISOTime: () => $ZodISOTime,
  $ZodIntersection: () => $ZodIntersection,
  $ZodJWT: () => $ZodJWT,
  $ZodKSUID: () => $ZodKSUID,
  $ZodLazy: () => $ZodLazy,
  $ZodLiteral: () => $ZodLiteral,
  $ZodMap: () => $ZodMap,
  $ZodNaN: () => $ZodNaN,
  $ZodNanoID: () => $ZodNanoID,
  $ZodNever: () => $ZodNever,
  $ZodNonOptional: () => $ZodNonOptional,
  $ZodNull: () => $ZodNull,
  $ZodNullable: () => $ZodNullable,
  $ZodNumber: () => $ZodNumber,
  $ZodNumberFormat: () => $ZodNumberFormat,
  $ZodObject: () => $ZodObject,
  $ZodObjectJIT: () => $ZodObjectJIT,
  $ZodOptional: () => $ZodOptional,
  $ZodPipe: () => $ZodPipe,
  $ZodPrefault: () => $ZodPrefault,
  $ZodPromise: () => $ZodPromise,
  $ZodReadonly: () => $ZodReadonly,
  $ZodRealError: () => $ZodRealError,
  $ZodRecord: () => $ZodRecord,
  $ZodRegistry: () => $ZodRegistry,
  $ZodSet: () => $ZodSet,
  $ZodString: () => $ZodString,
  $ZodStringFormat: () => $ZodStringFormat,
  $ZodSuccess: () => $ZodSuccess,
  $ZodSymbol: () => $ZodSymbol,
  $ZodTemplateLiteral: () => $ZodTemplateLiteral,
  $ZodTransform: () => $ZodTransform,
  $ZodTuple: () => $ZodTuple,
  $ZodType: () => $ZodType,
  $ZodULID: () => $ZodULID,
  $ZodURL: () => $ZodURL,
  $ZodUUID: () => $ZodUUID,
  $ZodUndefined: () => $ZodUndefined,
  $ZodUnion: () => $ZodUnion,
  $ZodUnknown: () => $ZodUnknown,
  $ZodVoid: () => $ZodVoid,
  $ZodXID: () => $ZodXID,
  $brand: () => $brand,
  $constructor: () => $constructor,
  $input: () => $input,
  $output: () => $output,
  Doc: () => Doc,
  JSONSchema: () => json_schema_exports,
  JSONSchemaGenerator: () => JSONSchemaGenerator,
  NEVER: () => NEVER,
  TimePrecision: () => TimePrecision,
  _any: () => _any,
  _array: () => _array,
  _base64: () => _base64,
  _base64url: () => _base64url,
  _bigint: () => _bigint,
  _boolean: () => _boolean,
  _catch: () => _catch,
  _check: () => _check,
  _cidrv4: () => _cidrv4,
  _cidrv6: () => _cidrv6,
  _coercedBigint: () => _coercedBigint,
  _coercedBoolean: () => _coercedBoolean,
  _coercedDate: () => _coercedDate,
  _coercedNumber: () => _coercedNumber,
  _coercedString: () => _coercedString,
  _cuid: () => _cuid,
  _cuid2: () => _cuid2,
  _custom: () => _custom,
  _date: () => _date,
  _decode: () => _decode,
  _decodeAsync: () => _decodeAsync,
  _default: () => _default,
  _discriminatedUnion: () => _discriminatedUnion,
  _e164: () => _e164,
  _email: () => _email,
  _emoji: () => _emoji2,
  _encode: () => _encode,
  _encodeAsync: () => _encodeAsync,
  _endsWith: () => _endsWith,
  _enum: () => _enum,
  _file: () => _file,
  _float32: () => _float32,
  _float64: () => _float64,
  _gt: () => _gt,
  _gte: () => _gte,
  _guid: () => _guid,
  _includes: () => _includes,
  _int: () => _int,
  _int32: () => _int32,
  _int64: () => _int64,
  _intersection: () => _intersection,
  _ipv4: () => _ipv4,
  _ipv6: () => _ipv6,
  _isoDate: () => _isoDate,
  _isoDateTime: () => _isoDateTime,
  _isoDuration: () => _isoDuration,
  _isoTime: () => _isoTime,
  _jwt: () => _jwt,
  _ksuid: () => _ksuid,
  _lazy: () => _lazy,
  _length: () => _length,
  _literal: () => _literal,
  _lowercase: () => _lowercase,
  _lt: () => _lt,
  _lte: () => _lte,
  _map: () => _map,
  _max: () => _lte,
  _maxLength: () => _maxLength,
  _maxSize: () => _maxSize,
  _mime: () => _mime,
  _min: () => _gte,
  _minLength: () => _minLength,
  _minSize: () => _minSize,
  _multipleOf: () => _multipleOf,
  _nan: () => _nan,
  _nanoid: () => _nanoid,
  _nativeEnum: () => _nativeEnum,
  _negative: () => _negative,
  _never: () => _never,
  _nonnegative: () => _nonnegative,
  _nonoptional: () => _nonoptional,
  _nonpositive: () => _nonpositive,
  _normalize: () => _normalize,
  _null: () => _null2,
  _nullable: () => _nullable,
  _number: () => _number,
  _optional: () => _optional,
  _overwrite: () => _overwrite,
  _parse: () => _parse,
  _parseAsync: () => _parseAsync,
  _pipe: () => _pipe,
  _positive: () => _positive,
  _promise: () => _promise,
  _property: () => _property,
  _readonly: () => _readonly,
  _record: () => _record,
  _refine: () => _refine,
  _regex: () => _regex,
  _safeDecode: () => _safeDecode,
  _safeDecodeAsync: () => _safeDecodeAsync,
  _safeEncode: () => _safeEncode,
  _safeEncodeAsync: () => _safeEncodeAsync,
  _safeParse: () => _safeParse,
  _safeParseAsync: () => _safeParseAsync,
  _set: () => _set,
  _size: () => _size,
  _startsWith: () => _startsWith,
  _string: () => _string,
  _stringFormat: () => _stringFormat,
  _stringbool: () => _stringbool,
  _success: () => _success,
  _superRefine: () => _superRefine,
  _symbol: () => _symbol,
  _templateLiteral: () => _templateLiteral,
  _toLowerCase: () => _toLowerCase,
  _toUpperCase: () => _toUpperCase,
  _transform: () => _transform,
  _trim: () => _trim,
  _tuple: () => _tuple,
  _uint32: () => _uint32,
  _uint64: () => _uint64,
  _ulid: () => _ulid,
  _undefined: () => _undefined2,
  _union: () => _union,
  _unknown: () => _unknown,
  _uppercase: () => _uppercase,
  _url: () => _url,
  _uuid: () => _uuid,
  _uuidv4: () => _uuidv4,
  _uuidv6: () => _uuidv6,
  _uuidv7: () => _uuidv7,
  _void: () => _void,
  _xid: () => _xid,
  clone: () => clone,
  config: () => config,
  decode: () => decode,
  decodeAsync: () => decodeAsync,
  encode: () => encode,
  encodeAsync: () => encodeAsync,
  flattenError: () => flattenError,
  formatError: () => formatError,
  globalConfig: () => globalConfig,
  globalRegistry: () => globalRegistry,
  isValidBase64: () => isValidBase64,
  isValidBase64URL: () => isValidBase64URL,
  isValidJWT: () => isValidJWT,
  locales: () => locales_exports,
  parse: () => parse,
  parseAsync: () => parseAsync,
  prettifyError: () => prettifyError,
  regexes: () => regexes_exports,
  registry: () => registry,
  safeDecode: () => safeDecode,
  safeDecodeAsync: () => safeDecodeAsync,
  safeEncode: () => safeEncode,
  safeEncodeAsync: () => safeEncodeAsync,
  safeParse: () => safeParse,
  safeParseAsync: () => safeParseAsync,
  toDotPath: () => toDotPath,
  toJSONSchema: () => toJSONSchema,
  treeifyError: () => treeifyError,
  util: () => util_exports,
  version: () => version
});

// node_modules/zod/v4/core/core.js
var NEVER = Object.freeze({
  status: "aborted"
});
// @__NO_SIDE_EFFECTS__
function $constructor(name, initializer3, params) {
  function init(inst, def) {
    var _a;
    Object.defineProperty(inst, "_zod", {
      value: inst._zod ?? {},
      enumerable: false
    });
    (_a = inst._zod).traits ?? (_a.traits = /* @__PURE__ */ new Set());
    inst._zod.traits.add(name);
    initializer3(inst, def);
    for (const k in _.prototype) {
      if (!(k in inst))
        Object.defineProperty(inst, k, { value: _.prototype[k].bind(inst) });
    }
    inst._zod.constr = _;
    inst._zod.def = def;
  }
  const Parent = params?.Parent ?? Object;
  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    var _a;
    const inst = params?.Parent ? new Definition() : this;
    init(inst, def);
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    for (const fn of inst._zod.deferred) {
      fn();
    }
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
var $brand = Symbol("zod_brand");
var $ZodAsyncError = class extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
};
var $ZodEncodeError = class extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
};
var globalConfig = {};
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}

// node_modules/zod/v4/core/util.js
var util_exports = {};
__export(util_exports, {
  BIGINT_FORMAT_RANGES: () => BIGINT_FORMAT_RANGES,
  Class: () => Class,
  NUMBER_FORMAT_RANGES: () => NUMBER_FORMAT_RANGES,
  aborted: () => aborted,
  allowsEval: () => allowsEval,
  assert: () => assert,
  assertEqual: () => assertEqual,
  assertIs: () => assertIs,
  assertNever: () => assertNever,
  assertNotEqual: () => assertNotEqual,
  assignProp: () => assignProp,
  base64ToUint8Array: () => base64ToUint8Array,
  base64urlToUint8Array: () => base64urlToUint8Array,
  cached: () => cached,
  captureStackTrace: () => captureStackTrace,
  cleanEnum: () => cleanEnum,
  cleanRegex: () => cleanRegex,
  clone: () => clone,
  cloneDef: () => cloneDef,
  createTransparentProxy: () => createTransparentProxy,
  defineLazy: () => defineLazy,
  esc: () => esc,
  escapeRegex: () => escapeRegex,
  extend: () => extend,
  finalizeIssue: () => finalizeIssue,
  floatSafeRemainder: () => floatSafeRemainder,
  getElementAtPath: () => getElementAtPath,
  getEnumValues: () => getEnumValues,
  getLengthableOrigin: () => getLengthableOrigin,
  getParsedType: () => getParsedType,
  getSizableOrigin: () => getSizableOrigin,
  hexToUint8Array: () => hexToUint8Array,
  isObject: () => isObject,
  isPlainObject: () => isPlainObject,
  issue: () => issue,
  joinValues: () => joinValues,
  jsonStringifyReplacer: () => jsonStringifyReplacer,
  merge: () => merge,
  mergeDefs: () => mergeDefs,
  normalizeParams: () => normalizeParams,
  nullish: () => nullish,
  numKeys: () => numKeys,
  objectClone: () => objectClone,
  omit: () => omit,
  optionalKeys: () => optionalKeys,
  partial: () => partial,
  pick: () => pick,
  prefixIssues: () => prefixIssues,
  primitiveTypes: () => primitiveTypes,
  promiseAllObject: () => promiseAllObject,
  propertyKeyTypes: () => propertyKeyTypes,
  randomString: () => randomString,
  required: () => required,
  safeExtend: () => safeExtend,
  shallowClone: () => shallowClone,
  stringifyPrimitive: () => stringifyPrimitive,
  uint8ArrayToBase64: () => uint8ArrayToBase64,
  uint8ArrayToBase64url: () => uint8ArrayToBase64url,
  uint8ArrayToHex: () => uint8ArrayToHex,
  unwrapMessage: () => unwrapMessage
});
function assertEqual(val) {
  return val;
}
function assertNotEqual(val) {
  return val;
}
function assertIs(_arg) {
}
function assertNever(_x) {
  throw new Error();
}
function assert(_) {
}
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function joinValues(array2, separator = "|") {
  return array2.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cached(getter) {
  const set2 = false;
  return {
    get value() {
      if (!set2) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    }
  };
}
function nullish(input) {
  return input === null || input === void 0;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepString = step.toString();
  let stepDecCount = (stepString.split(".")[1] || "").length;
  if (stepDecCount === 0 && /\d?e-\d?/.test(stepString)) {
    const match = stepString.match(/\d?e-(\d?)/);
    if (match?.[1]) {
      stepDecCount = Number.parseInt(match[1]);
    }
  }
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var EVALUATING = Symbol("evaluating");
function defineLazy(object2, key, getter) {
  let value = void 0;
  Object.defineProperty(object2, key, {
    get() {
      if (value === EVALUATING) {
        return void 0;
      }
      if (value === void 0) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object2, key, {
        value: v
        // configurable: true,
      });
    },
    configurable: true
  });
}
function objectClone(obj) {
  return Object.create(Object.getPrototypeOf(obj), Object.getOwnPropertyDescriptors(obj));
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function cloneDef(schema) {
  return mergeDefs(schema._zod.def);
}
function getElementAtPath(obj, path) {
  if (!path)
    return obj;
  return path.reduce((acc, key) => acc?.[key], obj);
}
function promiseAllObject(promisesObj) {
  const keys = Object.keys(promisesObj);
  const promises = keys.map((key) => promisesObj[key]);
  return Promise.all(promises).then((results) => {
    const resolvedObj = {};
    for (let i = 0; i < keys.length; i++) {
      resolvedObj[keys[i]] = results[i];
    }
    return resolvedObj;
  });
}
function randomString(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let str = "";
  for (let i = 0; i < length; i++) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}
function esc(str) {
  return JSON.stringify(str);
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {
};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = cached(() => {
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === void 0)
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  return o;
}
function numKeys(data) {
  let keyCount = 0;
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      keyCount++;
    }
  }
  return keyCount;
}
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object":
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return "promise";
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return "map";
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return "set";
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return "date";
      }
      if (typeof File !== "undefined" && data instanceof File) {
        return "file";
      }
      return "object";
    default:
      throw new Error(`Unknown data type: ${t}`);
  }
};
var propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
var primitiveTypes = /* @__PURE__ */ new Set(["string", "number", "bigint", "boolean", "symbol", "undefined"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== void 0) {
    if (params?.error !== void 0)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function createTransparentProxy(getter) {
  let target;
  return new Proxy({}, {
    get(_, prop, receiver) {
      target ?? (target = getter());
      return Reflect.get(target, prop, receiver);
    },
    set(_, prop, value, receiver) {
      target ?? (target = getter());
      return Reflect.set(target, prop, value, receiver);
    },
    has(_, prop) {
      target ?? (target = getter());
      return Reflect.has(target, prop);
    },
    deleteProperty(_, prop) {
      target ?? (target = getter());
      return Reflect.deleteProperty(target, prop);
    },
    ownKeys(_) {
      target ?? (target = getter());
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(_, prop) {
      target ?? (target = getter());
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    defineProperty(_, prop, descriptor) {
      target ?? (target = getter());
      return Reflect.defineProperty(target, prop, descriptor);
    }
  });
}
function stringifyPrimitive(value) {
  if (typeof value === "bigint")
    return value.toString() + "n";
  if (typeof value === "string")
    return `"${value}"`;
  return `${value}`;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = {
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-34028234663852886e22, 34028234663852886e22],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
var BIGINT_FORMAT_RANGES = {
  int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
  uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = {};
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        newShape[key] = currDef.shape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = { ...schema._zod.def.shape };
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        delete newShape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error("Object schemas containing refinements cannot be extended. Use `.safeExtend()` instead.");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  const def = {
    ...schema._zod.def,
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    checks: schema._zod.def.checks
  };
  return clone(schema, def);
}
function merge(a, b) {
  const def = mergeDefs(a._zod.def, {
    get shape() {
      const _shape = { ...a._zod.def.shape, ...b._zod.def.shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: []
    // delete existing checks
  });
  return clone(a, def);
}
function partial(Class2, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in oldShape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = Class2 ? new Class2({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      } else {
        for (const key in oldShape) {
          shape[key] = Class2 ? new Class2({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function required(Class2, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in shape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = new Class2({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      } else {
        for (const key in oldShape) {
          shape[key] = new Class2({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a;
    (_a = iss).path ?? (_a.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config2) {
  const full = { ...iss, path: iss.path ?? [] };
  if (!iss.message) {
    const message = unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config2.customError?.(iss)) ?? unwrapMessage(config2.localeError?.(iss)) ?? "Invalid input";
    full.message = message;
  }
  delete full.inst;
  delete full.continue;
  if (!ctx?.reportInput) {
    delete full.input;
  }
  return full;
}
function getSizableOrigin(input) {
  if (input instanceof Set)
    return "set";
  if (input instanceof Map)
    return "map";
  if (input instanceof File)
    return "file";
  return "unknown";
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function cleanEnum(obj) {
  return Object.entries(obj).filter(([k, _]) => {
    return Number.isNaN(Number.parseInt(k, 10));
  }).map((el) => el[1]);
}
function base64ToUint8Array(base643) {
  const binaryString = atob(base643);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
function uint8ArrayToBase64(bytes) {
  let binaryString = "";
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryString);
}
function base64urlToUint8Array(base64url3) {
  const base643 = base64url3.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - base643.length % 4) % 4);
  return base64ToUint8Array(base643 + padding);
}
function uint8ArrayToBase64url(bytes) {
  return uint8ArrayToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function hexToUint8Array(hex3) {
  const cleanHex = hex3.replace(/^0x/, "");
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}
function uint8ArrayToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
var Class = class {
  constructor(..._args) {
  }
};

// node_modules/zod/v4/core/errors.js
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  Object.defineProperty(inst, "_zod", {
    value: inst._zod,
    enumerable: false
  });
  Object.defineProperty(inst, "issues", {
    value: def,
    enumerable: false
  });
  inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
  Object.defineProperty(inst, "toString", {
    value: () => inst.message,
    enumerable: false
  });
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, { Parent: Error });
function flattenError(error45, mapper = (issue2) => issue2.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error45.issues) {
    if (sub.path.length > 0) {
      fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
      fieldErrors[sub.path[0]].push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error45, _mapper) {
  const mapper = _mapper || function(issue2) {
    return issue2.message;
  };
  const fieldErrors = { _errors: [] };
  const processError = (error46) => {
    for (const issue2 of error46.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({ issues }));
      } else if (issue2.code === "invalid_key") {
        processError({ issues: issue2.issues });
      } else if (issue2.code === "invalid_element") {
        processError({ issues: issue2.issues });
      } else if (issue2.path.length === 0) {
        fieldErrors._errors.push(mapper(issue2));
      } else {
        let curr = fieldErrors;
        let i = 0;
        while (i < issue2.path.length) {
          const el = issue2.path[i];
          const terminal = i === issue2.path.length - 1;
          if (!terminal) {
            curr[el] = curr[el] || { _errors: [] };
          } else {
            curr[el] = curr[el] || { _errors: [] };
            curr[el]._errors.push(mapper(issue2));
          }
          curr = curr[el];
          i++;
        }
      }
    }
  };
  processError(error45);
  return fieldErrors;
}
function treeifyError(error45, _mapper) {
  const mapper = _mapper || function(issue2) {
    return issue2.message;
  };
  const result = { errors: [] };
  const processError = (error46, path = []) => {
    var _a, _b;
    for (const issue2 of error46.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({ issues }, issue2.path));
      } else if (issue2.code === "invalid_key") {
        processError({ issues: issue2.issues }, issue2.path);
      } else if (issue2.code === "invalid_element") {
        processError({ issues: issue2.issues }, issue2.path);
      } else {
        const fullpath = [...path, ...issue2.path];
        if (fullpath.length === 0) {
          result.errors.push(mapper(issue2));
          continue;
        }
        let curr = result;
        let i = 0;
        while (i < fullpath.length) {
          const el = fullpath[i];
          const terminal = i === fullpath.length - 1;
          if (typeof el === "string") {
            curr.properties ?? (curr.properties = {});
            (_a = curr.properties)[el] ?? (_a[el] = { errors: [] });
            curr = curr.properties[el];
          } else {
            curr.items ?? (curr.items = []);
            (_b = curr.items)[el] ?? (_b[el] = { errors: [] });
            curr = curr.items[el];
          }
          if (terminal) {
            curr.errors.push(mapper(issue2));
          }
          i++;
        }
      }
    }
  };
  processError(error45);
  return result;
}
function toDotPath(_path) {
  const segs = [];
  const path = _path.map((seg) => typeof seg === "object" ? seg.key : seg);
  for (const seg of path) {
    if (typeof seg === "number")
      segs.push(`[${seg}]`);
    else if (typeof seg === "symbol")
      segs.push(`[${JSON.stringify(String(seg))}]`);
    else if (/[^\w$]/.test(seg))
      segs.push(`[${JSON.stringify(seg)}]`);
    else {
      if (segs.length)
        segs.push(".");
      segs.push(seg);
    }
  }
  return segs.join("");
}
function prettifyError(error45) {
  const lines = [];
  const issues = [...error45.issues].sort((a, b) => (a.path ?? []).length - (b.path ?? []).length);
  for (const issue2 of issues) {
    lines.push(`\u2716 ${issue2.message}`);
    if (issue2.path?.length)
      lines.push(`  \u2192 at ${toDotPath(issue2.path)}`);
  }
  return lines.join("\n");
}

// node_modules/zod/v4/core/parse.js
var _parse = (_Err) => (schema, value, _ctx, _params) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: false }) : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  if (result.issues.length) {
    const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, _params?.callee);
    throw e;
  }
  return result.value;
};
var parse = /* @__PURE__ */ _parse($ZodRealError);
var _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  if (result.issues.length) {
    const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, params?.callee);
    throw e;
  }
  return result.value;
};
var parseAsync = /* @__PURE__ */ _parseAsync($ZodRealError);
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  return result.issues.length ? {
    success: false,
    error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? {
    success: false,
    error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);
var _encode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _parse(_Err)(schema, value, ctx);
};
var encode = /* @__PURE__ */ _encode($ZodRealError);
var _decode = (_Err) => (schema, value, _ctx) => {
  return _parse(_Err)(schema, value, _ctx);
};
var decode = /* @__PURE__ */ _decode($ZodRealError);
var _encodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _parseAsync(_Err)(schema, value, ctx);
};
var encodeAsync = /* @__PURE__ */ _encodeAsync($ZodRealError);
var _decodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _parseAsync(_Err)(schema, value, _ctx);
};
var decodeAsync = /* @__PURE__ */ _decodeAsync($ZodRealError);
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var safeEncode = /* @__PURE__ */ _safeEncode($ZodRealError);
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var safeDecode = /* @__PURE__ */ _safeDecode($ZodRealError);
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync($ZodRealError);
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync($ZodRealError);

// node_modules/zod/v4/core/regexes.js
var regexes_exports = {};
__export(regexes_exports, {
  base64: () => base64,
  base64url: () => base64url,
  bigint: () => bigint,
  boolean: () => boolean,
  browserEmail: () => browserEmail,
  cidrv4: () => cidrv4,
  cidrv6: () => cidrv6,
  cuid: () => cuid,
  cuid2: () => cuid2,
  date: () => date,
  datetime: () => datetime,
  domain: () => domain,
  duration: () => duration,
  e164: () => e164,
  email: () => email,
  emoji: () => emoji,
  extendedDuration: () => extendedDuration,
  guid: () => guid,
  hex: () => hex,
  hostname: () => hostname,
  html5Email: () => html5Email,
  idnEmail: () => idnEmail,
  integer: () => integer,
  ipv4: () => ipv4,
  ipv6: () => ipv6,
  ksuid: () => ksuid,
  lowercase: () => lowercase,
  md5_base64: () => md5_base64,
  md5_base64url: () => md5_base64url,
  md5_hex: () => md5_hex,
  nanoid: () => nanoid,
  null: () => _null,
  number: () => number,
  rfc5322Email: () => rfc5322Email,
  sha1_base64: () => sha1_base64,
  sha1_base64url: () => sha1_base64url,
  sha1_hex: () => sha1_hex,
  sha256_base64: () => sha256_base64,
  sha256_base64url: () => sha256_base64url,
  sha256_hex: () => sha256_hex,
  sha384_base64: () => sha384_base64,
  sha384_base64url: () => sha384_base64url,
  sha384_hex: () => sha384_hex,
  sha512_base64: () => sha512_base64,
  sha512_base64url: () => sha512_base64url,
  sha512_hex: () => sha512_hex,
  string: () => string,
  time: () => time,
  ulid: () => ulid,
  undefined: () => _undefined,
  unicodeEmail: () => unicodeEmail,
  uppercase: () => uppercase,
  uuid: () => uuid,
  uuid4: () => uuid4,
  uuid6: () => uuid6,
  uuid7: () => uuid7,
  xid: () => xid
});
var cuid = /^[cC][^\s-]{8,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var extendedDuration = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version2) => {
  if (!version2)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version2}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var uuid4 = /* @__PURE__ */ uuid(4);
var uuid6 = /* @__PURE__ */ uuid(6);
var uuid7 = /* @__PURE__ */ uuid(7);
var email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var html5Email = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var rfc5322Email = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
var unicodeEmail = /^[^\s@"]{1,64}@[^\s@]{1,255}$/u;
var idnEmail = unicodeEmail;
var browserEmail = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var _emoji = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^[A-Za-z0-9_-]*$/;
var hostname = /^(?=.{1,253}\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\.?$/;
var domain = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
var e164 = /^\+(?:[0-9]){6,14}[0-9]$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
var date = /* @__PURE__ */ new RegExp(`^${dateSource}$`);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const time3 = timeSource({ precision: args.precision });
  const opts = ["Z"];
  if (args.local)
    opts.push("");
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const timeRegex = `${time3}(?:${opts.join("|")})`;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var string = (params) => {
  const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
  return new RegExp(`^${regex}$`);
};
var bigint = /^-?\d+n?$/;
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?/;
var boolean = /^(?:true|false)$/i;
var _null = /^null$/i;
var _undefined = /^undefined$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;
var hex = /^[0-9a-fA-F]*$/;
function fixedBase64(bodyLength, padding) {
  return new RegExp(`^[A-Za-z0-9+/]{${bodyLength}}${padding}$`);
}
function fixedBase64url(length) {
  return new RegExp(`^[A-Za-z0-9_-]{${length}}$`);
}
var md5_hex = /^[0-9a-fA-F]{32}$/;
var md5_base64 = /* @__PURE__ */ fixedBase64(22, "==");
var md5_base64url = /* @__PURE__ */ fixedBase64url(22);
var sha1_hex = /^[0-9a-fA-F]{40}$/;
var sha1_base64 = /* @__PURE__ */ fixedBase64(27, "=");
var sha1_base64url = /* @__PURE__ */ fixedBase64url(27);
var sha256_hex = /^[0-9a-fA-F]{64}$/;
var sha256_base64 = /* @__PURE__ */ fixedBase64(43, "=");
var sha256_base64url = /* @__PURE__ */ fixedBase64url(43);
var sha384_hex = /^[0-9a-fA-F]{96}$/;
var sha384_base64 = /* @__PURE__ */ fixedBase64(64, "");
var sha384_base64url = /* @__PURE__ */ fixedBase64url(64);
var sha512_hex = /^[0-9a-fA-F]{128}$/;
var sha512_base64 = /* @__PURE__ */ fixedBase64(86, "==");
var sha512_base64url = /* @__PURE__ */ fixedBase64url(86);

// node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a = inst._zod).onattach ?? (_a.onattach = []);
});
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (def.value < curr) {
      if (def.inclusive)
        bag.maximum = def.value;
      else
        bag.exclusiveMaximum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (def.value > curr) {
      if (def.inclusive)
        bag.minimum = def.value;
      else
        bag.exclusiveMinimum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    var _a;
    (_a = inst2._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
  });
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
    if (isInt)
      bag.pattern = integer;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inst
      });
    }
  };
});
var $ZodCheckBigIntFormat = /* @__PURE__ */ $constructor("$ZodCheckBigIntFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  const [minimum, maximum] = BIGINT_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (input < minimum) {
      payload.issues.push({
        origin: "bigint",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "bigint",
        input,
        code: "too_big",
        maximum,
        inst
      });
    }
  };
});
var $ZodCheckMaxSize = /* @__PURE__ */ $constructor("$ZodCheckMaxSize", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size <= def.maximum)
      return;
    payload.issues.push({
      origin: getSizableOrigin(input),
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinSize = /* @__PURE__ */ $constructor("$ZodCheckMinSize", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size >= def.minimum)
      return;
    payload.issues.push({
      origin: getSizableOrigin(input),
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckSizeEquals = /* @__PURE__ */ $constructor("$ZodCheckSizeEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.minimum = def.size;
    bag.maximum = def.size;
    bag.size = def.size;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size === def.size)
      return;
    const tooBig = size > def.size;
    payload.issues.push({
      origin: getSizableOrigin(input),
      ...tooBig ? { code: "too_big", maximum: def.size } : { code: "too_small", minimum: def.size },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.minimum = def.length;
    bag.maximum = def.length;
    bag.length = def.length;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a, _b;
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    if (def.pattern) {
      bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
      bag.patterns.add(def.pattern);
    }
  });
  if (def.pattern)
    (_a = inst._zod).check ?? (_a.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {
    });
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function handleCheckPropertyResult(result, payload, property) {
  if (result.issues.length) {
    payload.issues.push(...prefixIssues(property, result.issues));
  }
}
var $ZodCheckProperty = /* @__PURE__ */ $constructor("$ZodCheckProperty", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    const result = def.schema._zod.run({
      value: payload.value[def.property],
      issues: []
    }, {});
    if (result instanceof Promise) {
      return result.then((result2) => handleCheckPropertyResult(result2, payload, def.property));
    }
    handleCheckPropertyResult(result, payload, def.property);
    return;
  };
});
var $ZodCheckMimeType = /* @__PURE__ */ $constructor("$ZodCheckMimeType", (inst, def) => {
  $ZodCheck.init(inst, def);
  const mimeSet = new Set(def.mime);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.mime = def.mime;
  });
  inst._zod.check = (payload) => {
    if (mimeSet.has(payload.value.type))
      return;
    payload.issues.push({
      code: "invalid_value",
      values: def.mime,
      input: payload.value.type,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// node_modules/zod/v4/core/doc.js
var Doc = class {
  constructor(args = []) {
    this.content = [];
    this.indent = 0;
    if (this)
      this.args = args;
  }
  indented(fn) {
    this.indent += 1;
    fn(this);
    this.indent -= 1;
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split("\n").filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const args = this?.args;
    const content = this?.content ?? [``];
    const lines = [...content.map((x) => `  ${x}`)];
    return new F(...args, lines.join("\n"));
  }
};

// node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 1,
  patch: 8
};

// node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const checks = [...inst._zod.def.checks ?? []];
  if (inst._zod.traits.has("$ZodCheck")) {
    checks.unshift(inst);
  }
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks2, ctx) => {
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks2) {
        if (ch._zod.def.when) {
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError();
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary2) => {
            return handleCanaryResult(canary2, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return result.then((result2) => runChecks(result2, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
  inst["~standard"] = {
    validate: (value) => {
      try {
        const r = safeParse(inst, value);
        return r.success ? { value: r.data } : { issues: r.error?.issues };
      } catch (_) {
        return safeParseAsync(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
      }
    },
    vendor: "zod",
    version: 1
  };
});
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string(inst._zod.bag);
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_2) {
      }
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === void 0)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      const url2 = new URL(trimmed);
      if (def.hostname) {
        def.hostname.lastIndex = 0;
        if (!def.hostname.test(url2.hostname)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid hostname",
            pattern: hostname.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.protocol) {
        def.protocol.lastIndex = 0;
        if (!def.protocol.test(url2.protocol.endsWith(":") ? url2.protocol.slice(0, -1) : url2.protocol)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid protocol",
            pattern: def.protocol.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.normalize) {
        payload.value = url2.href;
      } else {
        payload.value = trimmed;
      }
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  def.pattern ?? (def.pattern = nanoid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = `ipv4`;
  });
});
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = `ipv6`;
  });
  inst._zod.check = (payload) => {
    try {
      new URL(`http://[${payload.value}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    const parts = payload.value.split("/");
    try {
      if (parts.length !== 2)
        throw new Error();
      const [address, prefix] = parts;
      if (!prefix)
        throw new Error();
      const prefixNum = Number(prefix);
      if (`${prefixNum}` !== prefix)
        throw new Error();
      if (prefixNum < 0 || prefixNum > 128)
        throw new Error();
      new URL(`http://[${address}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.contentEncoding = "base64";
  });
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function isValidBase64URL(data) {
  if (!base64url.test(data))
    return false;
  const base643 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base643.padEnd(Math.ceil(base643.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64url);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.contentEncoding = "base64url";
  });
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCustomStringFormat = /* @__PURE__ */ $constructor("$ZodCustomStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (def.fn(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: def.format,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.bag.pattern ?? number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodBigInt = /* @__PURE__ */ $constructor("$ZodBigInt", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = bigint;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = BigInt(payload.value);
      } catch (_) {
      }
    if (typeof payload.value === "bigint")
      return payload;
    payload.issues.push({
      expected: "bigint",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodBigIntFormat = /* @__PURE__ */ $constructor("$ZodBigInt", (inst, def) => {
  $ZodCheckBigIntFormat.init(inst, def);
  $ZodBigInt.init(inst, def);
});
var $ZodSymbol = /* @__PURE__ */ $constructor("$ZodSymbol", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "symbol")
      return payload;
    payload.issues.push({
      expected: "symbol",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodUndefined = /* @__PURE__ */ $constructor("$ZodUndefined", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _undefined;
  inst._zod.values = /* @__PURE__ */ new Set([void 0]);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "undefined")
      return payload;
    payload.issues.push({
      expected: "undefined",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _null;
  inst._zod.values = /* @__PURE__ */ new Set([null]);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input === null)
      return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodAny = /* @__PURE__ */ $constructor("$ZodAny", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodVoid = /* @__PURE__ */ $constructor("$ZodVoid", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "undefined")
      return payload;
    payload.issues.push({
      expected: "void",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodDate = /* @__PURE__ */ $constructor("$ZodDate", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce) {
      try {
        payload.value = new Date(payload.value);
      } catch (_err) {
      }
    }
    const input = payload.value;
    const isDate = input instanceof Date;
    const isValidDate = isDate && !Number.isNaN(input.getTime());
    if (isValidDate)
      return payload;
    payload.issues.push({
      expected: "date",
      code: "invalid_type",
      input,
      ...isDate ? { received: "Invalid Date" } : {},
      inst
    });
    return payload;
  };
});
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = Array(input.length);
    const proms = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleArrayResult(result2, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (result.value === void 0) {
    if (key in input) {
      final.value[key] = void 0;
    }
  } else {
    final.value[key] = result.value;
  }
}
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  for (const k of keys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    keys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  for (const key of Object.keys(input)) {
    if (keySet.has(key))
      continue;
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input)));
    } else {
      handlePropertyResult(r, payload, key, input);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const _normalized = cached(() => normalizeDef(def));
  defineLazy(inst._zod, "propValues", () => {
    const shape = def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
        for (const v of field.values)
          propValues[key].add(v);
      }
    }
    return propValues;
  });
  const isObject4 = isObject;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject4(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = {};
    const proms = [];
    const shape = value.shape;
    for (const key of value.keys) {
      const el = shape[key];
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input)));
      } else {
        handlePropertyResult(r, payload, key, input);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const generateFastpass = (shape) => {
    const doc = new Doc(["shape", "payload", "ctx"]);
    const normalized = _normalized.value;
    const parseStr = (key) => {
      const k = esc(key);
      return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    };
    doc.write(`const input = payload.value;`);
    const ids = /* @__PURE__ */ Object.create(null);
    let counter = 0;
    for (const key of normalized.keys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(`const newResult = {};`);
    for (const key of normalized.keys) {
      const id = ids[key];
      const k = esc(key);
      doc.write(`const ${id} = ${parseStr(key)};`);
      doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    const fn = doc.compile();
    return (payload, ctx) => fn(shape, payload, ctx);
  };
  let fastpass;
  const isObject4 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject4(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
  defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
  defineLazy(inst._zod, "values", () => {
    if (def.options.every((o) => o._zod.values)) {
      return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return void 0;
  });
  defineLazy(inst._zod, "pattern", () => {
    if (def.options.every((o) => o._zod.pattern)) {
      const patterns = def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return void 0;
  });
  const single = def.options.length === 1;
  const first = def.options[0]._zod.run;
  inst._zod.parse = (payload, ctx) => {
    if (single) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results2) => {
      return handleUnionResults(results2, payload, inst, ctx);
    });
  };
});
var $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  const _super = inst._zod.parse;
  defineLazy(inst._zod, "propValues", () => {
    const propValues = {};
    for (const option of def.options) {
      const pv = option._zod.propValues;
      if (!pv || Object.keys(pv).length === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
      for (const [k, v] of Object.entries(pv)) {
        if (!propValues[k])
          propValues[k] = /* @__PURE__ */ new Set();
        for (const val of v) {
          propValues[k].add(val);
        }
      }
    }
    return propValues;
  });
  const disc = cached(() => {
    const opts = def.options;
    const map2 = /* @__PURE__ */ new Map();
    for (const o of opts) {
      const values = o._zod.propValues?.[def.discriminator];
      if (!values || values.size === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
      for (const v of values) {
        if (map2.has(v)) {
          throw new Error(`Duplicate discriminator value "${String(v)}"`);
        }
        map2.set(v, o);
      }
    }
    return map2;
  });
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({
        code: "invalid_type",
        expected: "object",
        input,
        inst
      });
      return payload;
    }
    const opt = disc.value.get(input?.[def.discriminator]);
    if (opt) {
      return opt._zod.run(payload, ctx);
    }
    if (def.unionFallback) {
      return _super(payload, ctx);
    }
    payload.issues.push({
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: def.discriminator,
      input,
      path: [def.discriminator],
      inst
    });
    return payload;
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left2, right2]) => {
        return handleIntersectionResults(payload, left2, right2);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  if (left.issues.length) {
    result.issues.push(...left.issues);
  }
  if (right.issues.length) {
    result.issues.push(...right.issues);
  }
  if (aborted(result))
    return result;
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodTuple = /* @__PURE__ */ $constructor("$ZodTuple", (inst, def) => {
  $ZodType.init(inst, def);
  const items = def.items;
  const optStart = items.length - [...items].reverse().findIndex((item) => item._zod.optin !== "optional");
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        input,
        inst,
        expected: "tuple",
        code: "invalid_type"
      });
      return payload;
    }
    payload.value = [];
    const proms = [];
    if (!def.rest) {
      const tooBig = input.length > items.length;
      const tooSmall = input.length < optStart - 1;
      if (tooBig || tooSmall) {
        payload.issues.push({
          ...tooBig ? { code: "too_big", maximum: items.length } : { code: "too_small", minimum: items.length },
          input,
          inst,
          origin: "array"
        });
        return payload;
      }
    }
    let i = -1;
    for (const item of items) {
      i++;
      if (i >= input.length) {
        if (i >= optStart)
          continue;
      }
      const result = item._zod.run({
        value: input[i],
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleTupleResult(result2, payload, i)));
      } else {
        handleTupleResult(result, payload, i);
      }
    }
    if (def.rest) {
      const rest = input.slice(items.length);
      for (const el of rest) {
        i++;
        const result = def.rest._zod.run({
          value: el,
          issues: []
        }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => handleTupleResult(result2, payload, i)));
        } else {
          handleTupleResult(result, payload, i);
        }
      }
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleTupleResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    if (def.keyType._zod.values) {
      const values = def.keyType._zod.values;
      payload.value = {};
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result2) => {
              if (result2.issues.length) {
                payload.issues.push(...prefixIssues(key, result2.issues));
              }
              payload.value[key] = result2.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[key] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!values.has(key)) {
          unrecognized = unrecognized ?? [];
          unrecognized.push(key);
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized
        });
      }
    } else {
      payload.value = {};
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        if (keyResult.issues.length) {
          payload.issues.push({
            code: "invalid_key",
            origin: "record",
            issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
            input: key,
            path: [key],
            inst
          });
          payload.value[keyResult.value] = keyResult.value;
          continue;
        }
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => {
            if (result2.issues.length) {
              payload.issues.push(...prefixIssues(key, result2.issues));
            }
            payload.value[keyResult.value] = result2.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[keyResult.value] = result.value;
        }
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodMap = /* @__PURE__ */ $constructor("$ZodMap", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Map)) {
      payload.issues.push({
        expected: "map",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    payload.value = /* @__PURE__ */ new Map();
    for (const [key, value] of input) {
      const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
      const valueResult = def.valueType._zod.run({ value, issues: [] }, ctx);
      if (keyResult instanceof Promise || valueResult instanceof Promise) {
        proms.push(Promise.all([keyResult, valueResult]).then(([keyResult2, valueResult2]) => {
          handleMapResult(keyResult2, valueResult2, payload, key, input, inst, ctx);
        }));
      } else {
        handleMapResult(keyResult, valueResult, payload, key, input, inst, ctx);
      }
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleMapResult(keyResult, valueResult, final, key, input, inst, ctx) {
  if (keyResult.issues.length) {
    if (propertyKeyTypes.has(typeof key)) {
      final.issues.push(...prefixIssues(key, keyResult.issues));
    } else {
      final.issues.push({
        code: "invalid_key",
        origin: "map",
        input,
        inst,
        issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config()))
      });
    }
  }
  if (valueResult.issues.length) {
    if (propertyKeyTypes.has(typeof key)) {
      final.issues.push(...prefixIssues(key, valueResult.issues));
    } else {
      final.issues.push({
        origin: "map",
        code: "invalid_element",
        input,
        inst,
        key,
        issues: valueResult.issues.map((iss) => finalizeIssue(iss, ctx, config()))
      });
    }
  }
  final.value.set(keyResult.value, valueResult.value);
}
var $ZodSet = /* @__PURE__ */ $constructor("$ZodSet", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Set)) {
      payload.issues.push({
        input,
        inst,
        expected: "set",
        code: "invalid_type"
      });
      return payload;
    }
    const proms = [];
    payload.value = /* @__PURE__ */ new Set();
    for (const item of input) {
      const result = def.valueType._zod.run({ value: item, issues: [] }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleSetResult(result2, payload)));
      } else
        handleSetResult(result, payload);
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleSetResult(result, final) {
  if (result.issues.length) {
    final.issues.push(...result.issues);
  }
  final.value.add(result.value);
}
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  if (def.values.length === 0) {
    throw new Error("Cannot create literal schema with no valid values");
  }
  inst._zod.values = new Set(def.values);
  inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (inst._zod.values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodFile = /* @__PURE__ */ $constructor("$ZodFile", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input instanceof File)
      return payload;
    payload.issues.push({
      expected: "file",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output2) => {
        payload.value = output2;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError();
    }
    payload.value = _out;
    return payload;
  };
});
function handleOptionalResult(result, input) {
  if (result.issues.length && input === void 0) {
    return { issues: [], value: void 0 };
  }
  return result;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, void 0]) : void 0;
  });
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (def.innerType._zod.optin === "optional") {
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((r) => handleOptionalResult(r, payload.value));
      return handleOptionalResult(result, payload.value);
    }
    if (payload.value === void 0) {
      return payload;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
  });
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, null]) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === void 0) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleDefaultResult(result2, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === void 0) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === void 0) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => {
    const v = def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleNonOptionalResult(result2, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === void 0) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
var $ZodSuccess = /* @__PURE__ */ $constructor("$ZodSuccess", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError("ZodSuccess");
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => {
        payload.value = result2.issues.length === 0;
        return payload;
      });
    }
    payload.value = result.issues.length === 0;
    return payload;
  };
});
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => {
        payload.value = result2.value;
        if (result2.issues.length) {
          payload.value = def.catchValue({
            ...payload,
            error: {
              issues: result2.issues.map((iss) => finalizeIssue(iss, ctx, config()))
            },
            input: payload.value
          });
          payload.issues = [];
        }
        return payload;
      });
    }
    payload.value = result.value;
    if (result.issues.length) {
      payload.value = def.catchValue({
        ...payload,
        error: {
          issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
        },
        input: payload.value
      });
      payload.issues = [];
    }
    return payload;
  };
});
var $ZodNaN = /* @__PURE__ */ $constructor("$ZodNaN", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "number" || !Number.isNaN(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "nan",
        code: "invalid_type"
      });
      return payload;
    }
    return payload;
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right2) => handlePipeResult(right2, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left2) => handlePipeResult(left2, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues }, ctx);
}
var $ZodCodec = /* @__PURE__ */ $constructor("$ZodCodec", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    const direction = ctx.direction || "forward";
    if (direction === "forward") {
      const left = def.in._zod.run(payload, ctx);
      if (left instanceof Promise) {
        return left.then((left2) => handleCodecAResult(left2, def, ctx));
      }
      return handleCodecAResult(left, def, ctx);
    } else {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right2) => handleCodecAResult(right2, def, ctx));
      }
      return handleCodecAResult(right, def, ctx);
    }
  };
});
function handleCodecAResult(result, def, ctx) {
  if (result.issues.length) {
    result.aborted = true;
    return result;
  }
  const direction = ctx.direction || "forward";
  if (direction === "forward") {
    const transformed = def.transform(result.value, result);
    if (transformed instanceof Promise) {
      return transformed.then((value) => handleCodecTxResult(result, value, def.out, ctx));
    }
    return handleCodecTxResult(result, transformed, def.out, ctx);
  } else {
    const transformed = def.reverseTransform(result.value, result);
    if (transformed instanceof Promise) {
      return transformed.then((value) => handleCodecTxResult(result, value, def.in, ctx));
    }
    return handleCodecTxResult(result, transformed, def.in, ctx);
  }
}
function handleCodecTxResult(left, value, nextSchema, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return nextSchema._zod.run({ value, issues: left.issues }, ctx);
}
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodTemplateLiteral = /* @__PURE__ */ $constructor("$ZodTemplateLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  const regexParts = [];
  for (const part of def.parts) {
    if (typeof part === "object" && part !== null) {
      if (!part._zod.pattern) {
        throw new Error(`Invalid template literal part, no pattern found: ${[...part._zod.traits].shift()}`);
      }
      const source = part._zod.pattern instanceof RegExp ? part._zod.pattern.source : part._zod.pattern;
      if (!source)
        throw new Error(`Invalid template literal part: ${part._zod.traits}`);
      const start = source.startsWith("^") ? 1 : 0;
      const end = source.endsWith("$") ? source.length - 1 : source.length;
      regexParts.push(source.slice(start, end));
    } else if (part === null || primitiveTypes.has(typeof part)) {
      regexParts.push(escapeRegex(`${part}`));
    } else {
      throw new Error(`Invalid template literal part: ${part}`);
    }
  }
  inst._zod.pattern = new RegExp(`^${regexParts.join("")}$`);
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "string") {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "template_literal",
        code: "invalid_type"
      });
      return payload;
    }
    inst._zod.pattern.lastIndex = 0;
    if (!inst._zod.pattern.test(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        code: "invalid_format",
        format: def.format ?? "template_literal",
        pattern: inst._zod.pattern.source
      });
      return payload;
    }
    return payload;
  };
});
var $ZodFunction = /* @__PURE__ */ $constructor("$ZodFunction", (inst, def) => {
  $ZodType.init(inst, def);
  inst._def = def;
  inst._zod.def = def;
  inst.implement = (func) => {
    if (typeof func !== "function") {
      throw new Error("implement() must be called with a function");
    }
    return function(...args) {
      const parsedArgs = inst._def.input ? parse(inst._def.input, args) : args;
      const result = Reflect.apply(func, this, parsedArgs);
      if (inst._def.output) {
        return parse(inst._def.output, result);
      }
      return result;
    };
  };
  inst.implementAsync = (func) => {
    if (typeof func !== "function") {
      throw new Error("implementAsync() must be called with a function");
    }
    return async function(...args) {
      const parsedArgs = inst._def.input ? await parseAsync(inst._def.input, args) : args;
      const result = await Reflect.apply(func, this, parsedArgs);
      if (inst._def.output) {
        return await parseAsync(inst._def.output, result);
      }
      return result;
    };
  };
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "function") {
      payload.issues.push({
        code: "invalid_type",
        expected: "function",
        input: payload.value,
        inst
      });
      return payload;
    }
    const hasPromiseOutput = inst._def.output && inst._def.output._zod.def.type === "promise";
    if (hasPromiseOutput) {
      payload.value = inst.implementAsync(payload.value);
    } else {
      payload.value = inst.implement(payload.value);
    }
    return payload;
  };
  inst.input = (...args) => {
    const F = inst.constructor;
    if (Array.isArray(args[0])) {
      return new F({
        type: "function",
        input: new $ZodTuple({
          type: "tuple",
          items: args[0],
          rest: args[1]
        }),
        output: inst._def.output
      });
    }
    return new F({
      type: "function",
      input: args[0],
      output: inst._def.output
    });
  };
  inst.output = (output) => {
    const F = inst.constructor;
    return new F({
      type: "function",
      input: inst._def.input,
      output
    });
  };
  return inst;
});
var $ZodPromise = /* @__PURE__ */ $constructor("$ZodPromise", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    return Promise.resolve(payload.value).then((inner) => def.innerType._zod.run({ value: inner, issues: [] }, ctx));
  };
});
var $ZodLazy = /* @__PURE__ */ $constructor("$ZodLazy", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "innerType", () => def.getter());
  defineLazy(inst._zod, "pattern", () => inst._zod.innerType._zod.pattern);
  defineLazy(inst._zod, "propValues", () => inst._zod.innerType._zod.propValues);
  defineLazy(inst._zod, "optin", () => inst._zod.innerType._zod.optin ?? void 0);
  defineLazy(inst._zod, "optout", () => inst._zod.innerType._zod.optout ?? void 0);
  inst._zod.parse = (payload, ctx) => {
    const inner = inst._zod.innerType;
    return inner._zod.run(payload, ctx);
  };
});
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r2) => handleRefineResult(r2, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      // incorporates params.error into issue reporting
      path: [...inst._zod.def.path ?? []],
      // incorporates params.error into issue reporting
      continue: !inst._zod.def.abort
      // params: inst._zod.def.params,
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}

// node_modules/zod/v4/locales/index.js
var locales_exports = {};
__export(locales_exports, {
  ar: () => ar_default,
  az: () => az_default,
  be: () => be_default,
  ca: () => ca_default,
  cs: () => cs_default,
  da: () => da_default,
  de: () => de_default,
  en: () => en_default,
  eo: () => eo_default,
  es: () => es_default,
  fa: () => fa_default,
  fi: () => fi_default,
  fr: () => fr_default,
  frCA: () => fr_CA_default,
  he: () => he_default,
  hu: () => hu_default,
  id: () => id_default,
  is: () => is_default,
  it: () => it_default,
  ja: () => ja_default,
  ka: () => ka_default,
  kh: () => kh_default,
  km: () => km_default,
  ko: () => ko_default,
  lt: () => lt_default,
  mk: () => mk_default,
  ms: () => ms_default,
  nl: () => nl_default,
  no: () => no_default,
  ota: () => ota_default,
  pl: () => pl_default,
  ps: () => ps_default,
  pt: () => pt_default,
  ru: () => ru_default,
  sl: () => sl_default,
  sv: () => sv_default,
  ta: () => ta_default,
  th: () => th_default,
  tr: () => tr_default,
  ua: () => ua_default,
  uk: () => uk_default,
  ur: () => ur_default,
  vi: () => vi_default,
  yo: () => yo_default,
  zhCN: () => zh_CN_default,
  zhTW: () => zh_TW_default
});

// node_modules/zod/v4/locales/ar.js
var error = () => {
  const Sizable = {
    string: { unit: "\u062D\u0631\u0641", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" },
    file: { unit: "\u0628\u0627\u064A\u062A", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" },
    array: { unit: "\u0639\u0646\u0635\u0631", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" },
    set: { unit: "\u0639\u0646\u0635\u0631", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u0645\u062F\u062E\u0644",
    email: "\u0628\u0631\u064A\u062F \u0625\u0644\u0643\u062A\u0631\u0648\u0646\u064A",
    url: "\u0631\u0627\u0628\u0637",
    emoji: "\u0625\u064A\u0645\u0648\u062C\u064A",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u062A\u0627\u0631\u064A\u062E \u0648\u0648\u0642\u062A \u0628\u0645\u0639\u064A\u0627\u0631 ISO",
    date: "\u062A\u0627\u0631\u064A\u062E \u0628\u0645\u0639\u064A\u0627\u0631 ISO",
    time: "\u0648\u0642\u062A \u0628\u0645\u0639\u064A\u0627\u0631 ISO",
    duration: "\u0645\u062F\u0629 \u0628\u0645\u0639\u064A\u0627\u0631 ISO",
    ipv4: "\u0639\u0646\u0648\u0627\u0646 IPv4",
    ipv6: "\u0639\u0646\u0648\u0627\u0646 IPv6",
    cidrv4: "\u0645\u062F\u0649 \u0639\u0646\u0627\u0648\u064A\u0646 \u0628\u0635\u064A\u063A\u0629 IPv4",
    cidrv6: "\u0645\u062F\u0649 \u0639\u0646\u0627\u0648\u064A\u0646 \u0628\u0635\u064A\u063A\u0629 IPv6",
    base64: "\u0646\u064E\u0635 \u0628\u062A\u0631\u0645\u064A\u0632 base64-encoded",
    base64url: "\u0646\u064E\u0635 \u0628\u062A\u0631\u0645\u064A\u0632 base64url-encoded",
    json_string: "\u0646\u064E\u0635 \u0639\u0644\u0649 \u0647\u064A\u0626\u0629 JSON",
    e164: "\u0631\u0642\u0645 \u0647\u0627\u062A\u0641 \u0628\u0645\u0639\u064A\u0627\u0631 E.164",
    jwt: "JWT",
    template_literal: "\u0645\u062F\u062E\u0644"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u0645\u062F\u062E\u0644\u0627\u062A \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644\u0629: \u064A\u0641\u062A\u0631\u0636 \u0625\u062F\u062E\u0627\u0644 ${issue2.expected}\u060C \u0648\u0644\u0643\u0646 \u062A\u0645 \u0625\u062F\u062E\u0627\u0644 ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u0645\u062F\u062E\u0644\u0627\u062A \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644\u0629: \u064A\u0641\u062A\u0631\u0636 \u0625\u062F\u062E\u0627\u0644 ${stringifyPrimitive(issue2.values[0])}`;
        return `\u0627\u062E\u062A\u064A\u0627\u0631 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062A\u0648\u0642\u0639 \u0627\u0646\u062A\u0642\u0627\u0621 \u0623\u062D\u062F \u0647\u0630\u0647 \u0627\u0644\u062E\u064A\u0627\u0631\u0627\u062A: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return ` \u0623\u0643\u0628\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0623\u0646 \u062A\u0643\u0648\u0646 ${issue2.origin ?? "\u0627\u0644\u0642\u064A\u0645\u0629"} ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "\u0639\u0646\u0635\u0631"}`;
        return `\u0623\u0643\u0628\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0623\u0646 \u062A\u0643\u0648\u0646 ${issue2.origin ?? "\u0627\u0644\u0642\u064A\u0645\u0629"} ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0623\u0635\u063A\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0644\u0640 ${issue2.origin} \u0623\u0646 \u064A\u0643\u0648\u0646 ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u0623\u0635\u063A\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0644\u0640 ${issue2.origin} \u0623\u0646 \u064A\u0643\u0648\u0646 ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0628\u062F\u0623 \u0628\u0640 "${issue2.prefix}"`;
        if (_issue.format === "ends_with")
          return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0646\u062A\u0647\u064A \u0628\u0640 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u062A\u0636\u0645\u0651\u064E\u0646 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0637\u0627\u0628\u0642 \u0627\u0644\u0646\u0645\u0637 ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644`;
      }
      case "not_multiple_of":
        return `\u0631\u0642\u0645 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0643\u0648\u0646 \u0645\u0646 \u0645\u0636\u0627\u0639\u0641\u0627\u062A ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u0645\u0639\u0631\u0641${issue2.keys.length > 1 ? "\u0627\u062A" : ""} \u063A\u0631\u064A\u0628${issue2.keys.length > 1 ? "\u0629" : ""}: ${joinValues(issue2.keys, "\u060C ")}`;
      case "invalid_key":
        return `\u0645\u0639\u0631\u0641 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644 \u0641\u064A ${issue2.origin}`;
      case "invalid_union":
        return "\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644";
      case "invalid_element":
        return `\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644 \u0641\u064A ${issue2.origin}`;
      default:
        return "\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644";
    }
  };
};
function ar_default() {
  return {
    localeError: error()
  };
}

// node_modules/zod/v4/locales/az.js
var error2 = () => {
  const Sizable = {
    string: { unit: "simvol", verb: "olmal\u0131d\u0131r" },
    file: { unit: "bayt", verb: "olmal\u0131d\u0131r" },
    array: { unit: "element", verb: "olmal\u0131d\u0131r" },
    set: { unit: "element", verb: "olmal\u0131d\u0131r" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Yanl\u0131\u015F d\u0259y\u0259r: g\xF6zl\u0259nil\u0259n ${issue2.expected}, daxil olan ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Yanl\u0131\u015F d\u0259y\u0259r: g\xF6zl\u0259nil\u0259n ${stringifyPrimitive(issue2.values[0])}`;
        return `Yanl\u0131\u015F se\xE7im: a\u015Fa\u011F\u0131dak\u0131lardan biri olmal\u0131d\u0131r: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\xC7ox b\xF6y\xFCk: g\xF6zl\u0259nil\u0259n ${issue2.origin ?? "d\u0259y\u0259r"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "element"}`;
        return `\xC7ox b\xF6y\xFCk: g\xF6zl\u0259nil\u0259n ${issue2.origin ?? "d\u0259y\u0259r"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\xC7ox ki\xE7ik: g\xF6zl\u0259nil\u0259n ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        return `\xC7ox ki\xE7ik: g\xF6zl\u0259nil\u0259n ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Yanl\u0131\u015F m\u0259tn: "${_issue.prefix}" il\u0259 ba\u015Flamal\u0131d\u0131r`;
        if (_issue.format === "ends_with")
          return `Yanl\u0131\u015F m\u0259tn: "${_issue.suffix}" il\u0259 bitm\u0259lidir`;
        if (_issue.format === "includes")
          return `Yanl\u0131\u015F m\u0259tn: "${_issue.includes}" daxil olmal\u0131d\u0131r`;
        if (_issue.format === "regex")
          return `Yanl\u0131\u015F m\u0259tn: ${_issue.pattern} \u015Fablonuna uy\u011Fun olmal\u0131d\u0131r`;
        return `Yanl\u0131\u015F ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Yanl\u0131\u015F \u0259d\u0259d: ${issue2.divisor} il\u0259 b\xF6l\xFCn\u0259 bil\u0259n olmal\u0131d\u0131r`;
      case "unrecognized_keys":
        return `Tan\u0131nmayan a\xE7ar${issue2.keys.length > 1 ? "lar" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} daxilind\u0259 yanl\u0131\u015F a\xE7ar`;
      case "invalid_union":
        return "Yanl\u0131\u015F d\u0259y\u0259r";
      case "invalid_element":
        return `${issue2.origin} daxilind\u0259 yanl\u0131\u015F d\u0259y\u0259r`;
      default:
        return `Yanl\u0131\u015F d\u0259y\u0259r`;
    }
  };
};
function az_default() {
  return {
    localeError: error2()
  };
}

// node_modules/zod/v4/locales/be.js
function getBelarusianPlural(count, one, few, many) {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return many;
  }
  if (lastDigit === 1) {
    return one;
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }
  return many;
}
var error3 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "\u0441\u0456\u043C\u0432\u0430\u043B",
        few: "\u0441\u0456\u043C\u0432\u0430\u043B\u044B",
        many: "\u0441\u0456\u043C\u0432\u0430\u043B\u0430\u045E"
      },
      verb: "\u043C\u0435\u0446\u044C"
    },
    array: {
      unit: {
        one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442",
        few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B",
        many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430\u045E"
      },
      verb: "\u043C\u0435\u0446\u044C"
    },
    set: {
      unit: {
        one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442",
        few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B",
        many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430\u045E"
      },
      verb: "\u043C\u0435\u0446\u044C"
    },
    file: {
      unit: {
        one: "\u0431\u0430\u0439\u0442",
        few: "\u0431\u0430\u0439\u0442\u044B",
        many: "\u0431\u0430\u0439\u0442\u0430\u045E"
      },
      verb: "\u043C\u0435\u0446\u044C"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\u043B\u0456\u043A";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\u043C\u0430\u0441\u0456\u045E";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u0443\u0432\u043E\u0434",
    email: "email \u0430\u0434\u0440\u0430\u0441",
    url: "URL",
    emoji: "\u044D\u043C\u043E\u0434\u0437\u0456",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \u0434\u0430\u0442\u0430 \u0456 \u0447\u0430\u0441",
    date: "ISO \u0434\u0430\u0442\u0430",
    time: "ISO \u0447\u0430\u0441",
    duration: "ISO \u043F\u0440\u0430\u0446\u044F\u0433\u043B\u0430\u0441\u0446\u044C",
    ipv4: "IPv4 \u0430\u0434\u0440\u0430\u0441",
    ipv6: "IPv6 \u0430\u0434\u0440\u0430\u0441",
    cidrv4: "IPv4 \u0434\u044B\u044F\u043F\u0430\u0437\u043E\u043D",
    cidrv6: "IPv6 \u0434\u044B\u044F\u043F\u0430\u0437\u043E\u043D",
    base64: "\u0440\u0430\u0434\u043E\u043A \u0443 \u0444\u0430\u0440\u043C\u0430\u0446\u0435 base64",
    base64url: "\u0440\u0430\u0434\u043E\u043A \u0443 \u0444\u0430\u0440\u043C\u0430\u0446\u0435 base64url",
    json_string: "JSON \u0440\u0430\u0434\u043E\u043A",
    e164: "\u043D\u0443\u043C\u0430\u0440 E.164",
    jwt: "JWT",
    template_literal: "\u0443\u0432\u043E\u0434"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434: \u0447\u0430\u043A\u0430\u045E\u0441\u044F ${issue2.expected}, \u0430\u0442\u0440\u044B\u043C\u0430\u043D\u0430 ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F ${stringifyPrimitive(issue2.values[0])}`;
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0432\u0430\u0440\u044B\u044F\u043D\u0442: \u0447\u0430\u043A\u0430\u045E\u0441\u044F \u0430\u0434\u0437\u0456\u043D \u0437 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const maxValue = Number(issue2.maximum);
          const unit = getBelarusianPlural(maxValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u0432\u044F\u043B\u0456\u043A\u0456: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${issue2.origin ?? "\u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435"} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 ${sizing.verb} ${adj}${issue2.maximum.toString()} ${unit}`;
        }
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u0432\u044F\u043B\u0456\u043A\u0456: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${issue2.origin ?? "\u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435"} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 \u0431\u044B\u0446\u044C ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const minValue = Number(issue2.minimum);
          const unit = getBelarusianPlural(minValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u043C\u0430\u043B\u044B: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${issue2.origin} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 ${sizing.verb} ${adj}${issue2.minimum.toString()} ${unit}`;
        }
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u043C\u0430\u043B\u044B: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${issue2.origin} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 \u0431\u044B\u0446\u044C ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u043F\u0430\u0447\u044B\u043D\u0430\u0446\u0446\u0430 \u0437 "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0437\u0430\u043A\u0430\u043D\u0447\u0432\u0430\u0446\u0446\u0430 \u043D\u0430 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0437\u043C\u044F\u0448\u0447\u0430\u0446\u044C "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0430\u0434\u043F\u0430\u0432\u044F\u0434\u0430\u0446\u044C \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${_issue.pattern}`;
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u043B\u0456\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0431\u044B\u0446\u044C \u043A\u0440\u0430\u0442\u043D\u044B\u043C ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u0430\u0441\u043F\u0430\u0437\u043D\u0430\u043D\u044B ${issue2.keys.length > 1 ? "\u043A\u043B\u044E\u0447\u044B" : "\u043A\u043B\u044E\u0447"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u043A\u043B\u044E\u0447 \u0443 ${issue2.origin}`;
      case "invalid_union":
        return "\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434";
      case "invalid_element":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u0430\u0435 \u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435 \u045E ${issue2.origin}`;
      default:
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434`;
    }
  };
};
function be_default() {
  return {
    localeError: error3()
  };
}

// node_modules/zod/v4/locales/ca.js
var error4 = () => {
  const Sizable = {
    string: { unit: "car\xE0cters", verb: "contenir" },
    file: { unit: "bytes", verb: "contenir" },
    array: { unit: "elements", verb: "contenir" },
    set: { unit: "elements", verb: "contenir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrada",
    email: "adre\xE7a electr\xF2nica",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data i hora ISO",
    date: "data ISO",
    time: "hora ISO",
    duration: "durada ISO",
    ipv4: "adre\xE7a IPv4",
    ipv6: "adre\xE7a IPv6",
    cidrv4: "rang IPv4",
    cidrv6: "rang IPv6",
    base64: "cadena codificada en base64",
    base64url: "cadena codificada en base64url",
    json_string: "cadena JSON",
    e164: "n\xFAmero E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Tipus inv\xE0lid: s'esperava ${issue2.expected}, s'ha rebut ${parsedType7(issue2.input)}`;
      // return `Tipus invàlid: s'esperava ${issue.expected}, s'ha rebut ${util.getParsedType(issue.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Valor inv\xE0lid: s'esperava ${stringifyPrimitive(issue2.values[0])}`;
        return `Opci\xF3 inv\xE0lida: s'esperava una de ${joinValues(issue2.values, " o ")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "com a m\xE0xim" : "menys de";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Massa gran: s'esperava que ${issue2.origin ?? "el valor"} contingu\xE9s ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Massa gran: s'esperava que ${issue2.origin ?? "el valor"} fos ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "com a m\xEDnim" : "m\xE9s de";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Massa petit: s'esperava que ${issue2.origin} contingu\xE9s ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Massa petit: s'esperava que ${issue2.origin} fos ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Format inv\xE0lid: ha de comen\xE7ar amb "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Format inv\xE0lid: ha d'acabar amb "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Format inv\xE0lid: ha d'incloure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Format inv\xE0lid: ha de coincidir amb el patr\xF3 ${_issue.pattern}`;
        return `Format inv\xE0lid per a ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `N\xFAmero inv\xE0lid: ha de ser m\xFAltiple de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Clau${issue2.keys.length > 1 ? "s" : ""} no reconeguda${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Clau inv\xE0lida a ${issue2.origin}`;
      case "invalid_union":
        return "Entrada inv\xE0lida";
      // Could also be "Tipus d'unió invàlid" but "Entrada invàlida" is more general
      case "invalid_element":
        return `Element inv\xE0lid a ${issue2.origin}`;
      default:
        return `Entrada inv\xE0lida`;
    }
  };
};
function ca_default() {
  return {
    localeError: error4()
  };
}

// node_modules/zod/v4/locales/cs.js
var error5 = () => {
  const Sizable = {
    string: { unit: "znak\u016F", verb: "m\xEDt" },
    file: { unit: "bajt\u016F", verb: "m\xEDt" },
    array: { unit: "prvk\u016F", verb: "m\xEDt" },
    set: { unit: "prvk\u016F", verb: "m\xEDt" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\u010D\xEDslo";
      }
      case "string": {
        return "\u0159et\u011Bzec";
      }
      case "boolean": {
        return "boolean";
      }
      case "bigint": {
        return "bigint";
      }
      case "function": {
        return "funkce";
      }
      case "symbol": {
        return "symbol";
      }
      case "undefined": {
        return "undefined";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "pole";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "regul\xE1rn\xED v\xFDraz",
    email: "e-mailov\xE1 adresa",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "datum a \u010Das ve form\xE1tu ISO",
    date: "datum ve form\xE1tu ISO",
    time: "\u010Das ve form\xE1tu ISO",
    duration: "doba trv\xE1n\xED ISO",
    ipv4: "IPv4 adresa",
    ipv6: "IPv6 adresa",
    cidrv4: "rozsah IPv4",
    cidrv6: "rozsah IPv6",
    base64: "\u0159et\u011Bzec zak\xF3dovan\xFD ve form\xE1tu base64",
    base64url: "\u0159et\u011Bzec zak\xF3dovan\xFD ve form\xE1tu base64url",
    json_string: "\u0159et\u011Bzec ve form\xE1tu JSON",
    e164: "\u010D\xEDslo E.164",
    jwt: "JWT",
    template_literal: "vstup"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Neplatn\xFD vstup: o\u010Dek\xE1v\xE1no ${issue2.expected}, obdr\u017Eeno ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Neplatn\xFD vstup: o\u010Dek\xE1v\xE1no ${stringifyPrimitive(issue2.values[0])}`;
        return `Neplatn\xE1 mo\u017Enost: o\u010Dek\xE1v\xE1na jedna z hodnot ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Hodnota je p\u0159\xEDli\u0161 velk\xE1: ${issue2.origin ?? "hodnota"} mus\xED m\xEDt ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "prvk\u016F"}`;
        }
        return `Hodnota je p\u0159\xEDli\u0161 velk\xE1: ${issue2.origin ?? "hodnota"} mus\xED b\xFDt ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Hodnota je p\u0159\xEDli\u0161 mal\xE1: ${issue2.origin ?? "hodnota"} mus\xED m\xEDt ${adj}${issue2.minimum.toString()} ${sizing.unit ?? "prvk\u016F"}`;
        }
        return `Hodnota je p\u0159\xEDli\u0161 mal\xE1: ${issue2.origin ?? "hodnota"} mus\xED b\xFDt ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Neplatn\xFD \u0159et\u011Bzec: mus\xED za\u010D\xEDnat na "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Neplatn\xFD \u0159et\u011Bzec: mus\xED kon\u010Dit na "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Neplatn\xFD \u0159et\u011Bzec: mus\xED obsahovat "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Neplatn\xFD \u0159et\u011Bzec: mus\xED odpov\xEDdat vzoru ${_issue.pattern}`;
        return `Neplatn\xFD form\xE1t ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Neplatn\xE9 \u010D\xEDslo: mus\xED b\xFDt n\xE1sobkem ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Nezn\xE1m\xE9 kl\xED\u010De: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Neplatn\xFD kl\xED\u010D v ${issue2.origin}`;
      case "invalid_union":
        return "Neplatn\xFD vstup";
      case "invalid_element":
        return `Neplatn\xE1 hodnota v ${issue2.origin}`;
      default:
        return `Neplatn\xFD vstup`;
    }
  };
};
function cs_default() {
  return {
    localeError: error5()
  };
}

// node_modules/zod/v4/locales/da.js
var error6 = () => {
  const Sizable = {
    string: { unit: "tegn", verb: "havde" },
    file: { unit: "bytes", verb: "havde" },
    array: { unit: "elementer", verb: "indeholdt" },
    set: { unit: "elementer", verb: "indeholdt" }
  };
  const TypeNames = {
    string: "streng",
    number: "tal",
    boolean: "boolean",
    array: "liste",
    object: "objekt",
    set: "s\xE6t",
    file: "fil"
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  function getTypeName(type) {
    return TypeNames[type] ?? type;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "tal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "liste";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
        return "objekt";
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "e-mailadresse",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dato- og klokkesl\xE6t",
    date: "ISO-dato",
    time: "ISO-klokkesl\xE6t",
    duration: "ISO-varighed",
    ipv4: "IPv4-omr\xE5de",
    ipv6: "IPv6-omr\xE5de",
    cidrv4: "IPv4-spektrum",
    cidrv6: "IPv6-spektrum",
    base64: "base64-kodet streng",
    base64url: "base64url-kodet streng",
    json_string: "JSON-streng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ugyldigt input: forventede ${getTypeName(issue2.expected)}, fik ${getTypeName(parsedType7(issue2.input))}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ugyldig v\xE6rdi: forventede ${stringifyPrimitive(issue2.values[0])}`;
        return `Ugyldigt valg: forventede en af f\xF8lgende ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing)
          return `For stor: forventede ${origin ?? "value"} ${sizing.verb} ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "elementer"}`;
        return `For stor: forventede ${origin ?? "value"} havde ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing) {
          return `For lille: forventede ${origin} ${sizing.verb} ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `For lille: forventede ${origin} havde ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ugyldig streng: skal starte med "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ugyldig streng: skal ende med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ugyldig streng: skal indeholde "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ugyldig streng: skal matche m\xF8nsteret ${_issue.pattern}`;
        return `Ugyldig ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ugyldigt tal: skal v\xE6re deleligt med ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Ukendte n\xF8gler" : "Ukendt n\xF8gle"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ugyldig n\xF8gle i ${issue2.origin}`;
      case "invalid_union":
        return "Ugyldigt input: matcher ingen af de tilladte typer";
      case "invalid_element":
        return `Ugyldig v\xE6rdi i ${issue2.origin}`;
      default:
        return `Ugyldigt input`;
    }
  };
};
function da_default() {
  return {
    localeError: error6()
  };
}

// node_modules/zod/v4/locales/de.js
var error7 = () => {
  const Sizable = {
    string: { unit: "Zeichen", verb: "zu haben" },
    file: { unit: "Bytes", verb: "zu haben" },
    array: { unit: "Elemente", verb: "zu haben" },
    set: { unit: "Elemente", verb: "zu haben" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "Zahl";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "Array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "Eingabe",
    email: "E-Mail-Adresse",
    url: "URL",
    emoji: "Emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-Datum und -Uhrzeit",
    date: "ISO-Datum",
    time: "ISO-Uhrzeit",
    duration: "ISO-Dauer",
    ipv4: "IPv4-Adresse",
    ipv6: "IPv6-Adresse",
    cidrv4: "IPv4-Bereich",
    cidrv6: "IPv6-Bereich",
    base64: "Base64-codierter String",
    base64url: "Base64-URL-codierter String",
    json_string: "JSON-String",
    e164: "E.164-Nummer",
    jwt: "JWT",
    template_literal: "Eingabe"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ung\xFCltige Eingabe: erwartet ${issue2.expected}, erhalten ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ung\xFCltige Eingabe: erwartet ${stringifyPrimitive(issue2.values[0])}`;
        return `Ung\xFCltige Option: erwartet eine von ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Zu gro\xDF: erwartet, dass ${issue2.origin ?? "Wert"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "Elemente"} hat`;
        return `Zu gro\xDF: erwartet, dass ${issue2.origin ?? "Wert"} ${adj}${issue2.maximum.toString()} ist`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Zu klein: erwartet, dass ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} hat`;
        }
        return `Zu klein: erwartet, dass ${issue2.origin} ${adj}${issue2.minimum.toString()} ist`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ung\xFCltiger String: muss mit "${_issue.prefix}" beginnen`;
        if (_issue.format === "ends_with")
          return `Ung\xFCltiger String: muss mit "${_issue.suffix}" enden`;
        if (_issue.format === "includes")
          return `Ung\xFCltiger String: muss "${_issue.includes}" enthalten`;
        if (_issue.format === "regex")
          return `Ung\xFCltiger String: muss dem Muster ${_issue.pattern} entsprechen`;
        return `Ung\xFCltig: ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ung\xFCltige Zahl: muss ein Vielfaches von ${issue2.divisor} sein`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Unbekannte Schl\xFCssel" : "Unbekannter Schl\xFCssel"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ung\xFCltiger Schl\xFCssel in ${issue2.origin}`;
      case "invalid_union":
        return "Ung\xFCltige Eingabe";
      case "invalid_element":
        return `Ung\xFCltiger Wert in ${issue2.origin}`;
      default:
        return `Ung\xFCltige Eingabe`;
    }
  };
};
function de_default() {
  return {
    localeError: error7()
  };
}

// node_modules/zod/v4/locales/en.js
var parsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "number";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error8 = () => {
  const Sizable = {
    string: { unit: "characters", verb: "to have" },
    file: { unit: "bytes", verb: "to have" },
    array: { unit: "items", verb: "to have" },
    set: { unit: "items", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Invalid input: expected ${issue2.expected}, received ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue2.values[0])}`;
        return `Invalid option: expected one of ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Too big: expected ${issue2.origin ?? "value"} to have ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Too big: expected ${issue2.origin ?? "value"} to be ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Too small: expected ${issue2.origin} to have ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Too small: expected ${issue2.origin} to be ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Invalid string: must start with "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Invalid string: must end with "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Invalid string: must include "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Invalid string: must match pattern ${_issue.pattern}`;
        return `Invalid ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${issue2.origin}`;
      case "invalid_union":
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${issue2.origin}`;
      default:
        return `Invalid input`;
    }
  };
};
function en_default() {
  return {
    localeError: error8()
  };
}

// node_modules/zod/v4/locales/eo.js
var parsedType2 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "nombro";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "tabelo";
      }
      if (data === null) {
        return "senvalora";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error9 = () => {
  const Sizable = {
    string: { unit: "karaktrojn", verb: "havi" },
    file: { unit: "bajtojn", verb: "havi" },
    array: { unit: "elementojn", verb: "havi" },
    set: { unit: "elementojn", verb: "havi" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "enigo",
    email: "retadreso",
    url: "URL",
    emoji: "emo\u011Dio",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-datotempo",
    date: "ISO-dato",
    time: "ISO-tempo",
    duration: "ISO-da\u016Dro",
    ipv4: "IPv4-adreso",
    ipv6: "IPv6-adreso",
    cidrv4: "IPv4-rango",
    cidrv6: "IPv6-rango",
    base64: "64-ume kodita karaktraro",
    base64url: "URL-64-ume kodita karaktraro",
    json_string: "JSON-karaktraro",
    e164: "E.164-nombro",
    jwt: "JWT",
    template_literal: "enigo"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Nevalida enigo: atendi\u011Dis ${issue2.expected}, ricevi\u011Dis ${parsedType2(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Nevalida enigo: atendi\u011Dis ${stringifyPrimitive(issue2.values[0])}`;
        return `Nevalida opcio: atendi\u011Dis unu el ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Tro granda: atendi\u011Dis ke ${issue2.origin ?? "valoro"} havu ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementojn"}`;
        return `Tro granda: atendi\u011Dis ke ${issue2.origin ?? "valoro"} havu ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Tro malgranda: atendi\u011Dis ke ${issue2.origin} havu ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Tro malgranda: atendi\u011Dis ke ${issue2.origin} estu ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Nevalida karaktraro: devas komenci\u011Di per "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Nevalida karaktraro: devas fini\u011Di per "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Nevalida karaktraro: devas inkluzivi "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Nevalida karaktraro: devas kongrui kun la modelo ${_issue.pattern}`;
        return `Nevalida ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Nevalida nombro: devas esti oblo de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Nekonata${issue2.keys.length > 1 ? "j" : ""} \u015Dlosilo${issue2.keys.length > 1 ? "j" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Nevalida \u015Dlosilo en ${issue2.origin}`;
      case "invalid_union":
        return "Nevalida enigo";
      case "invalid_element":
        return `Nevalida valoro en ${issue2.origin}`;
      default:
        return `Nevalida enigo`;
    }
  };
};
function eo_default() {
  return {
    localeError: error9()
  };
}

// node_modules/zod/v4/locales/es.js
var error10 = () => {
  const Sizable = {
    string: { unit: "caracteres", verb: "tener" },
    file: { unit: "bytes", verb: "tener" },
    array: { unit: "elementos", verb: "tener" },
    set: { unit: "elementos", verb: "tener" }
  };
  const TypeNames = {
    string: "texto",
    number: "n\xFAmero",
    boolean: "booleano",
    array: "arreglo",
    object: "objeto",
    set: "conjunto",
    file: "archivo",
    date: "fecha",
    bigint: "n\xFAmero grande",
    symbol: "s\xEDmbolo",
    undefined: "indefinido",
    null: "nulo",
    function: "funci\xF3n",
    map: "mapa",
    record: "registro",
    tuple: "tupla",
    enum: "enumeraci\xF3n",
    union: "uni\xF3n",
    literal: "literal",
    promise: "promesa",
    void: "vac\xEDo",
    never: "nunca",
    unknown: "desconocido",
    any: "cualquiera"
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  function getTypeName(type) {
    return TypeNames[type] ?? type;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype) {
          return data.constructor.name;
        }
        return "object";
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrada",
    email: "direcci\xF3n de correo electr\xF3nico",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "fecha y hora ISO",
    date: "fecha ISO",
    time: "hora ISO",
    duration: "duraci\xF3n ISO",
    ipv4: "direcci\xF3n IPv4",
    ipv6: "direcci\xF3n IPv6",
    cidrv4: "rango IPv4",
    cidrv6: "rango IPv6",
    base64: "cadena codificada en base64",
    base64url: "URL codificada en base64",
    json_string: "cadena JSON",
    e164: "n\xFAmero E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Entrada inv\xE1lida: se esperaba ${getTypeName(issue2.expected)}, recibido ${getTypeName(parsedType7(issue2.input))}`;
      // return `Entrada inválida: se esperaba ${issue.expected}, recibido ${util.getParsedType(issue.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entrada inv\xE1lida: se esperaba ${stringifyPrimitive(issue2.values[0])}`;
        return `Opci\xF3n inv\xE1lida: se esperaba una de ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing)
          return `Demasiado grande: se esperaba que ${origin ?? "valor"} tuviera ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementos"}`;
        return `Demasiado grande: se esperaba que ${origin ?? "valor"} fuera ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing) {
          return `Demasiado peque\xF1o: se esperaba que ${origin} tuviera ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Demasiado peque\xF1o: se esperaba que ${origin} fuera ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Cadena inv\xE1lida: debe comenzar con "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Cadena inv\xE1lida: debe terminar en "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Cadena inv\xE1lida: debe incluir "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Cadena inv\xE1lida: debe coincidir con el patr\xF3n ${_issue.pattern}`;
        return `Inv\xE1lido ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `N\xFAmero inv\xE1lido: debe ser m\xFAltiplo de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Llave${issue2.keys.length > 1 ? "s" : ""} desconocida${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Llave inv\xE1lida en ${getTypeName(issue2.origin)}`;
      case "invalid_union":
        return "Entrada inv\xE1lida";
      case "invalid_element":
        return `Valor inv\xE1lido en ${getTypeName(issue2.origin)}`;
      default:
        return `Entrada inv\xE1lida`;
    }
  };
};
function es_default() {
  return {
    localeError: error10()
  };
}

// node_modules/zod/v4/locales/fa.js
var error11 = () => {
  const Sizable = {
    string: { unit: "\u06A9\u0627\u0631\u0627\u06A9\u062A\u0631", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" },
    file: { unit: "\u0628\u0627\u06CC\u062A", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" },
    array: { unit: "\u0622\u06CC\u062A\u0645", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" },
    set: { unit: "\u0622\u06CC\u062A\u0645", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\u0639\u062F\u062F";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\u0622\u0631\u0627\u06CC\u0647";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u0648\u0631\u0648\u062F\u06CC",
    email: "\u0622\u062F\u0631\u0633 \u0627\u06CC\u0645\u06CC\u0644",
    url: "URL",
    emoji: "\u0627\u06CC\u0645\u0648\u062C\u06CC",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u062A\u0627\u0631\u06CC\u062E \u0648 \u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648",
    date: "\u062A\u0627\u0631\u06CC\u062E \u0627\u06CC\u0632\u0648",
    time: "\u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648",
    duration: "\u0645\u062F\u062A \u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648",
    ipv4: "IPv4 \u0622\u062F\u0631\u0633",
    ipv6: "IPv6 \u0622\u062F\u0631\u0633",
    cidrv4: "IPv4 \u062F\u0627\u0645\u0646\u0647",
    cidrv6: "IPv6 \u062F\u0627\u0645\u0646\u0647",
    base64: "base64-encoded \u0631\u0634\u062A\u0647",
    base64url: "base64url-encoded \u0631\u0634\u062A\u0647",
    json_string: "JSON \u0631\u0634\u062A\u0647",
    e164: "E.164 \u0639\u062F\u062F",
    jwt: "JWT",
    template_literal: "\u0648\u0631\u0648\u062F\u06CC"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A ${issue2.expected} \u0645\u06CC\u200C\u0628\u0648\u062F\u060C ${parsedType7(issue2.input)} \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F`;
      case "invalid_value":
        if (issue2.values.length === 1) {
          return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A ${stringifyPrimitive(issue2.values[0])} \u0645\u06CC\u200C\u0628\u0648\u062F`;
        }
        return `\u06AF\u0632\u06CC\u0646\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A \u06CC\u06A9\u06CC \u0627\u0632 ${joinValues(issue2.values, "|")} \u0645\u06CC\u200C\u0628\u0648\u062F`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u062E\u06CC\u0644\u06CC \u0628\u0632\u0631\u06AF: ${issue2.origin ?? "\u0645\u0642\u062F\u0627\u0631"} \u0628\u0627\u06CC\u062F ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0639\u0646\u0635\u0631"} \u0628\u0627\u0634\u062F`;
        }
        return `\u062E\u06CC\u0644\u06CC \u0628\u0632\u0631\u06AF: ${issue2.origin ?? "\u0645\u0642\u062F\u0627\u0631"} \u0628\u0627\u06CC\u062F ${adj}${issue2.maximum.toString()} \u0628\u0627\u0634\u062F`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u062E\u06CC\u0644\u06CC \u06A9\u0648\u0686\u06A9: ${issue2.origin} \u0628\u0627\u06CC\u062F ${adj}${issue2.minimum.toString()} ${sizing.unit} \u0628\u0627\u0634\u062F`;
        }
        return `\u062E\u06CC\u0644\u06CC \u06A9\u0648\u0686\u06A9: ${issue2.origin} \u0628\u0627\u06CC\u062F ${adj}${issue2.minimum.toString()} \u0628\u0627\u0634\u062F`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 "${_issue.prefix}" \u0634\u0631\u0648\u0639 \u0634\u0648\u062F`;
        }
        if (_issue.format === "ends_with") {
          return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 "${_issue.suffix}" \u062A\u0645\u0627\u0645 \u0634\u0648\u062F`;
        }
        if (_issue.format === "includes") {
          return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0634\u0627\u0645\u0644 "${_issue.includes}" \u0628\u0627\u0634\u062F`;
        }
        if (_issue.format === "regex") {
          return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 \u0627\u0644\u06AF\u0648\u06CC ${_issue.pattern} \u0645\u0637\u0627\u0628\u0642\u062A \u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F`;
        }
        return `${Nouns[_issue.format] ?? issue2.format} \u0646\u0627\u0645\u0639\u062A\u0628\u0631`;
      }
      case "not_multiple_of":
        return `\u0639\u062F\u062F \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0645\u0636\u0631\u0628 ${issue2.divisor} \u0628\u0627\u0634\u062F`;
      case "unrecognized_keys":
        return `\u06A9\u0644\u06CC\u062F${issue2.keys.length > 1 ? "\u0647\u0627\u06CC" : ""} \u0646\u0627\u0634\u0646\u0627\u0633: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u06A9\u0644\u06CC\u062F \u0646\u0627\u0634\u0646\u0627\u0633 \u062F\u0631 ${issue2.origin}`;
      case "invalid_union":
        return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631`;
      case "invalid_element":
        return `\u0645\u0642\u062F\u0627\u0631 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u062F\u0631 ${issue2.origin}`;
      default:
        return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631`;
    }
  };
};
function fa_default() {
  return {
    localeError: error11()
  };
}

// node_modules/zod/v4/locales/fi.js
var error12 = () => {
  const Sizable = {
    string: { unit: "merkki\xE4", subject: "merkkijonon" },
    file: { unit: "tavua", subject: "tiedoston" },
    array: { unit: "alkiota", subject: "listan" },
    set: { unit: "alkiota", subject: "joukon" },
    number: { unit: "", subject: "luvun" },
    bigint: { unit: "", subject: "suuren kokonaisluvun" },
    int: { unit: "", subject: "kokonaisluvun" },
    date: { unit: "", subject: "p\xE4iv\xE4m\xE4\xE4r\xE4n" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "s\xE4\xE4nn\xF6llinen lauseke",
    email: "s\xE4hk\xF6postiosoite",
    url: "URL-osoite",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-aikaleima",
    date: "ISO-p\xE4iv\xE4m\xE4\xE4r\xE4",
    time: "ISO-aika",
    duration: "ISO-kesto",
    ipv4: "IPv4-osoite",
    ipv6: "IPv6-osoite",
    cidrv4: "IPv4-alue",
    cidrv6: "IPv6-alue",
    base64: "base64-koodattu merkkijono",
    base64url: "base64url-koodattu merkkijono",
    json_string: "JSON-merkkijono",
    e164: "E.164-luku",
    jwt: "JWT",
    template_literal: "templaattimerkkijono"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Virheellinen tyyppi: odotettiin ${issue2.expected}, oli ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Virheellinen sy\xF6te: t\xE4ytyy olla ${stringifyPrimitive(issue2.values[0])}`;
        return `Virheellinen valinta: t\xE4ytyy olla yksi seuraavista: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Liian suuri: ${sizing.subject} t\xE4ytyy olla ${adj}${issue2.maximum.toString()} ${sizing.unit}`.trim();
        }
        return `Liian suuri: arvon t\xE4ytyy olla ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Liian pieni: ${sizing.subject} t\xE4ytyy olla ${adj}${issue2.minimum.toString()} ${sizing.unit}`.trim();
        }
        return `Liian pieni: arvon t\xE4ytyy olla ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Virheellinen sy\xF6te: t\xE4ytyy alkaa "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Virheellinen sy\xF6te: t\xE4ytyy loppua "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Virheellinen sy\xF6te: t\xE4ytyy sis\xE4lt\xE4\xE4 "${_issue.includes}"`;
        if (_issue.format === "regex") {
          return `Virheellinen sy\xF6te: t\xE4ytyy vastata s\xE4\xE4nn\xF6llist\xE4 lauseketta ${_issue.pattern}`;
        }
        return `Virheellinen ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Virheellinen luku: t\xE4ytyy olla luvun ${issue2.divisor} monikerta`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Tuntemattomat avaimet" : "Tuntematon avain"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return "Virheellinen avain tietueessa";
      case "invalid_union":
        return "Virheellinen unioni";
      case "invalid_element":
        return "Virheellinen arvo joukossa";
      default:
        return `Virheellinen sy\xF6te`;
    }
  };
};
function fi_default() {
  return {
    localeError: error12()
  };
}

// node_modules/zod/v4/locales/fr.js
var error13 = () => {
  const Sizable = {
    string: { unit: "caract\xE8res", verb: "avoir" },
    file: { unit: "octets", verb: "avoir" },
    array: { unit: "\xE9l\xE9ments", verb: "avoir" },
    set: { unit: "\xE9l\xE9ments", verb: "avoir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nombre";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tableau";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entr\xE9e",
    email: "adresse e-mail",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "date et heure ISO",
    date: "date ISO",
    time: "heure ISO",
    duration: "dur\xE9e ISO",
    ipv4: "adresse IPv4",
    ipv6: "adresse IPv6",
    cidrv4: "plage IPv4",
    cidrv6: "plage IPv6",
    base64: "cha\xEEne encod\xE9e en base64",
    base64url: "cha\xEEne encod\xE9e en base64url",
    json_string: "cha\xEEne JSON",
    e164: "num\xE9ro E.164",
    jwt: "JWT",
    template_literal: "entr\xE9e"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Entr\xE9e invalide : ${issue2.expected} attendu, ${parsedType7(issue2.input)} re\xE7u`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entr\xE9e invalide : ${stringifyPrimitive(issue2.values[0])} attendu`;
        return `Option invalide : une valeur parmi ${joinValues(issue2.values, "|")} attendue`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Trop grand : ${issue2.origin ?? "valeur"} doit ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\xE9l\xE9ment(s)"}`;
        return `Trop grand : ${issue2.origin ?? "valeur"} doit \xEAtre ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Trop petit : ${issue2.origin} doit ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Trop petit : ${issue2.origin} doit \xEAtre ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Cha\xEEne invalide : doit commencer par "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Cha\xEEne invalide : doit se terminer par "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Cha\xEEne invalide : doit inclure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Cha\xEEne invalide : doit correspondre au mod\xE8le ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit \xEAtre un multiple de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Cl\xE9${issue2.keys.length > 1 ? "s" : ""} non reconnue${issue2.keys.length > 1 ? "s" : ""} : ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Cl\xE9 invalide dans ${issue2.origin}`;
      case "invalid_union":
        return "Entr\xE9e invalide";
      case "invalid_element":
        return `Valeur invalide dans ${issue2.origin}`;
      default:
        return `Entr\xE9e invalide`;
    }
  };
};
function fr_default() {
  return {
    localeError: error13()
  };
}

// node_modules/zod/v4/locales/fr-CA.js
var error14 = () => {
  const Sizable = {
    string: { unit: "caract\xE8res", verb: "avoir" },
    file: { unit: "octets", verb: "avoir" },
    array: { unit: "\xE9l\xE9ments", verb: "avoir" },
    set: { unit: "\xE9l\xE9ments", verb: "avoir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entr\xE9e",
    email: "adresse courriel",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "date-heure ISO",
    date: "date ISO",
    time: "heure ISO",
    duration: "dur\xE9e ISO",
    ipv4: "adresse IPv4",
    ipv6: "adresse IPv6",
    cidrv4: "plage IPv4",
    cidrv6: "plage IPv6",
    base64: "cha\xEEne encod\xE9e en base64",
    base64url: "cha\xEEne encod\xE9e en base64url",
    json_string: "cha\xEEne JSON",
    e164: "num\xE9ro E.164",
    jwt: "JWT",
    template_literal: "entr\xE9e"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Entr\xE9e invalide : attendu ${issue2.expected}, re\xE7u ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entr\xE9e invalide : attendu ${stringifyPrimitive(issue2.values[0])}`;
        return `Option invalide : attendu l'une des valeurs suivantes ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "\u2264" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Trop grand : attendu que ${issue2.origin ?? "la valeur"} ait ${adj}${issue2.maximum.toString()} ${sizing.unit}`;
        return `Trop grand : attendu que ${issue2.origin ?? "la valeur"} soit ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "\u2265" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Trop petit : attendu que ${issue2.origin} ait ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Trop petit : attendu que ${issue2.origin} soit ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Cha\xEEne invalide : doit commencer par "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Cha\xEEne invalide : doit se terminer par "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Cha\xEEne invalide : doit inclure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Cha\xEEne invalide : doit correspondre au motif ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit \xEAtre un multiple de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Cl\xE9${issue2.keys.length > 1 ? "s" : ""} non reconnue${issue2.keys.length > 1 ? "s" : ""} : ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Cl\xE9 invalide dans ${issue2.origin}`;
      case "invalid_union":
        return "Entr\xE9e invalide";
      case "invalid_element":
        return `Valeur invalide dans ${issue2.origin}`;
      default:
        return `Entr\xE9e invalide`;
    }
  };
};
function fr_CA_default() {
  return {
    localeError: error14()
  };
}

// node_modules/zod/v4/locales/he.js
var error15 = () => {
  const Sizable = {
    string: { unit: "\u05D0\u05D5\u05EA\u05D9\u05D5\u05EA", verb: "\u05DC\u05DB\u05DC\u05D5\u05DC" },
    file: { unit: "\u05D1\u05D9\u05D9\u05D8\u05D9\u05DD", verb: "\u05DC\u05DB\u05DC\u05D5\u05DC" },
    array: { unit: "\u05E4\u05E8\u05D9\u05D8\u05D9\u05DD", verb: "\u05DC\u05DB\u05DC\u05D5\u05DC" },
    set: { unit: "\u05E4\u05E8\u05D9\u05D8\u05D9\u05DD", verb: "\u05DC\u05DB\u05DC\u05D5\u05DC" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u05E7\u05DC\u05D8",
    email: "\u05DB\u05EA\u05D5\u05D1\u05EA \u05D0\u05D9\u05DE\u05D9\u05D9\u05DC",
    url: "\u05DB\u05EA\u05D5\u05D1\u05EA \u05E8\u05E9\u05EA",
    emoji: "\u05D0\u05D9\u05DE\u05D5\u05D2'\u05D9",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u05EA\u05D0\u05E8\u05D9\u05DA \u05D5\u05D6\u05DE\u05DF ISO",
    date: "\u05EA\u05D0\u05E8\u05D9\u05DA ISO",
    time: "\u05D6\u05DE\u05DF ISO",
    duration: "\u05DE\u05E9\u05DA \u05D6\u05DE\u05DF ISO",
    ipv4: "\u05DB\u05EA\u05D5\u05D1\u05EA IPv4",
    ipv6: "\u05DB\u05EA\u05D5\u05D1\u05EA IPv6",
    cidrv4: "\u05D8\u05D5\u05D5\u05D7 IPv4",
    cidrv6: "\u05D8\u05D5\u05D5\u05D7 IPv6",
    base64: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D1\u05D1\u05E1\u05D9\u05E1 64",
    base64url: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D1\u05D1\u05E1\u05D9\u05E1 64 \u05DC\u05DB\u05EA\u05D5\u05D1\u05D5\u05EA \u05E8\u05E9\u05EA",
    json_string: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA JSON",
    e164: "\u05DE\u05E1\u05E4\u05E8 E.164",
    jwt: "JWT",
    template_literal: "\u05E7\u05DC\u05D8"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA ${issue2.expected}, \u05D4\u05EA\u05E7\u05D1\u05DC ${parsedType7(issue2.input)}`;
      // return `Invalid input: expected ${issue.expected}, received ${util.getParsedType(issue.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA ${stringifyPrimitive(issue2.values[0])}`;
        return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA \u05D0\u05D7\u05EA \u05DE\u05D4\u05D0\u05E4\u05E9\u05E8\u05D5\u05D9\u05D5\u05EA  ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u05D2\u05D3\u05D5\u05DC \u05DE\u05D3\u05D9: ${issue2.origin ?? "value"} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `\u05D2\u05D3\u05D5\u05DC \u05DE\u05D3\u05D9: ${issue2.origin ?? "value"} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u05E7\u05D8\u05DF \u05DE\u05D3\u05D9: ${issue2.origin} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u05E7\u05D8\u05DF \u05DE\u05D3\u05D9: ${issue2.origin} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05E0\u05D4: \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05EA\u05D7\u05D9\u05DC \u05D1"${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05E0\u05D4: \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05E1\u05EA\u05D9\u05D9\u05DD \u05D1 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05E0\u05D4: \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05DB\u05DC\u05D5\u05DC "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05E0\u05D4: \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05EA\u05D0\u05D9\u05DD \u05DC\u05EA\u05D1\u05E0\u05D9\u05EA ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF`;
      }
      case "not_multiple_of":
        return `\u05DE\u05E1\u05E4\u05E8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05D7\u05D9\u05D9\u05D1 \u05DC\u05D4\u05D9\u05D5\u05EA \u05DE\u05DB\u05E4\u05DC\u05D4 \u05E9\u05DC ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u05DE\u05E4\u05EA\u05D7${issue2.keys.length > 1 ? "\u05D5\u05EA" : ""} \u05DC\u05D0 \u05DE\u05D6\u05D5\u05D4${issue2.keys.length > 1 ? "\u05D9\u05DD" : "\u05D4"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u05DE\u05E4\u05EA\u05D7 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF \u05D1${issue2.origin}`;
      case "invalid_union":
        return "\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF";
      case "invalid_element":
        return `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF \u05D1${issue2.origin}`;
      default:
        return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF`;
    }
  };
};
function he_default() {
  return {
    localeError: error15()
  };
}

// node_modules/zod/v4/locales/hu.js
var error16 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "legyen" },
    file: { unit: "byte", verb: "legyen" },
    array: { unit: "elem", verb: "legyen" },
    set: { unit: "elem", verb: "legyen" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "sz\xE1m";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "t\xF6mb";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "bemenet",
    email: "email c\xEDm",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO id\u0151b\xE9lyeg",
    date: "ISO d\xE1tum",
    time: "ISO id\u0151",
    duration: "ISO id\u0151intervallum",
    ipv4: "IPv4 c\xEDm",
    ipv6: "IPv6 c\xEDm",
    cidrv4: "IPv4 tartom\xE1ny",
    cidrv6: "IPv6 tartom\xE1ny",
    base64: "base64-k\xF3dolt string",
    base64url: "base64url-k\xF3dolt string",
    json_string: "JSON string",
    e164: "E.164 sz\xE1m",
    jwt: "JWT",
    template_literal: "bemenet"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\xC9rv\xE9nytelen bemenet: a v\xE1rt \xE9rt\xE9k ${issue2.expected}, a kapott \xE9rt\xE9k ${parsedType7(issue2.input)}`;
      // return `Invalid input: expected ${issue.expected}, received ${util.getParsedType(issue.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\xC9rv\xE9nytelen bemenet: a v\xE1rt \xE9rt\xE9k ${stringifyPrimitive(issue2.values[0])}`;
        return `\xC9rv\xE9nytelen opci\xF3: valamelyik \xE9rt\xE9k v\xE1rt ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `T\xFAl nagy: ${issue2.origin ?? "\xE9rt\xE9k"} m\xE9rete t\xFAl nagy ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elem"}`;
        return `T\xFAl nagy: a bemeneti \xE9rt\xE9k ${issue2.origin ?? "\xE9rt\xE9k"} t\xFAl nagy: ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `T\xFAl kicsi: a bemeneti \xE9rt\xE9k ${issue2.origin} m\xE9rete t\xFAl kicsi ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `T\xFAl kicsi: a bemeneti \xE9rt\xE9k ${issue2.origin} t\xFAl kicsi ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\xC9rv\xE9nytelen string: "${_issue.prefix}" \xE9rt\xE9kkel kell kezd\u0151dnie`;
        if (_issue.format === "ends_with")
          return `\xC9rv\xE9nytelen string: "${_issue.suffix}" \xE9rt\xE9kkel kell v\xE9gz\u0151dnie`;
        if (_issue.format === "includes")
          return `\xC9rv\xE9nytelen string: "${_issue.includes}" \xE9rt\xE9ket kell tartalmaznia`;
        if (_issue.format === "regex")
          return `\xC9rv\xE9nytelen string: ${_issue.pattern} mint\xE1nak kell megfelelnie`;
        return `\xC9rv\xE9nytelen ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\xC9rv\xE9nytelen sz\xE1m: ${issue2.divisor} t\xF6bbsz\xF6r\xF6s\xE9nek kell lennie`;
      case "unrecognized_keys":
        return `Ismeretlen kulcs${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\xC9rv\xE9nytelen kulcs ${issue2.origin}`;
      case "invalid_union":
        return "\xC9rv\xE9nytelen bemenet";
      case "invalid_element":
        return `\xC9rv\xE9nytelen \xE9rt\xE9k: ${issue2.origin}`;
      default:
        return `\xC9rv\xE9nytelen bemenet`;
    }
  };
};
function hu_default() {
  return {
    localeError: error16()
  };
}

// node_modules/zod/v4/locales/id.js
var error17 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "memiliki" },
    file: { unit: "byte", verb: "memiliki" },
    array: { unit: "item", verb: "memiliki" },
    set: { unit: "item", verb: "memiliki" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "alamat email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "tanggal dan waktu format ISO",
    date: "tanggal format ISO",
    time: "jam format ISO",
    duration: "durasi format ISO",
    ipv4: "alamat IPv4",
    ipv6: "alamat IPv6",
    cidrv4: "rentang alamat IPv4",
    cidrv6: "rentang alamat IPv6",
    base64: "string dengan enkode base64",
    base64url: "string dengan enkode base64url",
    json_string: "string JSON",
    e164: "angka E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Input tidak valid: diharapkan ${issue2.expected}, diterima ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Input tidak valid: diharapkan ${stringifyPrimitive(issue2.values[0])}`;
        return `Pilihan tidak valid: diharapkan salah satu dari ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Terlalu besar: diharapkan ${issue2.origin ?? "value"} memiliki ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elemen"}`;
        return `Terlalu besar: diharapkan ${issue2.origin ?? "value"} menjadi ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Terlalu kecil: diharapkan ${issue2.origin} memiliki ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Terlalu kecil: diharapkan ${issue2.origin} menjadi ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `String tidak valid: harus dimulai dengan "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `String tidak valid: harus berakhir dengan "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `String tidak valid: harus menyertakan "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `String tidak valid: harus sesuai pola ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} tidak valid`;
      }
      case "not_multiple_of":
        return `Angka tidak valid: harus kelipatan dari ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali ${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak valid di ${issue2.origin}`;
      case "invalid_union":
        return "Input tidak valid";
      case "invalid_element":
        return `Nilai tidak valid di ${issue2.origin}`;
      default:
        return `Input tidak valid`;
    }
  };
};
function id_default() {
  return {
    localeError: error17()
  };
}

// node_modules/zod/v4/locales/is.js
var parsedType3 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "n\xFAmer";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "fylki";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error18 = () => {
  const Sizable = {
    string: { unit: "stafi", verb: "a\xF0 hafa" },
    file: { unit: "b\xE6ti", verb: "a\xF0 hafa" },
    array: { unit: "hluti", verb: "a\xF0 hafa" },
    set: { unit: "hluti", verb: "a\xF0 hafa" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "gildi",
    email: "netfang",
    url: "vefsl\xF3\xF0",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dagsetning og t\xEDmi",
    date: "ISO dagsetning",
    time: "ISO t\xEDmi",
    duration: "ISO t\xEDmalengd",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded strengur",
    base64url: "base64url-encoded strengur",
    json_string: "JSON strengur",
    e164: "E.164 t\xF6lugildi",
    jwt: "JWT",
    template_literal: "gildi"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Rangt gildi: \xDE\xFA sl\xF3st inn ${parsedType3(issue2.input)} \xFEar sem \xE1 a\xF0 vera ${issue2.expected}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Rangt gildi: gert r\xE1\xF0 fyrir ${stringifyPrimitive(issue2.values[0])}`;
        return `\xD3gilt val: m\xE1 vera eitt af eftirfarandi ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Of st\xF3rt: gert er r\xE1\xF0 fyrir a\xF0 ${issue2.origin ?? "gildi"} hafi ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "hluti"}`;
        return `Of st\xF3rt: gert er r\xE1\xF0 fyrir a\xF0 ${issue2.origin ?? "gildi"} s\xE9 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Of l\xEDti\xF0: gert er r\xE1\xF0 fyrir a\xF0 ${issue2.origin} hafi ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Of l\xEDti\xF0: gert er r\xE1\xF0 fyrir a\xF0 ${issue2.origin} s\xE9 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\xD3gildur strengur: ver\xF0ur a\xF0 byrja \xE1 "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `\xD3gildur strengur: ver\xF0ur a\xF0 enda \xE1 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\xD3gildur strengur: ver\xF0ur a\xF0 innihalda "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\xD3gildur strengur: ver\xF0ur a\xF0 fylgja mynstri ${_issue.pattern}`;
        return `Rangt ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `R\xF6ng tala: ver\xF0ur a\xF0 vera margfeldi af ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\xD3\xFEekkt ${issue2.keys.length > 1 ? "ir lyklar" : "ur lykill"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Rangur lykill \xED ${issue2.origin}`;
      case "invalid_union":
        return "Rangt gildi";
      case "invalid_element":
        return `Rangt gildi \xED ${issue2.origin}`;
      default:
        return `Rangt gildi`;
    }
  };
};
function is_default() {
  return {
    localeError: error18()
  };
}

// node_modules/zod/v4/locales/it.js
var error19 = () => {
  const Sizable = {
    string: { unit: "caratteri", verb: "avere" },
    file: { unit: "byte", verb: "avere" },
    array: { unit: "elementi", verb: "avere" },
    set: { unit: "elementi", verb: "avere" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "numero";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "vettore";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "indirizzo email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data e ora ISO",
    date: "data ISO",
    time: "ora ISO",
    duration: "durata ISO",
    ipv4: "indirizzo IPv4",
    ipv6: "indirizzo IPv6",
    cidrv4: "intervallo IPv4",
    cidrv6: "intervallo IPv6",
    base64: "stringa codificata in base64",
    base64url: "URL codificata in base64",
    json_string: "stringa JSON",
    e164: "numero E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Input non valido: atteso ${issue2.expected}, ricevuto ${parsedType7(issue2.input)}`;
      // return `Input non valido: atteso ${issue.expected}, ricevuto ${util.getParsedType(issue.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Input non valido: atteso ${stringifyPrimitive(issue2.values[0])}`;
        return `Opzione non valida: atteso uno tra ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Troppo grande: ${issue2.origin ?? "valore"} deve avere ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementi"}`;
        return `Troppo grande: ${issue2.origin ?? "valore"} deve essere ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Troppo piccolo: ${issue2.origin} deve avere ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Troppo piccolo: ${issue2.origin} deve essere ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Stringa non valida: deve iniziare con "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Stringa non valida: deve terminare con "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Stringa non valida: deve includere "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Stringa non valida: deve corrispondere al pattern ${_issue.pattern}`;
        return `Invalid ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Numero non valido: deve essere un multiplo di ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Chiav${issue2.keys.length > 1 ? "i" : "e"} non riconosciut${issue2.keys.length > 1 ? "e" : "a"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Chiave non valida in ${issue2.origin}`;
      case "invalid_union":
        return "Input non valido";
      case "invalid_element":
        return `Valore non valido in ${issue2.origin}`;
      default:
        return `Input non valido`;
    }
  };
};
function it_default() {
  return {
    localeError: error19()
  };
}

// node_modules/zod/v4/locales/ja.js
var error20 = () => {
  const Sizable = {
    string: { unit: "\u6587\u5B57", verb: "\u3067\u3042\u308B" },
    file: { unit: "\u30D0\u30A4\u30C8", verb: "\u3067\u3042\u308B" },
    array: { unit: "\u8981\u7D20", verb: "\u3067\u3042\u308B" },
    set: { unit: "\u8981\u7D20", verb: "\u3067\u3042\u308B" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\u6570\u5024";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\u914D\u5217";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u5165\u529B\u5024",
    email: "\u30E1\u30FC\u30EB\u30A2\u30C9\u30EC\u30B9",
    url: "URL",
    emoji: "\u7D75\u6587\u5B57",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO\u65E5\u6642",
    date: "ISO\u65E5\u4ED8",
    time: "ISO\u6642\u523B",
    duration: "ISO\u671F\u9593",
    ipv4: "IPv4\u30A2\u30C9\u30EC\u30B9",
    ipv6: "IPv6\u30A2\u30C9\u30EC\u30B9",
    cidrv4: "IPv4\u7BC4\u56F2",
    cidrv6: "IPv6\u7BC4\u56F2",
    base64: "base64\u30A8\u30F3\u30B3\u30FC\u30C9\u6587\u5B57\u5217",
    base64url: "base64url\u30A8\u30F3\u30B3\u30FC\u30C9\u6587\u5B57\u5217",
    json_string: "JSON\u6587\u5B57\u5217",
    e164: "E.164\u756A\u53F7",
    jwt: "JWT",
    template_literal: "\u5165\u529B\u5024"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u7121\u52B9\u306A\u5165\u529B: ${issue2.expected}\u304C\u671F\u5F85\u3055\u308C\u307E\u3057\u305F\u304C\u3001${parsedType7(issue2.input)}\u304C\u5165\u529B\u3055\u308C\u307E\u3057\u305F`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u7121\u52B9\u306A\u5165\u529B: ${stringifyPrimitive(issue2.values[0])}\u304C\u671F\u5F85\u3055\u308C\u307E\u3057\u305F`;
        return `\u7121\u52B9\u306A\u9078\u629E: ${joinValues(issue2.values, "\u3001")}\u306E\u3044\u305A\u308C\u304B\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      case "too_big": {
        const adj = issue2.inclusive ? "\u4EE5\u4E0B\u3067\u3042\u308B" : "\u3088\u308A\u5C0F\u3055\u3044";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u5927\u304D\u3059\u304E\u308B\u5024: ${issue2.origin ?? "\u5024"}\u306F${issue2.maximum.toString()}${sizing.unit ?? "\u8981\u7D20"}${adj}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        return `\u5927\u304D\u3059\u304E\u308B\u5024: ${issue2.origin ?? "\u5024"}\u306F${issue2.maximum.toString()}${adj}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "\u4EE5\u4E0A\u3067\u3042\u308B" : "\u3088\u308A\u5927\u304D\u3044";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u5C0F\u3055\u3059\u304E\u308B\u5024: ${issue2.origin}\u306F${issue2.minimum.toString()}${sizing.unit}${adj}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        return `\u5C0F\u3055\u3059\u304E\u308B\u5024: ${issue2.origin}\u306F${issue2.minimum.toString()}${adj}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${_issue.prefix}"\u3067\u59CB\u307E\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        if (_issue.format === "ends_with")
          return `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${_issue.suffix}"\u3067\u7D42\u308F\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        if (_issue.format === "includes")
          return `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${_issue.includes}"\u3092\u542B\u3080\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        if (_issue.format === "regex")
          return `\u7121\u52B9\u306A\u6587\u5B57\u5217: \u30D1\u30BF\u30FC\u30F3${_issue.pattern}\u306B\u4E00\u81F4\u3059\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        return `\u7121\u52B9\u306A${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u7121\u52B9\u306A\u6570\u5024: ${issue2.divisor}\u306E\u500D\u6570\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      case "unrecognized_keys":
        return `\u8A8D\u8B58\u3055\u308C\u3066\u3044\u306A\u3044\u30AD\u30FC${issue2.keys.length > 1 ? "\u7FA4" : ""}: ${joinValues(issue2.keys, "\u3001")}`;
      case "invalid_key":
        return `${issue2.origin}\u5185\u306E\u7121\u52B9\u306A\u30AD\u30FC`;
      case "invalid_union":
        return "\u7121\u52B9\u306A\u5165\u529B";
      case "invalid_element":
        return `${issue2.origin}\u5185\u306E\u7121\u52B9\u306A\u5024`;
      default:
        return `\u7121\u52B9\u306A\u5165\u529B`;
    }
  };
};
function ja_default() {
  return {
    localeError: error20()
  };
}

// node_modules/zod/v4/locales/ka.js
var parsedType4 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "\u10E0\u10D8\u10EA\u10EE\u10D5\u10D8";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "\u10DB\u10D0\u10E1\u10D8\u10D5\u10D8";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  const typeMap = {
    string: "\u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8",
    boolean: "\u10D1\u10E3\u10DA\u10D4\u10D0\u10DC\u10D8",
    undefined: "undefined",
    bigint: "bigint",
    symbol: "symbol",
    function: "\u10E4\u10E3\u10DC\u10E5\u10EA\u10D8\u10D0"
  };
  return typeMap[t] ?? t;
};
var error21 = () => {
  const Sizable = {
    string: { unit: "\u10E1\u10D8\u10DB\u10D1\u10DD\u10DA\u10DD", verb: "\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1" },
    file: { unit: "\u10D1\u10D0\u10D8\u10E2\u10D8", verb: "\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1" },
    array: { unit: "\u10D4\u10DA\u10D4\u10DB\u10D4\u10DC\u10E2\u10D8", verb: "\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1" },
    set: { unit: "\u10D4\u10DA\u10D4\u10DB\u10D4\u10DC\u10E2\u10D8", verb: "\u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "\u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0",
    email: "\u10D4\u10DA-\u10E4\u10DD\u10E1\u10E2\u10D8\u10E1 \u10DB\u10D8\u10E1\u10D0\u10DB\u10D0\u10E0\u10D7\u10D8",
    url: "URL",
    emoji: "\u10D4\u10DB\u10DD\u10EF\u10D8",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u10D7\u10D0\u10E0\u10D8\u10E6\u10D8-\u10D3\u10E0\u10DD",
    date: "\u10D7\u10D0\u10E0\u10D8\u10E6\u10D8",
    time: "\u10D3\u10E0\u10DD",
    duration: "\u10EE\u10D0\u10DC\u10D2\u10E0\u10EB\u10DA\u10D8\u10D5\u10DD\u10D1\u10D0",
    ipv4: "IPv4 \u10DB\u10D8\u10E1\u10D0\u10DB\u10D0\u10E0\u10D7\u10D8",
    ipv6: "IPv6 \u10DB\u10D8\u10E1\u10D0\u10DB\u10D0\u10E0\u10D7\u10D8",
    cidrv4: "IPv4 \u10D3\u10D8\u10D0\u10DE\u10D0\u10D6\u10DD\u10DC\u10D8",
    cidrv6: "IPv6 \u10D3\u10D8\u10D0\u10DE\u10D0\u10D6\u10DD\u10DC\u10D8",
    base64: "base64-\u10D9\u10DD\u10D3\u10D8\u10E0\u10D4\u10D1\u10E3\u10DA\u10D8 \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8",
    base64url: "base64url-\u10D9\u10DD\u10D3\u10D8\u10E0\u10D4\u10D1\u10E3\u10DA\u10D8 \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8",
    json_string: "JSON \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8",
    e164: "E.164 \u10DC\u10DD\u10DB\u10D4\u10E0\u10D8",
    jwt: "JWT",
    template_literal: "\u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${issue2.expected}, \u10DB\u10D8\u10E6\u10D4\u10D1\u10E3\u10DA\u10D8 ${parsedType4(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${stringifyPrimitive(issue2.values[0])}`;
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10D5\u10D0\u10E0\u10D8\u10D0\u10DC\u10E2\u10D8: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8\u10D0 \u10D4\u10E0\u10D7-\u10D4\u10E0\u10D7\u10D8 ${joinValues(issue2.values, "|")}-\u10D3\u10D0\u10DC`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u10D6\u10D4\u10D3\u10DB\u10D4\u10E2\u10D0\u10D3 \u10D3\u10D8\u10D3\u10D8: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${issue2.origin ?? "\u10DB\u10DC\u10D8\u10E8\u10D5\u10DC\u10D4\u10DA\u10DD\u10D1\u10D0"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit}`;
        return `\u10D6\u10D4\u10D3\u10DB\u10D4\u10E2\u10D0\u10D3 \u10D3\u10D8\u10D3\u10D8: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${issue2.origin ?? "\u10DB\u10DC\u10D8\u10E8\u10D5\u10DC\u10D4\u10DA\u10DD\u10D1\u10D0"} \u10D8\u10E7\u10DD\u10E1 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u10D6\u10D4\u10D3\u10DB\u10D4\u10E2\u10D0\u10D3 \u10DE\u10D0\u10E2\u10D0\u10E0\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u10D6\u10D4\u10D3\u10DB\u10D4\u10E2\u10D0\u10D3 \u10DE\u10D0\u10E2\u10D0\u10E0\u10D0: \u10DB\u10DD\u10E1\u10D0\u10DA\u10DD\u10D3\u10DC\u10D4\u10DA\u10D8 ${issue2.origin} \u10D8\u10E7\u10DD\u10E1 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10D8\u10EC\u10E7\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 "${_issue.prefix}"-\u10D8\u10D7`;
        }
        if (_issue.format === "ends_with")
          return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10DB\u10D7\u10D0\u10D5\u10E0\u10D3\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 "${_issue.suffix}"-\u10D8\u10D7`;
        if (_issue.format === "includes")
          return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1 "${_issue.includes}"-\u10E1`;
        if (_issue.format === "regex")
          return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E1\u10E2\u10E0\u10D8\u10DC\u10D2\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D4\u10E1\u10D0\u10D1\u10D0\u10DB\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 \u10E8\u10D0\u10D1\u10DA\u10DD\u10DC\u10E1 ${_issue.pattern}`;
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E0\u10D8\u10EA\u10EE\u10D5\u10D8: \u10E3\u10DC\u10D3\u10D0 \u10D8\u10E7\u10DD\u10E1 ${issue2.divisor}-\u10D8\u10E1 \u10EF\u10D4\u10E0\u10D0\u10D3\u10D8`;
      case "unrecognized_keys":
        return `\u10E3\u10EA\u10DC\u10DD\u10D1\u10D8 \u10D2\u10D0\u10E1\u10D0\u10E6\u10D4\u10D1${issue2.keys.length > 1 ? "\u10D4\u10D1\u10D8" : "\u10D8"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10D2\u10D0\u10E1\u10D0\u10E6\u10D4\u10D1\u10D8 ${issue2.origin}-\u10E8\u10D8`;
      case "invalid_union":
        return "\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0";
      case "invalid_element":
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10DB\u10DC\u10D8\u10E8\u10D5\u10DC\u10D4\u10DA\u10DD\u10D1\u10D0 ${issue2.origin}-\u10E8\u10D8`;
      default:
        return `\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 \u10E8\u10D4\u10E7\u10D5\u10D0\u10DC\u10D0`;
    }
  };
};
function ka_default() {
  return {
    localeError: error21()
  };
}

// node_modules/zod/v4/locales/km.js
var error22 = () => {
  const Sizable = {
    string: { unit: "\u178F\u17BD\u17A2\u1780\u17D2\u179F\u179A", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" },
    file: { unit: "\u1794\u17C3", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" },
    array: { unit: "\u1792\u17B6\u178F\u17BB", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" },
    set: { unit: "\u1792\u17B6\u178F\u17BB", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "\u1798\u17B7\u1793\u1798\u17C2\u1793\u1787\u17B6\u179B\u17C1\u1781 (NaN)" : "\u179B\u17C1\u1781";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\u17A2\u17B6\u179A\u17C1 (Array)";
        }
        if (data === null) {
          return "\u1782\u17D2\u1798\u17B6\u1793\u178F\u1798\u17D2\u179B\u17C3 (null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B",
    email: "\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793\u17A2\u17CA\u17B8\u1798\u17C2\u179B",
    url: "URL",
    emoji: "\u179F\u1789\u17D2\u1789\u17B6\u17A2\u17B6\u179A\u1798\u17D2\u1798\u178E\u17CD",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u1780\u17B6\u179B\u1794\u179A\u17B7\u1785\u17D2\u1786\u17C1\u1791 \u1793\u17B7\u1784\u1798\u17C9\u17C4\u1784 ISO",
    date: "\u1780\u17B6\u179B\u1794\u179A\u17B7\u1785\u17D2\u1786\u17C1\u1791 ISO",
    time: "\u1798\u17C9\u17C4\u1784 ISO",
    duration: "\u179A\u1799\u17C8\u1796\u17C1\u179B ISO",
    ipv4: "\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv4",
    ipv6: "\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv6",
    cidrv4: "\u178A\u17C2\u1793\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv4",
    cidrv6: "\u178A\u17C2\u1793\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv6",
    base64: "\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u17A2\u17CA\u17B7\u1780\u17BC\u178A base64",
    base64url: "\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u17A2\u17CA\u17B7\u1780\u17BC\u178A base64url",
    json_string: "\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A JSON",
    e164: "\u179B\u17C1\u1781 E.164",
    jwt: "JWT",
    template_literal: "\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${issue2.expected} \u1794\u17C9\u17BB\u1793\u17D2\u178F\u17C2\u1791\u1791\u17BD\u179B\u1794\u17B6\u1793 ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${stringifyPrimitive(issue2.values[0])}`;
        return `\u1787\u1798\u17D2\u179A\u17BE\u179F\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1787\u17B6\u1798\u17BD\u1799\u1780\u17D2\u1793\u17BB\u1784\u1785\u17C6\u178E\u17C4\u1798 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u1792\u17C6\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${issue2.origin ?? "\u178F\u1798\u17D2\u179B\u17C3"} ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "\u1792\u17B6\u178F\u17BB"}`;
        return `\u1792\u17C6\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${issue2.origin ?? "\u178F\u1798\u17D2\u179B\u17C3"} ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u178F\u17BC\u1785\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${issue2.origin} ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u178F\u17BC\u1785\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${issue2.origin} ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1785\u17B6\u1794\u17CB\u1795\u17D2\u178F\u17BE\u1798\u178A\u17C4\u1799 "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1794\u1789\u17D2\u1785\u1794\u17CB\u178A\u17C4\u1799 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1798\u17B6\u1793 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u178F\u17C2\u1795\u17D2\u1782\u17BC\u1795\u17D2\u1782\u1784\u1793\u17B9\u1784\u1791\u1798\u17D2\u179A\u1784\u17CB\u178A\u17C2\u179B\u1794\u17B6\u1793\u1780\u17C6\u178E\u178F\u17CB ${_issue.pattern}`;
        return `\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u179B\u17C1\u1781\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u178F\u17C2\u1787\u17B6\u1796\u17A0\u17BB\u1782\u17BB\u178E\u1793\u17C3 ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u179A\u1780\u1783\u17BE\u1789\u179F\u17C4\u1798\u17B7\u1793\u179F\u17D2\u1782\u17B6\u179B\u17CB\u17D6 ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u179F\u17C4\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u1793\u17C5\u1780\u17D2\u1793\u17BB\u1784 ${issue2.origin}`;
      case "invalid_union":
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C`;
      case "invalid_element":
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u1793\u17C5\u1780\u17D2\u1793\u17BB\u1784 ${issue2.origin}`;
      default:
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C`;
    }
  };
};
function km_default() {
  return {
    localeError: error22()
  };
}

// node_modules/zod/v4/locales/kh.js
function kh_default() {
  return km_default();
}

// node_modules/zod/v4/locales/ko.js
var error23 = () => {
  const Sizable = {
    string: { unit: "\uBB38\uC790", verb: "to have" },
    file: { unit: "\uBC14\uC774\uD2B8", verb: "to have" },
    array: { unit: "\uAC1C", verb: "to have" },
    set: { unit: "\uAC1C", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\uC785\uB825",
    email: "\uC774\uBA54\uC77C \uC8FC\uC18C",
    url: "URL",
    emoji: "\uC774\uBAA8\uC9C0",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \uB0A0\uC9DC\uC2DC\uAC04",
    date: "ISO \uB0A0\uC9DC",
    time: "ISO \uC2DC\uAC04",
    duration: "ISO \uAE30\uAC04",
    ipv4: "IPv4 \uC8FC\uC18C",
    ipv6: "IPv6 \uC8FC\uC18C",
    cidrv4: "IPv4 \uBC94\uC704",
    cidrv6: "IPv6 \uBC94\uC704",
    base64: "base64 \uC778\uCF54\uB529 \uBB38\uC790\uC5F4",
    base64url: "base64url \uC778\uCF54\uB529 \uBB38\uC790\uC5F4",
    json_string: "JSON \uBB38\uC790\uC5F4",
    e164: "E.164 \uBC88\uD638",
    jwt: "JWT",
    template_literal: "\uC785\uB825"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\uC798\uBABB\uB41C \uC785\uB825: \uC608\uC0C1 \uD0C0\uC785\uC740 ${issue2.expected}, \uBC1B\uC740 \uD0C0\uC785\uC740 ${parsedType7(issue2.input)}\uC785\uB2C8\uB2E4`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\uC798\uBABB\uB41C \uC785\uB825: \uAC12\uC740 ${stringifyPrimitive(issue2.values[0])} \uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4`;
        return `\uC798\uBABB\uB41C \uC635\uC158: ${joinValues(issue2.values, "\uB610\uB294 ")} \uC911 \uD558\uB098\uC5EC\uC57C \uD569\uB2C8\uB2E4`;
      case "too_big": {
        const adj = issue2.inclusive ? "\uC774\uD558" : "\uBBF8\uB9CC";
        const suffix = adj === "\uBBF8\uB9CC" ? "\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4" : "\uC5EC\uC57C \uD569\uB2C8\uB2E4";
        const sizing = getSizing(issue2.origin);
        const unit = sizing?.unit ?? "\uC694\uC18C";
        if (sizing)
          return `${issue2.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4: ${issue2.maximum.toString()}${unit} ${adj}${suffix}`;
        return `${issue2.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4: ${issue2.maximum.toString()} ${adj}${suffix}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "\uC774\uC0C1" : "\uCD08\uACFC";
        const suffix = adj === "\uC774\uC0C1" ? "\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4" : "\uC5EC\uC57C \uD569\uB2C8\uB2E4";
        const sizing = getSizing(issue2.origin);
        const unit = sizing?.unit ?? "\uC694\uC18C";
        if (sizing) {
          return `${issue2.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uC791\uC2B5\uB2C8\uB2E4: ${issue2.minimum.toString()}${unit} ${adj}${suffix}`;
        }
        return `${issue2.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uC791\uC2B5\uB2C8\uB2E4: ${issue2.minimum.toString()} ${adj}${suffix}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${_issue.prefix}"(\uC73C)\uB85C \uC2DC\uC791\uD574\uC57C \uD569\uB2C8\uB2E4`;
        }
        if (_issue.format === "ends_with")
          return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${_issue.suffix}"(\uC73C)\uB85C \uB05D\uB098\uC57C \uD569\uB2C8\uB2E4`;
        if (_issue.format === "includes")
          return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${_issue.includes}"\uC744(\uB97C) \uD3EC\uD568\uD574\uC57C \uD569\uB2C8\uB2E4`;
        if (_issue.format === "regex")
          return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: \uC815\uADDC\uC2DD ${_issue.pattern} \uD328\uD134\uACFC \uC77C\uCE58\uD574\uC57C \uD569\uB2C8\uB2E4`;
        return `\uC798\uBABB\uB41C ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\uC798\uBABB\uB41C \uC22B\uC790: ${issue2.divisor}\uC758 \uBC30\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4`;
      case "unrecognized_keys":
        return `\uC778\uC2DD\uD560 \uC218 \uC5C6\uB294 \uD0A4: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\uC798\uBABB\uB41C \uD0A4: ${issue2.origin}`;
      case "invalid_union":
        return `\uC798\uBABB\uB41C \uC785\uB825`;
      case "invalid_element":
        return `\uC798\uBABB\uB41C \uAC12: ${issue2.origin}`;
      default:
        return `\uC798\uBABB\uB41C \uC785\uB825`;
    }
  };
};
function ko_default() {
  return {
    localeError: error23()
  };
}

// node_modules/zod/v4/locales/lt.js
var parsedType5 = (data) => {
  const t = typeof data;
  return parsedTypeFromType(t, data);
};
var parsedTypeFromType = (t, data = void 0) => {
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "skai\u010Dius";
    }
    case "bigint": {
      return "sveikasis skai\u010Dius";
    }
    case "string": {
      return "eilut\u0117";
    }
    case "boolean": {
      return "login\u0117 reik\u0161m\u0117";
    }
    case "undefined":
    case "void": {
      return "neapibr\u0117\u017Eta reik\u0161m\u0117";
    }
    case "function": {
      return "funkcija";
    }
    case "symbol": {
      return "simbolis";
    }
    case "object": {
      if (data === void 0)
        return "ne\u017Einomas objektas";
      if (data === null)
        return "nulin\u0117 reik\u0161m\u0117";
      if (Array.isArray(data))
        return "masyvas";
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
      return "objektas";
    }
    //Zod types below
    case "null": {
      return "nulin\u0117 reik\u0161m\u0117";
    }
  }
  return t;
};
var capitalizeFirstCharacter = (text) => {
  return text.charAt(0).toUpperCase() + text.slice(1);
};
function getUnitTypeFromNumber(number4) {
  const abs = Math.abs(number4);
  const last = abs % 10;
  const last2 = abs % 100;
  if (last2 >= 11 && last2 <= 19 || last === 0)
    return "many";
  if (last === 1)
    return "one";
  return "few";
}
var error24 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "simbolis",
        few: "simboliai",
        many: "simboli\u0173"
      },
      verb: {
        smaller: {
          inclusive: "turi b\u016Bti ne ilgesn\u0117 kaip",
          notInclusive: "turi b\u016Bti trumpesn\u0117 kaip"
        },
        bigger: {
          inclusive: "turi b\u016Bti ne trumpesn\u0117 kaip",
          notInclusive: "turi b\u016Bti ilgesn\u0117 kaip"
        }
      }
    },
    file: {
      unit: {
        one: "baitas",
        few: "baitai",
        many: "bait\u0173"
      },
      verb: {
        smaller: {
          inclusive: "turi b\u016Bti ne didesnis kaip",
          notInclusive: "turi b\u016Bti ma\u017Eesnis kaip"
        },
        bigger: {
          inclusive: "turi b\u016Bti ne ma\u017Eesnis kaip",
          notInclusive: "turi b\u016Bti didesnis kaip"
        }
      }
    },
    array: {
      unit: {
        one: "element\u0105",
        few: "elementus",
        many: "element\u0173"
      },
      verb: {
        smaller: {
          inclusive: "turi tur\u0117ti ne daugiau kaip",
          notInclusive: "turi tur\u0117ti ma\u017Eiau kaip"
        },
        bigger: {
          inclusive: "turi tur\u0117ti ne ma\u017Eiau kaip",
          notInclusive: "turi tur\u0117ti daugiau kaip"
        }
      }
    },
    set: {
      unit: {
        one: "element\u0105",
        few: "elementus",
        many: "element\u0173"
      },
      verb: {
        smaller: {
          inclusive: "turi tur\u0117ti ne daugiau kaip",
          notInclusive: "turi tur\u0117ti ma\u017Eiau kaip"
        },
        bigger: {
          inclusive: "turi tur\u0117ti ne ma\u017Eiau kaip",
          notInclusive: "turi tur\u0117ti daugiau kaip"
        }
      }
    }
  };
  function getSizing(origin, unitType, inclusive, targetShouldBe) {
    const result = Sizable[origin] ?? null;
    if (result === null)
      return result;
    return {
      unit: result.unit[unitType],
      verb: result.verb[targetShouldBe][inclusive ? "inclusive" : "notInclusive"]
    };
  }
  const Nouns = {
    regex: "\u012Fvestis",
    email: "el. pa\u0161to adresas",
    url: "URL",
    emoji: "jaustukas",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO data ir laikas",
    date: "ISO data",
    time: "ISO laikas",
    duration: "ISO trukm\u0117",
    ipv4: "IPv4 adresas",
    ipv6: "IPv6 adresas",
    cidrv4: "IPv4 tinklo prefiksas (CIDR)",
    cidrv6: "IPv6 tinklo prefiksas (CIDR)",
    base64: "base64 u\u017Ekoduota eilut\u0117",
    base64url: "base64url u\u017Ekoduota eilut\u0117",
    json_string: "JSON eilut\u0117",
    e164: "E.164 numeris",
    jwt: "JWT",
    template_literal: "\u012Fvestis"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Gautas tipas ${parsedType5(issue2.input)}, o tik\u0117tasi - ${parsedTypeFromType(issue2.expected)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Privalo b\u016Bti ${stringifyPrimitive(issue2.values[0])}`;
        return `Privalo b\u016Bti vienas i\u0161 ${joinValues(issue2.values, "|")} pasirinkim\u0173`;
      case "too_big": {
        const origin = parsedTypeFromType(issue2.origin);
        const sizing = getSizing(issue2.origin, getUnitTypeFromNumber(Number(issue2.maximum)), issue2.inclusive ?? false, "smaller");
        if (sizing?.verb)
          return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\u0161m\u0117")} ${sizing.verb} ${issue2.maximum.toString()} ${sizing.unit ?? "element\u0173"}`;
        const adj = issue2.inclusive ? "ne didesnis kaip" : "ma\u017Eesnis kaip";
        return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\u0161m\u0117")} turi b\u016Bti ${adj} ${issue2.maximum.toString()} ${sizing?.unit}`;
      }
      case "too_small": {
        const origin = parsedTypeFromType(issue2.origin);
        const sizing = getSizing(issue2.origin, getUnitTypeFromNumber(Number(issue2.minimum)), issue2.inclusive ?? false, "bigger");
        if (sizing?.verb)
          return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\u0161m\u0117")} ${sizing.verb} ${issue2.minimum.toString()} ${sizing.unit ?? "element\u0173"}`;
        const adj = issue2.inclusive ? "ne ma\u017Eesnis kaip" : "didesnis kaip";
        return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\u0161m\u0117")} turi b\u016Bti ${adj} ${issue2.minimum.toString()} ${sizing?.unit}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Eilut\u0117 privalo prasid\u0117ti "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Eilut\u0117 privalo pasibaigti "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Eilut\u0117 privalo \u012Ftraukti "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Eilut\u0117 privalo atitikti ${_issue.pattern}`;
        return `Neteisingas ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Skai\u010Dius privalo b\u016Bti ${issue2.divisor} kartotinis.`;
      case "unrecognized_keys":
        return `Neatpa\u017Eint${issue2.keys.length > 1 ? "i" : "as"} rakt${issue2.keys.length > 1 ? "ai" : "as"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return "Rastas klaidingas raktas";
      case "invalid_union":
        return "Klaidinga \u012Fvestis";
      case "invalid_element": {
        const origin = parsedTypeFromType(issue2.origin);
        return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reik\u0161m\u0117")} turi klaiding\u0105 \u012Fvest\u012F`;
      }
      default:
        return "Klaidinga \u012Fvestis";
    }
  };
};
function lt_default() {
  return {
    localeError: error24()
  };
}

// node_modules/zod/v4/locales/mk.js
var error25 = () => {
  const Sizable = {
    string: { unit: "\u0437\u043D\u0430\u0446\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" },
    file: { unit: "\u0431\u0430\u0458\u0442\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" },
    array: { unit: "\u0441\u0442\u0430\u0432\u043A\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" },
    set: { unit: "\u0441\u0442\u0430\u0432\u043A\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\u0431\u0440\u043E\u0458";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\u043D\u0438\u0437\u0430";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u0432\u043D\u0435\u0441",
    email: "\u0430\u0434\u0440\u0435\u0441\u0430 \u043D\u0430 \u0435-\u043F\u043E\u0448\u0442\u0430",
    url: "URL",
    emoji: "\u0435\u043C\u043E\u045F\u0438",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \u0434\u0430\u0442\u0443\u043C \u0438 \u0432\u0440\u0435\u043C\u0435",
    date: "ISO \u0434\u0430\u0442\u0443\u043C",
    time: "ISO \u0432\u0440\u0435\u043C\u0435",
    duration: "ISO \u0432\u0440\u0435\u043C\u0435\u0442\u0440\u0430\u0435\u045A\u0435",
    ipv4: "IPv4 \u0430\u0434\u0440\u0435\u0441\u0430",
    ipv6: "IPv6 \u0430\u0434\u0440\u0435\u0441\u0430",
    cidrv4: "IPv4 \u043E\u043F\u0441\u0435\u0433",
    cidrv6: "IPv6 \u043E\u043F\u0441\u0435\u0433",
    base64: "base64-\u0435\u043D\u043A\u043E\u0434\u0438\u0440\u0430\u043D\u0430 \u043D\u0438\u0437\u0430",
    base64url: "base64url-\u0435\u043D\u043A\u043E\u0434\u0438\u0440\u0430\u043D\u0430 \u043D\u0438\u0437\u0430",
    json_string: "JSON \u043D\u0438\u0437\u0430",
    e164: "E.164 \u0431\u0440\u043E\u0458",
    jwt: "JWT",
    template_literal: "\u0432\u043D\u0435\u0441"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${issue2.expected}, \u043F\u0440\u0438\u043C\u0435\u043D\u043E ${parsedType7(issue2.input)}`;
      // return `Invalid input: expected ${issue.expected}, received ${util.getParsedType(issue.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue2.values[0])}`;
        return `\u0413\u0440\u0435\u0448\u0430\u043D\u0430 \u043E\u043F\u0446\u0438\u0458\u0430: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 \u0435\u0434\u043D\u0430 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u0433\u043E\u043B\u0435\u043C: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${issue2.origin ?? "\u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442\u0430"} \u0434\u0430 \u0438\u043C\u0430 ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0438"}`;
        return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u0433\u043E\u043B\u0435\u043C: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${issue2.origin ?? "\u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442\u0430"} \u0434\u0430 \u0431\u0438\u0434\u0435 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u043C\u0430\u043B: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${issue2.origin} \u0434\u0430 \u0438\u043C\u0430 ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u043C\u0430\u043B: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${issue2.origin} \u0434\u0430 \u0431\u0438\u0434\u0435 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0437\u0430\u043F\u043E\u0447\u043D\u0443\u0432\u0430 \u0441\u043E "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0437\u0430\u0432\u0440\u0448\u0443\u0432\u0430 \u0441\u043E "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0432\u043A\u043B\u0443\u0447\u0443\u0432\u0430 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u043E\u0434\u0433\u043E\u0430\u0440\u0430 \u043D\u0430 \u043F\u0430\u0442\u0435\u0440\u043D\u043E\u0442 ${_issue.pattern}`;
        return `Invalid ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0431\u0440\u043E\u0458: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0431\u0438\u0434\u0435 \u0434\u0435\u043B\u0438\u0432 \u0441\u043E ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "\u041D\u0435\u043F\u0440\u0435\u043F\u043E\u0437\u043D\u0430\u0435\u043D\u0438 \u043A\u043B\u0443\u0447\u0435\u0432\u0438" : "\u041D\u0435\u043F\u0440\u0435\u043F\u043E\u0437\u043D\u0430\u0435\u043D \u043A\u043B\u0443\u0447"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u043A\u043B\u0443\u0447 \u0432\u043E ${issue2.origin}`;
      case "invalid_union":
        return "\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441";
      case "invalid_element":
        return `\u0413\u0440\u0435\u0448\u043D\u0430 \u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442 \u0432\u043E ${issue2.origin}`;
      default:
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441`;
    }
  };
};
function mk_default() {
  return {
    localeError: error25()
  };
}

// node_modules/zod/v4/locales/ms.js
var error26 = () => {
  const Sizable = {
    string: { unit: "aksara", verb: "mempunyai" },
    file: { unit: "bait", verb: "mempunyai" },
    array: { unit: "elemen", verb: "mempunyai" },
    set: { unit: "elemen", verb: "mempunyai" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nombor";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "alamat e-mel",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "tarikh masa ISO",
    date: "tarikh ISO",
    time: "masa ISO",
    duration: "tempoh ISO",
    ipv4: "alamat IPv4",
    ipv6: "alamat IPv6",
    cidrv4: "julat IPv4",
    cidrv6: "julat IPv6",
    base64: "string dikodkan base64",
    base64url: "string dikodkan base64url",
    json_string: "string JSON",
    e164: "nombor E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Input tidak sah: dijangka ${issue2.expected}, diterima ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Input tidak sah: dijangka ${stringifyPrimitive(issue2.values[0])}`;
        return `Pilihan tidak sah: dijangka salah satu daripada ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Terlalu besar: dijangka ${issue2.origin ?? "nilai"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elemen"}`;
        return `Terlalu besar: dijangka ${issue2.origin ?? "nilai"} adalah ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Terlalu kecil: dijangka ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Terlalu kecil: dijangka ${issue2.origin} adalah ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `String tidak sah: mesti bermula dengan "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `String tidak sah: mesti berakhir dengan "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `String tidak sah: mesti mengandungi "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `String tidak sah: mesti sepadan dengan corak ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} tidak sah`;
      }
      case "not_multiple_of":
        return `Nombor tidak sah: perlu gandaan ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak sah dalam ${issue2.origin}`;
      case "invalid_union":
        return "Input tidak sah";
      case "invalid_element":
        return `Nilai tidak sah dalam ${issue2.origin}`;
      default:
        return `Input tidak sah`;
    }
  };
};
function ms_default() {
  return {
    localeError: error26()
  };
}

// node_modules/zod/v4/locales/nl.js
var error27 = () => {
  const Sizable = {
    string: { unit: "tekens" },
    file: { unit: "bytes" },
    array: { unit: "elementen" },
    set: { unit: "elementen" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "getal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "invoer",
    email: "emailadres",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datum en tijd",
    date: "ISO datum",
    time: "ISO tijd",
    duration: "ISO duur",
    ipv4: "IPv4-adres",
    ipv6: "IPv6-adres",
    cidrv4: "IPv4-bereik",
    cidrv6: "IPv6-bereik",
    base64: "base64-gecodeerde tekst",
    base64url: "base64 URL-gecodeerde tekst",
    json_string: "JSON string",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "invoer"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ongeldige invoer: verwacht ${issue2.expected}, ontving ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ongeldige invoer: verwacht ${stringifyPrimitive(issue2.values[0])}`;
        return `Ongeldige optie: verwacht \xE9\xE9n van ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Te lang: verwacht dat ${issue2.origin ?? "waarde"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementen"} bevat`;
        return `Te lang: verwacht dat ${issue2.origin ?? "waarde"} ${adj}${issue2.maximum.toString()} is`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Te kort: verwacht dat ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} bevat`;
        }
        return `Te kort: verwacht dat ${issue2.origin} ${adj}${issue2.minimum.toString()} is`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Ongeldige tekst: moet met "${_issue.prefix}" beginnen`;
        }
        if (_issue.format === "ends_with")
          return `Ongeldige tekst: moet op "${_issue.suffix}" eindigen`;
        if (_issue.format === "includes")
          return `Ongeldige tekst: moet "${_issue.includes}" bevatten`;
        if (_issue.format === "regex")
          return `Ongeldige tekst: moet overeenkomen met patroon ${_issue.pattern}`;
        return `Ongeldig: ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ongeldig getal: moet een veelvoud van ${issue2.divisor} zijn`;
      case "unrecognized_keys":
        return `Onbekende key${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ongeldige key in ${issue2.origin}`;
      case "invalid_union":
        return "Ongeldige invoer";
      case "invalid_element":
        return `Ongeldige waarde in ${issue2.origin}`;
      default:
        return `Ongeldige invoer`;
    }
  };
};
function nl_default() {
  return {
    localeError: error27()
  };
}

// node_modules/zod/v4/locales/no.js
var error28 = () => {
  const Sizable = {
    string: { unit: "tegn", verb: "\xE5 ha" },
    file: { unit: "bytes", verb: "\xE5 ha" },
    array: { unit: "elementer", verb: "\xE5 inneholde" },
    set: { unit: "elementer", verb: "\xE5 inneholde" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "tall";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "liste";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "e-postadresse",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dato- og klokkeslett",
    date: "ISO-dato",
    time: "ISO-klokkeslett",
    duration: "ISO-varighet",
    ipv4: "IPv4-omr\xE5de",
    ipv6: "IPv6-omr\xE5de",
    cidrv4: "IPv4-spekter",
    cidrv6: "IPv6-spekter",
    base64: "base64-enkodet streng",
    base64url: "base64url-enkodet streng",
    json_string: "JSON-streng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ugyldig input: forventet ${issue2.expected}, fikk ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ugyldig verdi: forventet ${stringifyPrimitive(issue2.values[0])}`;
        return `Ugyldig valg: forventet en av ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `For stor(t): forventet ${issue2.origin ?? "value"} til \xE5 ha ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementer"}`;
        return `For stor(t): forventet ${issue2.origin ?? "value"} til \xE5 ha ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `For lite(n): forventet ${issue2.origin} til \xE5 ha ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `For lite(n): forventet ${issue2.origin} til \xE5 ha ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ugyldig streng: m\xE5 starte med "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ugyldig streng: m\xE5 ende med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ugyldig streng: m\xE5 inneholde "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ugyldig streng: m\xE5 matche m\xF8nsteret ${_issue.pattern}`;
        return `Ugyldig ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ugyldig tall: m\xE5 v\xE6re et multiplum av ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Ukjente n\xF8kler" : "Ukjent n\xF8kkel"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ugyldig n\xF8kkel i ${issue2.origin}`;
      case "invalid_union":
        return "Ugyldig input";
      case "invalid_element":
        return `Ugyldig verdi i ${issue2.origin}`;
      default:
        return `Ugyldig input`;
    }
  };
};
function no_default() {
  return {
    localeError: error28()
  };
}

// node_modules/zod/v4/locales/ota.js
var error29 = () => {
  const Sizable = {
    string: { unit: "harf", verb: "olmal\u0131d\u0131r" },
    file: { unit: "bayt", verb: "olmal\u0131d\u0131r" },
    array: { unit: "unsur", verb: "olmal\u0131d\u0131r" },
    set: { unit: "unsur", verb: "olmal\u0131d\u0131r" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "numara";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "saf";
        }
        if (data === null) {
          return "gayb";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "giren",
    email: "epostag\xE2h",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO heng\xE2m\u0131",
    date: "ISO tarihi",
    time: "ISO zaman\u0131",
    duration: "ISO m\xFCddeti",
    ipv4: "IPv4 ni\u015F\xE2n\u0131",
    ipv6: "IPv6 ni\u015F\xE2n\u0131",
    cidrv4: "IPv4 menzili",
    cidrv6: "IPv6 menzili",
    base64: "base64-\u015Fifreli metin",
    base64url: "base64url-\u015Fifreli metin",
    json_string: "JSON metin",
    e164: "E.164 say\u0131s\u0131",
    jwt: "JWT",
    template_literal: "giren"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `F\xE2sit giren: umulan ${issue2.expected}, al\u0131nan ${parsedType7(issue2.input)}`;
      // return `Fâsit giren: umulan ${issue.expected}, alınan ${util.getParsedType(issue.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `F\xE2sit giren: umulan ${stringifyPrimitive(issue2.values[0])}`;
        return `F\xE2sit tercih: m\xFBteberler ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Fazla b\xFCy\xFCk: ${issue2.origin ?? "value"}, ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"} sahip olmal\u0131yd\u0131.`;
        return `Fazla b\xFCy\xFCk: ${issue2.origin ?? "value"}, ${adj}${issue2.maximum.toString()} olmal\u0131yd\u0131.`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Fazla k\xFC\xE7\xFCk: ${issue2.origin}, ${adj}${issue2.minimum.toString()} ${sizing.unit} sahip olmal\u0131yd\u0131.`;
        }
        return `Fazla k\xFC\xE7\xFCk: ${issue2.origin}, ${adj}${issue2.minimum.toString()} olmal\u0131yd\u0131.`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `F\xE2sit metin: "${_issue.prefix}" ile ba\u015Flamal\u0131.`;
        if (_issue.format === "ends_with")
          return `F\xE2sit metin: "${_issue.suffix}" ile bitmeli.`;
        if (_issue.format === "includes")
          return `F\xE2sit metin: "${_issue.includes}" ihtiv\xE2 etmeli.`;
        if (_issue.format === "regex")
          return `F\xE2sit metin: ${_issue.pattern} nak\u015F\u0131na uymal\u0131.`;
        return `F\xE2sit ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `F\xE2sit say\u0131: ${issue2.divisor} kat\u0131 olmal\u0131yd\u0131.`;
      case "unrecognized_keys":
        return `Tan\u0131nmayan anahtar ${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} i\xE7in tan\u0131nmayan anahtar var.`;
      case "invalid_union":
        return "Giren tan\u0131namad\u0131.";
      case "invalid_element":
        return `${issue2.origin} i\xE7in tan\u0131nmayan k\u0131ymet var.`;
      default:
        return `K\u0131ymet tan\u0131namad\u0131.`;
    }
  };
};
function ota_default() {
  return {
    localeError: error29()
  };
}

// node_modules/zod/v4/locales/ps.js
var error30 = () => {
  const Sizable = {
    string: { unit: "\u062A\u0648\u06A9\u064A", verb: "\u0648\u0644\u0631\u064A" },
    file: { unit: "\u0628\u0627\u06CC\u067C\u0633", verb: "\u0648\u0644\u0631\u064A" },
    array: { unit: "\u062A\u0648\u06A9\u064A", verb: "\u0648\u0644\u0631\u064A" },
    set: { unit: "\u062A\u0648\u06A9\u064A", verb: "\u0648\u0644\u0631\u064A" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\u0639\u062F\u062F";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\u0627\u0631\u06D0";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u0648\u0631\u0648\u062F\u064A",
    email: "\u0628\u0631\u06CC\u069A\u0646\u0627\u0644\u06CC\u06A9",
    url: "\u06CC\u0648 \u0622\u0631 \u0627\u0644",
    emoji: "\u0627\u06CC\u0645\u0648\u062C\u064A",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u0646\u06CC\u067C\u0647 \u0627\u0648 \u0648\u062E\u062A",
    date: "\u0646\u06D0\u067C\u0647",
    time: "\u0648\u062E\u062A",
    duration: "\u0645\u0648\u062F\u0647",
    ipv4: "\u062F IPv4 \u067E\u062A\u0647",
    ipv6: "\u062F IPv6 \u067E\u062A\u0647",
    cidrv4: "\u062F IPv4 \u0633\u0627\u062D\u0647",
    cidrv6: "\u062F IPv6 \u0633\u0627\u062D\u0647",
    base64: "base64-encoded \u0645\u062A\u0646",
    base64url: "base64url-encoded \u0645\u062A\u0646",
    json_string: "JSON \u0645\u062A\u0646",
    e164: "\u062F E.164 \u0634\u0645\u06D0\u0631\u0647",
    jwt: "JWT",
    template_literal: "\u0648\u0631\u0648\u062F\u064A"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u0646\u0627\u0633\u0645 \u0648\u0631\u0648\u062F\u064A: \u0628\u0627\u06CC\u062F ${issue2.expected} \u0648\u0627\u06CC, \u0645\u06AB\u0631 ${parsedType7(issue2.input)} \u062A\u0631\u0644\u0627\u0633\u0647 \u0634\u0648`;
      case "invalid_value":
        if (issue2.values.length === 1) {
          return `\u0646\u0627\u0633\u0645 \u0648\u0631\u0648\u062F\u064A: \u0628\u0627\u06CC\u062F ${stringifyPrimitive(issue2.values[0])} \u0648\u0627\u06CC`;
        }
        return `\u0646\u0627\u0633\u0645 \u0627\u0646\u062A\u062E\u0627\u0628: \u0628\u0627\u06CC\u062F \u06CC\u0648 \u0644\u0647 ${joinValues(issue2.values, "|")} \u0685\u062E\u0647 \u0648\u0627\u06CC`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0689\u06CC\u0631 \u0644\u0648\u06CC: ${issue2.origin ?? "\u0627\u0631\u0632\u069A\u062A"} \u0628\u0627\u06CC\u062F ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0639\u0646\u0635\u0631\u0648\u0646\u0647"} \u0648\u0644\u0631\u064A`;
        }
        return `\u0689\u06CC\u0631 \u0644\u0648\u06CC: ${issue2.origin ?? "\u0627\u0631\u0632\u069A\u062A"} \u0628\u0627\u06CC\u062F ${adj}${issue2.maximum.toString()} \u0648\u064A`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0689\u06CC\u0631 \u06A9\u0648\u0686\u0646\u06CC: ${issue2.origin} \u0628\u0627\u06CC\u062F ${adj}${issue2.minimum.toString()} ${sizing.unit} \u0648\u0644\u0631\u064A`;
        }
        return `\u0689\u06CC\u0631 \u06A9\u0648\u0686\u0646\u06CC: ${issue2.origin} \u0628\u0627\u06CC\u062F ${adj}${issue2.minimum.toString()} \u0648\u064A`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F "${_issue.prefix}" \u0633\u0631\u0647 \u067E\u06CC\u0644 \u0634\u064A`;
        }
        if (_issue.format === "ends_with") {
          return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F "${_issue.suffix}" \u0633\u0631\u0647 \u067E\u0627\u06CC \u062A\u0647 \u0648\u0631\u0633\u064A\u0696\u064A`;
        }
        if (_issue.format === "includes") {
          return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F "${_issue.includes}" \u0648\u0644\u0631\u064A`;
        }
        if (_issue.format === "regex") {
          return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F ${_issue.pattern} \u0633\u0631\u0647 \u0645\u0637\u0627\u0628\u0642\u062A \u0648\u0644\u0631\u064A`;
        }
        return `${Nouns[_issue.format] ?? issue2.format} \u0646\u0627\u0633\u0645 \u062F\u06CC`;
      }
      case "not_multiple_of":
        return `\u0646\u0627\u0633\u0645 \u0639\u062F\u062F: \u0628\u0627\u06CC\u062F \u062F ${issue2.divisor} \u0645\u0636\u0631\u0628 \u0648\u064A`;
      case "unrecognized_keys":
        return `\u0646\u0627\u0633\u0645 ${issue2.keys.length > 1 ? "\u06A9\u0644\u06CC\u0689\u0648\u0646\u0647" : "\u06A9\u0644\u06CC\u0689"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u0646\u0627\u0633\u0645 \u06A9\u0644\u06CC\u0689 \u067E\u0647 ${issue2.origin} \u06A9\u06D0`;
      case "invalid_union":
        return `\u0646\u0627\u0633\u0645\u0647 \u0648\u0631\u0648\u062F\u064A`;
      case "invalid_element":
        return `\u0646\u0627\u0633\u0645 \u0639\u0646\u0635\u0631 \u067E\u0647 ${issue2.origin} \u06A9\u06D0`;
      default:
        return `\u0646\u0627\u0633\u0645\u0647 \u0648\u0631\u0648\u062F\u064A`;
    }
  };
};
function ps_default() {
  return {
    localeError: error30()
  };
}

// node_modules/zod/v4/locales/pl.js
var error31 = () => {
  const Sizable = {
    string: { unit: "znak\xF3w", verb: "mie\u0107" },
    file: { unit: "bajt\xF3w", verb: "mie\u0107" },
    array: { unit: "element\xF3w", verb: "mie\u0107" },
    set: { unit: "element\xF3w", verb: "mie\u0107" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "liczba";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tablica";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "wyra\u017Cenie",
    email: "adres email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data i godzina w formacie ISO",
    date: "data w formacie ISO",
    time: "godzina w formacie ISO",
    duration: "czas trwania ISO",
    ipv4: "adres IPv4",
    ipv6: "adres IPv6",
    cidrv4: "zakres IPv4",
    cidrv6: "zakres IPv6",
    base64: "ci\u0105g znak\xF3w zakodowany w formacie base64",
    base64url: "ci\u0105g znak\xF3w zakodowany w formacie base64url",
    json_string: "ci\u0105g znak\xF3w w formacie JSON",
    e164: "liczba E.164",
    jwt: "JWT",
    template_literal: "wej\u015Bcie"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Nieprawid\u0142owe dane wej\u015Bciowe: oczekiwano ${issue2.expected}, otrzymano ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Nieprawid\u0142owe dane wej\u015Bciowe: oczekiwano ${stringifyPrimitive(issue2.values[0])}`;
        return `Nieprawid\u0142owa opcja: oczekiwano jednej z warto\u015Bci ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Za du\u017Ca warto\u015B\u0107: oczekiwano, \u017Ce ${issue2.origin ?? "warto\u015B\u0107"} b\u0119dzie mie\u0107 ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "element\xF3w"}`;
        }
        return `Zbyt du\u017C(y/a/e): oczekiwano, \u017Ce ${issue2.origin ?? "warto\u015B\u0107"} b\u0119dzie wynosi\u0107 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Za ma\u0142a warto\u015B\u0107: oczekiwano, \u017Ce ${issue2.origin ?? "warto\u015B\u0107"} b\u0119dzie mie\u0107 ${adj}${issue2.minimum.toString()} ${sizing.unit ?? "element\xF3w"}`;
        }
        return `Zbyt ma\u0142(y/a/e): oczekiwano, \u017Ce ${issue2.origin ?? "warto\u015B\u0107"} b\u0119dzie wynosi\u0107 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi zaczyna\u0107 si\u0119 od "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi ko\u0144czy\u0107 si\u0119 na "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi zawiera\u0107 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi odpowiada\u0107 wzorcowi ${_issue.pattern}`;
        return `Nieprawid\u0142ow(y/a/e) ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Nieprawid\u0142owa liczba: musi by\u0107 wielokrotno\u015Bci\u0105 ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Nierozpoznane klucze${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Nieprawid\u0142owy klucz w ${issue2.origin}`;
      case "invalid_union":
        return "Nieprawid\u0142owe dane wej\u015Bciowe";
      case "invalid_element":
        return `Nieprawid\u0142owa warto\u015B\u0107 w ${issue2.origin}`;
      default:
        return `Nieprawid\u0142owe dane wej\u015Bciowe`;
    }
  };
};
function pl_default() {
  return {
    localeError: error31()
  };
}

// node_modules/zod/v4/locales/pt.js
var error32 = () => {
  const Sizable = {
    string: { unit: "caracteres", verb: "ter" },
    file: { unit: "bytes", verb: "ter" },
    array: { unit: "itens", verb: "ter" },
    set: { unit: "itens", verb: "ter" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "n\xFAmero";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "nulo";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "padr\xE3o",
    email: "endere\xE7o de e-mail",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data e hora ISO",
    date: "data ISO",
    time: "hora ISO",
    duration: "dura\xE7\xE3o ISO",
    ipv4: "endere\xE7o IPv4",
    ipv6: "endere\xE7o IPv6",
    cidrv4: "faixa de IPv4",
    cidrv6: "faixa de IPv6",
    base64: "texto codificado em base64",
    base64url: "URL codificada em base64",
    json_string: "texto JSON",
    e164: "n\xFAmero E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Tipo inv\xE1lido: esperado ${issue2.expected}, recebido ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entrada inv\xE1lida: esperado ${stringifyPrimitive(issue2.values[0])}`;
        return `Op\xE7\xE3o inv\xE1lida: esperada uma das ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Muito grande: esperado que ${issue2.origin ?? "valor"} tivesse ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementos"}`;
        return `Muito grande: esperado que ${issue2.origin ?? "valor"} fosse ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Muito pequeno: esperado que ${issue2.origin} tivesse ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Muito pequeno: esperado que ${issue2.origin} fosse ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Texto inv\xE1lido: deve come\xE7ar com "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Texto inv\xE1lido: deve terminar com "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Texto inv\xE1lido: deve incluir "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Texto inv\xE1lido: deve corresponder ao padr\xE3o ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} inv\xE1lido`;
      }
      case "not_multiple_of":
        return `N\xFAmero inv\xE1lido: deve ser m\xFAltiplo de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Chave${issue2.keys.length > 1 ? "s" : ""} desconhecida${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Chave inv\xE1lida em ${issue2.origin}`;
      case "invalid_union":
        return "Entrada inv\xE1lida";
      case "invalid_element":
        return `Valor inv\xE1lido em ${issue2.origin}`;
      default:
        return `Campo inv\xE1lido`;
    }
  };
};
function pt_default() {
  return {
    localeError: error32()
  };
}

// node_modules/zod/v4/locales/ru.js
function getRussianPlural(count, one, few, many) {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return many;
  }
  if (lastDigit === 1) {
    return one;
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }
  return many;
}
var error33 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "\u0441\u0438\u043C\u0432\u043E\u043B",
        few: "\u0441\u0438\u043C\u0432\u043E\u043B\u0430",
        many: "\u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432"
      },
      verb: "\u0438\u043C\u0435\u0442\u044C"
    },
    file: {
      unit: {
        one: "\u0431\u0430\u0439\u0442",
        few: "\u0431\u0430\u0439\u0442\u0430",
        many: "\u0431\u0430\u0439\u0442"
      },
      verb: "\u0438\u043C\u0435\u0442\u044C"
    },
    array: {
      unit: {
        one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442",
        few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430",
        many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432"
      },
      verb: "\u0438\u043C\u0435\u0442\u044C"
    },
    set: {
      unit: {
        one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442",
        few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430",
        many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432"
      },
      verb: "\u0438\u043C\u0435\u0442\u044C"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\u0447\u0438\u0441\u043B\u043E";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\u043C\u0430\u0441\u0441\u0438\u0432";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u0432\u0432\u043E\u0434",
    email: "email \u0430\u0434\u0440\u0435\u0441",
    url: "URL",
    emoji: "\u044D\u043C\u043E\u0434\u0437\u0438",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \u0434\u0430\u0442\u0430 \u0438 \u0432\u0440\u0435\u043C\u044F",
    date: "ISO \u0434\u0430\u0442\u0430",
    time: "ISO \u0432\u0440\u0435\u043C\u044F",
    duration: "ISO \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C",
    ipv4: "IPv4 \u0430\u0434\u0440\u0435\u0441",
    ipv6: "IPv6 \u0430\u0434\u0440\u0435\u0441",
    cidrv4: "IPv4 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D",
    cidrv6: "IPv6 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D",
    base64: "\u0441\u0442\u0440\u043E\u043A\u0430 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 base64",
    base64url: "\u0441\u0442\u0440\u043E\u043A\u0430 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 base64url",
    json_string: "JSON \u0441\u0442\u0440\u043E\u043A\u0430",
    e164: "\u043D\u043E\u043C\u0435\u0440 E.164",
    jwt: "JWT",
    template_literal: "\u0432\u0432\u043E\u0434"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C ${issue2.expected}, \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C ${stringifyPrimitive(issue2.values[0])}`;
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0430\u0440\u0438\u0430\u043D\u0442: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0434\u043D\u043E \u0438\u0437 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const maxValue = Number(issue2.maximum);
          const unit = getRussianPlural(maxValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${issue2.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435"} \u0431\u0443\u0434\u0435\u0442 \u0438\u043C\u0435\u0442\u044C ${adj}${issue2.maximum.toString()} ${unit}`;
        }
        return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${issue2.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435"} \u0431\u0443\u0434\u0435\u0442 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const minValue = Number(issue2.minimum);
          const unit = getRussianPlural(minValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u0430\u043B\u0435\u043D\u044C\u043A\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${issue2.origin} \u0431\u0443\u0434\u0435\u0442 \u0438\u043C\u0435\u0442\u044C ${adj}${issue2.minimum.toString()} ${unit}`;
        }
        return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u0430\u043B\u0435\u043D\u044C\u043A\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${issue2.origin} \u0431\u0443\u0434\u0435\u0442 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0437\u0430\u043A\u0430\u043D\u0447\u0438\u0432\u0430\u0442\u044C\u0441\u044F \u043D\u0430 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0441\u043E\u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u043E\u0432\u0430\u0442\u044C \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${_issue.pattern}`;
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u043E\u0435 \u0447\u0438\u0441\u043B\u043E: \u0434\u043E\u043B\u0436\u043D\u043E \u0431\u044B\u0442\u044C \u043A\u0440\u0430\u0442\u043D\u044B\u043C ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D\u043D${issue2.keys.length > 1 ? "\u044B\u0435" : "\u044B\u0439"} \u043A\u043B\u044E\u0447${issue2.keys.length > 1 ? "\u0438" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u043A\u043B\u044E\u0447 \u0432 ${issue2.origin}`;
      case "invalid_union":
        return "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0435 \u0432\u0445\u043E\u0434\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435";
      case "invalid_element":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 \u0432 ${issue2.origin}`;
      default:
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0435 \u0432\u0445\u043E\u0434\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435`;
    }
  };
};
function ru_default() {
  return {
    localeError: error33()
  };
}

// node_modules/zod/v4/locales/sl.js
var error34 = () => {
  const Sizable = {
    string: { unit: "znakov", verb: "imeti" },
    file: { unit: "bajtov", verb: "imeti" },
    array: { unit: "elementov", verb: "imeti" },
    set: { unit: "elementov", verb: "imeti" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\u0161tevilo";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tabela";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "vnos",
    email: "e-po\u0161tni naslov",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datum in \u010Das",
    date: "ISO datum",
    time: "ISO \u010Das",
    duration: "ISO trajanje",
    ipv4: "IPv4 naslov",
    ipv6: "IPv6 naslov",
    cidrv4: "obseg IPv4",
    cidrv6: "obseg IPv6",
    base64: "base64 kodiran niz",
    base64url: "base64url kodiran niz",
    json_string: "JSON niz",
    e164: "E.164 \u0161tevilka",
    jwt: "JWT",
    template_literal: "vnos"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Neveljaven vnos: pri\u010Dakovano ${issue2.expected}, prejeto ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Neveljaven vnos: pri\u010Dakovano ${stringifyPrimitive(issue2.values[0])}`;
        return `Neveljavna mo\u017Enost: pri\u010Dakovano eno izmed ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Preveliko: pri\u010Dakovano, da bo ${issue2.origin ?? "vrednost"} imelo ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementov"}`;
        return `Preveliko: pri\u010Dakovano, da bo ${issue2.origin ?? "vrednost"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Premajhno: pri\u010Dakovano, da bo ${issue2.origin} imelo ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Premajhno: pri\u010Dakovano, da bo ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Neveljaven niz: mora se za\u010Deti z "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Neveljaven niz: mora se kon\u010Dati z "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Neveljaven niz: mora vsebovati "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Neveljaven niz: mora ustrezati vzorcu ${_issue.pattern}`;
        return `Neveljaven ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Neveljavno \u0161tevilo: mora biti ve\u010Dkratnik ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Neprepoznan${issue2.keys.length > 1 ? "i klju\u010Di" : " klju\u010D"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Neveljaven klju\u010D v ${issue2.origin}`;
      case "invalid_union":
        return "Neveljaven vnos";
      case "invalid_element":
        return `Neveljavna vrednost v ${issue2.origin}`;
      default:
        return "Neveljaven vnos";
    }
  };
};
function sl_default() {
  return {
    localeError: error34()
  };
}

// node_modules/zod/v4/locales/sv.js
var error35 = () => {
  const Sizable = {
    string: { unit: "tecken", verb: "att ha" },
    file: { unit: "bytes", verb: "att ha" },
    array: { unit: "objekt", verb: "att inneh\xE5lla" },
    set: { unit: "objekt", verb: "att inneh\xE5lla" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "antal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "lista";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "regulj\xE4rt uttryck",
    email: "e-postadress",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-datum och tid",
    date: "ISO-datum",
    time: "ISO-tid",
    duration: "ISO-varaktighet",
    ipv4: "IPv4-intervall",
    ipv6: "IPv6-intervall",
    cidrv4: "IPv4-spektrum",
    cidrv6: "IPv6-spektrum",
    base64: "base64-kodad str\xE4ng",
    base64url: "base64url-kodad str\xE4ng",
    json_string: "JSON-str\xE4ng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "mall-literal"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ogiltig inmatning: f\xF6rv\xE4ntat ${issue2.expected}, fick ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ogiltig inmatning: f\xF6rv\xE4ntat ${stringifyPrimitive(issue2.values[0])}`;
        return `Ogiltigt val: f\xF6rv\xE4ntade en av ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `F\xF6r stor(t): f\xF6rv\xE4ntade ${issue2.origin ?? "v\xE4rdet"} att ha ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "element"}`;
        }
        return `F\xF6r stor(t): f\xF6rv\xE4ntat ${issue2.origin ?? "v\xE4rdet"} att ha ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `F\xF6r lite(t): f\xF6rv\xE4ntade ${issue2.origin ?? "v\xE4rdet"} att ha ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `F\xF6r lite(t): f\xF6rv\xE4ntade ${issue2.origin ?? "v\xE4rdet"} att ha ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Ogiltig str\xE4ng: m\xE5ste b\xF6rja med "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Ogiltig str\xE4ng: m\xE5ste sluta med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ogiltig str\xE4ng: m\xE5ste inneh\xE5lla "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ogiltig str\xE4ng: m\xE5ste matcha m\xF6nstret "${_issue.pattern}"`;
        return `Ogiltig(t) ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ogiltigt tal: m\xE5ste vara en multipel av ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Ok\xE4nda nycklar" : "Ok\xE4nd nyckel"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ogiltig nyckel i ${issue2.origin ?? "v\xE4rdet"}`;
      case "invalid_union":
        return "Ogiltig input";
      case "invalid_element":
        return `Ogiltigt v\xE4rde i ${issue2.origin ?? "v\xE4rdet"}`;
      default:
        return `Ogiltig input`;
    }
  };
};
function sv_default() {
  return {
    localeError: error35()
  };
}

// node_modules/zod/v4/locales/ta.js
var error36 = () => {
  const Sizable = {
    string: { unit: "\u0B8E\u0BB4\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1\u0B95\u0BCD\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" },
    file: { unit: "\u0BAA\u0BC8\u0B9F\u0BCD\u0B9F\u0BC1\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" },
    array: { unit: "\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" },
    set: { unit: "\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "\u0B8E\u0BA3\u0BCD \u0B85\u0BB2\u0BCD\u0BB2\u0BBE\u0BA4\u0BA4\u0BC1" : "\u0B8E\u0BA3\u0BCD";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\u0B85\u0BA3\u0BBF";
        }
        if (data === null) {
          return "\u0BB5\u0BC6\u0BB1\u0BC1\u0BAE\u0BC8";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1",
    email: "\u0BAE\u0BBF\u0BA9\u0BCD\u0BA9\u0B9E\u0BCD\u0B9A\u0BB2\u0BCD \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \u0BA4\u0BC7\u0BA4\u0BBF \u0BA8\u0BC7\u0BB0\u0BAE\u0BCD",
    date: "ISO \u0BA4\u0BC7\u0BA4\u0BBF",
    time: "ISO \u0BA8\u0BC7\u0BB0\u0BAE\u0BCD",
    duration: "ISO \u0B95\u0BBE\u0BB2 \u0B85\u0BB3\u0BB5\u0BC1",
    ipv4: "IPv4 \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF",
    ipv6: "IPv6 \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF",
    cidrv4: "IPv4 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1",
    cidrv6: "IPv6 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1",
    base64: "base64-encoded \u0B9A\u0BB0\u0BAE\u0BCD",
    base64url: "base64url-encoded \u0B9A\u0BB0\u0BAE\u0BCD",
    json_string: "JSON \u0B9A\u0BB0\u0BAE\u0BCD",
    e164: "E.164 \u0B8E\u0BA3\u0BCD",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${issue2.expected}, \u0BAA\u0BC6\u0BB1\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${stringifyPrimitive(issue2.values[0])}`;
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BB5\u0BBF\u0BB0\u0BC1\u0BAA\u0BCD\u0BAA\u0BAE\u0BCD: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${joinValues(issue2.values, "|")} \u0B87\u0BB2\u0BCD \u0B92\u0BA9\u0BCD\u0BB1\u0BC1`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0BAE\u0BBF\u0B95 \u0BAA\u0BC6\u0BB0\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${issue2.origin ?? "\u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD"} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        }
        return `\u0BAE\u0BBF\u0B95 \u0BAA\u0BC6\u0BB0\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${issue2.origin ?? "\u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1"} ${adj}${issue2.maximum.toString()} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0BAE\u0BBF\u0B95\u0B9A\u0BCD \u0B9A\u0BBF\u0BB1\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        }
        return `\u0BAE\u0BBF\u0B95\u0B9A\u0BCD \u0B9A\u0BBF\u0BB1\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${issue2.origin} ${adj}${issue2.minimum.toString()} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${_issue.prefix}" \u0B87\u0BB2\u0BCD \u0BA4\u0BCA\u0B9F\u0B99\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        if (_issue.format === "ends_with")
          return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${_issue.suffix}" \u0B87\u0BB2\u0BCD \u0BAE\u0BC1\u0B9F\u0BBF\u0BB5\u0B9F\u0BC8\u0BAF \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        if (_issue.format === "includes")
          return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${_issue.includes}" \u0B90 \u0B89\u0BB3\u0BCD\u0BB3\u0B9F\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        if (_issue.format === "regex")
          return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: ${_issue.pattern} \u0BAE\u0BC1\u0BB1\u0BC8\u0BAA\u0BBE\u0B9F\u0BCD\u0B9F\u0BC1\u0B9F\u0BA9\u0BCD \u0BAA\u0BCA\u0BB0\u0BC1\u0BA8\u0BCD\u0BA4 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B8E\u0BA3\u0BCD: ${issue2.divisor} \u0B87\u0BA9\u0BCD \u0BAA\u0BB2\u0BAE\u0BBE\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      case "unrecognized_keys":
        return `\u0B85\u0B9F\u0BC8\u0BAF\u0BBE\u0BB3\u0BAE\u0BCD \u0BA4\u0BC6\u0BB0\u0BBF\u0BAF\u0BBE\u0BA4 \u0BB5\u0BBF\u0B9A\u0BC8${issue2.keys.length > 1 ? "\u0B95\u0BB3\u0BCD" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} \u0B87\u0BB2\u0BCD \u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BB5\u0BBF\u0B9A\u0BC8`;
      case "invalid_union":
        return "\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1";
      case "invalid_element":
        return `${issue2.origin} \u0B87\u0BB2\u0BCD \u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1`;
      default:
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1`;
    }
  };
};
function ta_default() {
  return {
    localeError: error36()
  };
}

// node_modules/zod/v4/locales/th.js
var error37 = () => {
  const Sizable = {
    string: { unit: "\u0E15\u0E31\u0E27\u0E2D\u0E31\u0E01\u0E29\u0E23", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" },
    file: { unit: "\u0E44\u0E1A\u0E15\u0E4C", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" },
    array: { unit: "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" },
    set: { unit: "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "\u0E44\u0E21\u0E48\u0E43\u0E0A\u0E48\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02 (NaN)" : "\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\u0E2D\u0E32\u0E23\u0E4C\u0E40\u0E23\u0E22\u0E4C (Array)";
        }
        if (data === null) {
          return "\u0E44\u0E21\u0E48\u0E21\u0E35\u0E04\u0E48\u0E32 (null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E35\u0E48\u0E1B\u0E49\u0E2D\u0E19",
    email: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48\u0E2D\u0E35\u0E40\u0E21\u0E25",
    url: "URL",
    emoji: "\u0E2D\u0E34\u0E42\u0E21\u0E08\u0E34",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO",
    date: "\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E41\u0E1A\u0E1A ISO",
    time: "\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO",
    duration: "\u0E0A\u0E48\u0E27\u0E07\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO",
    ipv4: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48 IPv4",
    ipv6: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48 IPv6",
    cidrv4: "\u0E0A\u0E48\u0E27\u0E07 IP \u0E41\u0E1A\u0E1A IPv4",
    cidrv6: "\u0E0A\u0E48\u0E27\u0E07 IP \u0E41\u0E1A\u0E1A IPv6",
    base64: "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A Base64",
    base64url: "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A Base64 \u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A URL",
    json_string: "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A JSON",
    e164: "\u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E42\u0E17\u0E23\u0E28\u0E31\u0E1E\u0E17\u0E4C\u0E23\u0E30\u0E2B\u0E27\u0E48\u0E32\u0E07\u0E1B\u0E23\u0E30\u0E40\u0E17\u0E28 (E.164)",
    jwt: "\u0E42\u0E17\u0E40\u0E04\u0E19 JWT",
    template_literal: "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E35\u0E48\u0E1B\u0E49\u0E2D\u0E19"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19 ${issue2.expected} \u0E41\u0E15\u0E48\u0E44\u0E14\u0E49\u0E23\u0E31\u0E1A ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u0E04\u0E48\u0E32\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19 ${stringifyPrimitive(issue2.values[0])}`;
        return `\u0E15\u0E31\u0E27\u0E40\u0E25\u0E37\u0E2D\u0E01\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19\u0E2B\u0E19\u0E36\u0E48\u0E07\u0E43\u0E19 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "\u0E44\u0E21\u0E48\u0E40\u0E01\u0E34\u0E19" : "\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u0E40\u0E01\u0E34\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14: ${issue2.origin ?? "\u0E04\u0E48\u0E32"} \u0E04\u0E27\u0E23\u0E21\u0E35${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23"}`;
        return `\u0E40\u0E01\u0E34\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14: ${issue2.origin ?? "\u0E04\u0E48\u0E32"} \u0E04\u0E27\u0E23\u0E21\u0E35${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "\u0E2D\u0E22\u0E48\u0E32\u0E07\u0E19\u0E49\u0E2D\u0E22" : "\u0E21\u0E32\u0E01\u0E01\u0E27\u0E48\u0E32";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32\u0E01\u0E33\u0E2B\u0E19\u0E14: ${issue2.origin} \u0E04\u0E27\u0E23\u0E21\u0E35${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32\u0E01\u0E33\u0E2B\u0E19\u0E14: ${issue2.origin} \u0E04\u0E27\u0E23\u0E21\u0E35${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E02\u0E36\u0E49\u0E19\u0E15\u0E49\u0E19\u0E14\u0E49\u0E27\u0E22 "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E25\u0E07\u0E17\u0E49\u0E32\u0E22\u0E14\u0E49\u0E27\u0E22 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E21\u0E35 "${_issue.includes}" \u0E2D\u0E22\u0E39\u0E48\u0E43\u0E19\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21`;
        if (_issue.format === "regex")
          return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E15\u0E49\u0E2D\u0E07\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E17\u0E35\u0E48\u0E01\u0E33\u0E2B\u0E19\u0E14 ${_issue.pattern}`;
        return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E15\u0E49\u0E2D\u0E07\u0E40\u0E1B\u0E47\u0E19\u0E08\u0E33\u0E19\u0E27\u0E19\u0E17\u0E35\u0E48\u0E2B\u0E32\u0E23\u0E14\u0E49\u0E27\u0E22 ${issue2.divisor} \u0E44\u0E14\u0E49\u0E25\u0E07\u0E15\u0E31\u0E27`;
      case "unrecognized_keys":
        return `\u0E1E\u0E1A\u0E04\u0E35\u0E22\u0E4C\u0E17\u0E35\u0E48\u0E44\u0E21\u0E48\u0E23\u0E39\u0E49\u0E08\u0E31\u0E01: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u0E04\u0E35\u0E22\u0E4C\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E19 ${issue2.origin}`;
      case "invalid_union":
        return "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E44\u0E21\u0E48\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E22\u0E39\u0E40\u0E19\u0E35\u0E22\u0E19\u0E17\u0E35\u0E48\u0E01\u0E33\u0E2B\u0E19\u0E14\u0E44\u0E27\u0E49";
      case "invalid_element":
        return `\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E19 ${issue2.origin}`;
      default:
        return `\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07`;
    }
  };
};
function th_default() {
  return {
    localeError: error37()
  };
}

// node_modules/zod/v4/locales/tr.js
var parsedType6 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "number";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error38 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "olmal\u0131" },
    file: { unit: "bayt", verb: "olmal\u0131" },
    array: { unit: "\xF6\u011Fe", verb: "olmal\u0131" },
    set: { unit: "\xF6\u011Fe", verb: "olmal\u0131" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "girdi",
    email: "e-posta adresi",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO tarih ve saat",
    date: "ISO tarih",
    time: "ISO saat",
    duration: "ISO s\xFCre",
    ipv4: "IPv4 adresi",
    ipv6: "IPv6 adresi",
    cidrv4: "IPv4 aral\u0131\u011F\u0131",
    cidrv6: "IPv6 aral\u0131\u011F\u0131",
    base64: "base64 ile \u015Fifrelenmi\u015F metin",
    base64url: "base64url ile \u015Fifrelenmi\u015F metin",
    json_string: "JSON dizesi",
    e164: "E.164 say\u0131s\u0131",
    jwt: "JWT",
    template_literal: "\u015Eablon dizesi"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ge\xE7ersiz de\u011Fer: beklenen ${issue2.expected}, al\u0131nan ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ge\xE7ersiz de\u011Fer: beklenen ${stringifyPrimitive(issue2.values[0])}`;
        return `Ge\xE7ersiz se\xE7enek: a\u015Fa\u011F\u0131dakilerden biri olmal\u0131: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\xC7ok b\xFCy\xFCk: beklenen ${issue2.origin ?? "de\u011Fer"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\xF6\u011Fe"}`;
        return `\xC7ok b\xFCy\xFCk: beklenen ${issue2.origin ?? "de\u011Fer"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\xC7ok k\xFC\xE7\xFCk: beklenen ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        return `\xC7ok k\xFC\xE7\xFCk: beklenen ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ge\xE7ersiz metin: "${_issue.prefix}" ile ba\u015Flamal\u0131`;
        if (_issue.format === "ends_with")
          return `Ge\xE7ersiz metin: "${_issue.suffix}" ile bitmeli`;
        if (_issue.format === "includes")
          return `Ge\xE7ersiz metin: "${_issue.includes}" i\xE7ermeli`;
        if (_issue.format === "regex")
          return `Ge\xE7ersiz metin: ${_issue.pattern} desenine uymal\u0131`;
        return `Ge\xE7ersiz ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ge\xE7ersiz say\u0131: ${issue2.divisor} ile tam b\xF6l\xFCnebilmeli`;
      case "unrecognized_keys":
        return `Tan\u0131nmayan anahtar${issue2.keys.length > 1 ? "lar" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} i\xE7inde ge\xE7ersiz anahtar`;
      case "invalid_union":
        return "Ge\xE7ersiz de\u011Fer";
      case "invalid_element":
        return `${issue2.origin} i\xE7inde ge\xE7ersiz de\u011Fer`;
      default:
        return `Ge\xE7ersiz de\u011Fer`;
    }
  };
};
function tr_default() {
  return {
    localeError: error38()
  };
}

// node_modules/zod/v4/locales/uk.js
var error39 = () => {
  const Sizable = {
    string: { unit: "\u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" },
    file: { unit: "\u0431\u0430\u0439\u0442\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" },
    array: { unit: "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" },
    set: { unit: "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\u0447\u0438\u0441\u043B\u043E";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\u043C\u0430\u0441\u0438\u0432";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456",
    email: "\u0430\u0434\u0440\u0435\u0441\u0430 \u0435\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u0457 \u043F\u043E\u0448\u0442\u0438",
    url: "URL",
    emoji: "\u0435\u043C\u043E\u0434\u0437\u0456",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\u0434\u0430\u0442\u0430 \u0442\u0430 \u0447\u0430\u0441 ISO",
    date: "\u0434\u0430\u0442\u0430 ISO",
    time: "\u0447\u0430\u0441 ISO",
    duration: "\u0442\u0440\u0438\u0432\u0430\u043B\u0456\u0441\u0442\u044C ISO",
    ipv4: "\u0430\u0434\u0440\u0435\u0441\u0430 IPv4",
    ipv6: "\u0430\u0434\u0440\u0435\u0441\u0430 IPv6",
    cidrv4: "\u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D IPv4",
    cidrv6: "\u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D IPv6",
    base64: "\u0440\u044F\u0434\u043E\u043A \u0443 \u043A\u043E\u0434\u0443\u0432\u0430\u043D\u043D\u0456 base64",
    base64url: "\u0440\u044F\u0434\u043E\u043A \u0443 \u043A\u043E\u0434\u0443\u0432\u0430\u043D\u043D\u0456 base64url",
    json_string: "\u0440\u044F\u0434\u043E\u043A JSON",
    e164: "\u043D\u043E\u043C\u0435\u0440 E.164",
    jwt: "JWT",
    template_literal: "\u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F ${issue2.expected}, \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E ${parsedType7(issue2.input)}`;
      // return `Неправильні вхідні дані: очікується ${issue.expected}, отримано ${util.getParsedType(issue.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F ${stringifyPrimitive(issue2.values[0])}`;
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0430 \u043E\u043F\u0446\u0456\u044F: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F \u043E\u0434\u043D\u0435 \u0437 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u0432\u0435\u043B\u0438\u043A\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${issue2.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432"}`;
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u0432\u0435\u043B\u0438\u043A\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${issue2.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F"} \u0431\u0443\u0434\u0435 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u043C\u0430\u043B\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u043C\u0430\u043B\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${issue2.origin} \u0431\u0443\u0434\u0435 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u043F\u043E\u0447\u0438\u043D\u0430\u0442\u0438\u0441\u044F \u0437 "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u0437\u0430\u043A\u0456\u043D\u0447\u0443\u0432\u0430\u0442\u0438\u0441\u044F \u043D\u0430 "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u043C\u0456\u0441\u0442\u0438\u0442\u0438 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0430\u0442\u0438 \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${_issue.pattern}`;
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0435 \u0447\u0438\u0441\u043B\u043E: \u043F\u043E\u0432\u0438\u043D\u043D\u043E \u0431\u0443\u0442\u0438 \u043A\u0440\u0430\u0442\u043D\u0438\u043C ${issue2.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u043E\u0437\u043F\u0456\u0437\u043D\u0430\u043D\u0438\u0439 \u043A\u043B\u044E\u0447${issue2.keys.length > 1 ? "\u0456" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u043A\u043B\u044E\u0447 \u0443 ${issue2.origin}`;
      case "invalid_union":
        return "\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456";
      case "invalid_element":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u0443 ${issue2.origin}`;
      default:
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456`;
    }
  };
};
function uk_default() {
  return {
    localeError: error39()
  };
}

// node_modules/zod/v4/locales/ua.js
function ua_default() {
  return uk_default();
}

// node_modules/zod/v4/locales/ur.js
var error40 = () => {
  const Sizable = {
    string: { unit: "\u062D\u0631\u0648\u0641", verb: "\u06C1\u0648\u0646\u0627" },
    file: { unit: "\u0628\u0627\u0626\u0679\u0633", verb: "\u06C1\u0648\u0646\u0627" },
    array: { unit: "\u0622\u0626\u0679\u0645\u0632", verb: "\u06C1\u0648\u0646\u0627" },
    set: { unit: "\u0622\u0626\u0679\u0645\u0632", verb: "\u06C1\u0648\u0646\u0627" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "\u0646\u0645\u0628\u0631";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\u0622\u0631\u06D2";
        }
        if (data === null) {
          return "\u0646\u0644";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u0627\u0646 \u067E\u0679",
    email: "\u0627\u06CC \u0645\u06CC\u0644 \u0627\u06CC\u0688\u0631\u06CC\u0633",
    url: "\u06CC\u0648 \u0622\u0631 \u0627\u06CC\u0644",
    emoji: "\u0627\u06CC\u0645\u0648\u062C\u06CC",
    uuid: "\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC",
    uuidv4: "\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC \u0648\u06CC 4",
    uuidv6: "\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC \u0648\u06CC 6",
    nanoid: "\u0646\u06CC\u0646\u0648 \u0622\u0626\u06CC \u0688\u06CC",
    guid: "\u062C\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC",
    cuid: "\u0633\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC",
    cuid2: "\u0633\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC 2",
    ulid: "\u06CC\u0648 \u0627\u06CC\u0644 \u0622\u0626\u06CC \u0688\u06CC",
    xid: "\u0627\u06CC\u06A9\u0633 \u0622\u0626\u06CC \u0688\u06CC",
    ksuid: "\u06A9\u06D2 \u0627\u06CC\u0633 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC",
    datetime: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0688\u06CC\u0679 \u0679\u0627\u0626\u0645",
    date: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u062A\u0627\u0631\u06CC\u062E",
    time: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0648\u0642\u062A",
    duration: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0645\u062F\u062A",
    ipv4: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 4 \u0627\u06CC\u0688\u0631\u06CC\u0633",
    ipv6: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 6 \u0627\u06CC\u0688\u0631\u06CC\u0633",
    cidrv4: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 4 \u0631\u06CC\u0646\u062C",
    cidrv6: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 6 \u0631\u06CC\u0646\u062C",
    base64: "\u0628\u06CC\u0633 64 \u0627\u0646 \u06A9\u0648\u0688\u0688 \u0633\u0679\u0631\u0646\u06AF",
    base64url: "\u0628\u06CC\u0633 64 \u06CC\u0648 \u0622\u0631 \u0627\u06CC\u0644 \u0627\u0646 \u06A9\u0648\u0688\u0688 \u0633\u0679\u0631\u0646\u06AF",
    json_string: "\u062C\u06D2 \u0627\u06CC\u0633 \u0627\u0648 \u0627\u06CC\u0646 \u0633\u0679\u0631\u0646\u06AF",
    e164: "\u0627\u06CC 164 \u0646\u0645\u0628\u0631",
    jwt: "\u062C\u06D2 \u0688\u0628\u0644\u06CC\u0648 \u0679\u06CC",
    template_literal: "\u0627\u0646 \u067E\u0679"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679: ${issue2.expected} \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627\u060C ${parsedType7(issue2.input)} \u0645\u0648\u0635\u0648\u0644 \u06C1\u0648\u0627`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679: ${stringifyPrimitive(issue2.values[0])} \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
        return `\u063A\u0644\u0637 \u0622\u067E\u0634\u0646: ${joinValues(issue2.values, "|")} \u0645\u06CC\u06BA \u0633\u06D2 \u0627\u06CC\u06A9 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u0628\u06C1\u062A \u0628\u0691\u0627: ${issue2.origin ?? "\u0648\u06CC\u0644\u06CC\u0648"} \u06A9\u06D2 ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u0639\u0646\u0627\u0635\u0631"} \u06C1\u0648\u0646\u06D2 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u06D2`;
        return `\u0628\u06C1\u062A \u0628\u0691\u0627: ${issue2.origin ?? "\u0648\u06CC\u0644\u06CC\u0648"} \u06A9\u0627 ${adj}${issue2.maximum.toString()} \u06C1\u0648\u0646\u0627 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u0628\u06C1\u062A \u0686\u06BE\u0648\u0679\u0627: ${issue2.origin} \u06A9\u06D2 ${adj}${issue2.minimum.toString()} ${sizing.unit} \u06C1\u0648\u0646\u06D2 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u06D2`;
        }
        return `\u0628\u06C1\u062A \u0686\u06BE\u0648\u0679\u0627: ${issue2.origin} \u06A9\u0627 ${adj}${issue2.minimum.toString()} \u06C1\u0648\u0646\u0627 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${_issue.prefix}" \u0633\u06D2 \u0634\u0631\u0648\u0639 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        }
        if (_issue.format === "ends_with")
          return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${_issue.suffix}" \u067E\u0631 \u062E\u062A\u0645 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        if (_issue.format === "includes")
          return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${_issue.includes}" \u0634\u0627\u0645\u0644 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        if (_issue.format === "regex")
          return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: \u067E\u06CC\u0679\u0631\u0646 ${_issue.pattern} \u0633\u06D2 \u0645\u06CC\u0686 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        return `\u063A\u0644\u0637 ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u063A\u0644\u0637 \u0646\u0645\u0628\u0631: ${issue2.divisor} \u06A9\u0627 \u0645\u0636\u0627\u0639\u0641 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
      case "unrecognized_keys":
        return `\u063A\u06CC\u0631 \u062A\u0633\u0644\u06CC\u0645 \u0634\u062F\u06C1 \u06A9\u06CC${issue2.keys.length > 1 ? "\u0632" : ""}: ${joinValues(issue2.keys, "\u060C ")}`;
      case "invalid_key":
        return `${issue2.origin} \u0645\u06CC\u06BA \u063A\u0644\u0637 \u06A9\u06CC`;
      case "invalid_union":
        return "\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679";
      case "invalid_element":
        return `${issue2.origin} \u0645\u06CC\u06BA \u063A\u0644\u0637 \u0648\u06CC\u0644\u06CC\u0648`;
      default:
        return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679`;
    }
  };
};
function ur_default() {
  return {
    localeError: error40()
  };
}

// node_modules/zod/v4/locales/vi.js
var error41 = () => {
  const Sizable = {
    string: { unit: "k\xFD t\u1EF1", verb: "c\xF3" },
    file: { unit: "byte", verb: "c\xF3" },
    array: { unit: "ph\u1EA7n t\u1EED", verb: "c\xF3" },
    set: { unit: "ph\u1EA7n t\u1EED", verb: "c\xF3" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "s\u1ED1";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "m\u1EA3ng";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u0111\u1EA7u v\xE0o",
    email: "\u0111\u1ECBa ch\u1EC9 email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ng\xE0y gi\u1EDD ISO",
    date: "ng\xE0y ISO",
    time: "gi\u1EDD ISO",
    duration: "kho\u1EA3ng th\u1EDDi gian ISO",
    ipv4: "\u0111\u1ECBa ch\u1EC9 IPv4",
    ipv6: "\u0111\u1ECBa ch\u1EC9 IPv6",
    cidrv4: "d\u1EA3i IPv4",
    cidrv6: "d\u1EA3i IPv6",
    base64: "chu\u1ED7i m\xE3 h\xF3a base64",
    base64url: "chu\u1ED7i m\xE3 h\xF3a base64url",
    json_string: "chu\u1ED7i JSON",
    e164: "s\u1ED1 E.164",
    jwt: "JWT",
    template_literal: "\u0111\u1EA7u v\xE0o"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i ${issue2.expected}, nh\u1EADn \u0111\u01B0\u1EE3c ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i ${stringifyPrimitive(issue2.values[0])}`;
        return `T\xF9y ch\u1ECDn kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i m\u1ED9t trong c\xE1c gi\xE1 tr\u1ECB ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Qu\xE1 l\u1EDBn: mong \u0111\u1EE3i ${issue2.origin ?? "gi\xE1 tr\u1ECB"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "ph\u1EA7n t\u1EED"}`;
        return `Qu\xE1 l\u1EDBn: mong \u0111\u1EE3i ${issue2.origin ?? "gi\xE1 tr\u1ECB"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Qu\xE1 nh\u1ECF: mong \u0111\u1EE3i ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Qu\xE1 nh\u1ECF: mong \u0111\u1EE3i ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i b\u1EAFt \u0111\u1EA7u b\u1EB1ng "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i k\u1EBFt th\xFAc b\u1EB1ng "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i bao g\u1ED3m "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i kh\u1EDBp v\u1EDBi m\u1EABu ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} kh\xF4ng h\u1EE3p l\u1EC7`;
      }
      case "not_multiple_of":
        return `S\u1ED1 kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i l\xE0 b\u1ED9i s\u1ED1 c\u1EE7a ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Kh\xF3a kh\xF4ng \u0111\u01B0\u1EE3c nh\u1EADn d\u1EA1ng: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Kh\xF3a kh\xF4ng h\u1EE3p l\u1EC7 trong ${issue2.origin}`;
      case "invalid_union":
        return "\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7";
      case "invalid_element":
        return `Gi\xE1 tr\u1ECB kh\xF4ng h\u1EE3p l\u1EC7 trong ${issue2.origin}`;
      default:
        return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7`;
    }
  };
};
function vi_default() {
  return {
    localeError: error41()
  };
}

// node_modules/zod/v4/locales/zh-CN.js
var error42 = () => {
  const Sizable = {
    string: { unit: "\u5B57\u7B26", verb: "\u5305\u542B" },
    file: { unit: "\u5B57\u8282", verb: "\u5305\u542B" },
    array: { unit: "\u9879", verb: "\u5305\u542B" },
    set: { unit: "\u9879", verb: "\u5305\u542B" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "\u975E\u6570\u5B57(NaN)" : "\u6570\u5B57";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "\u6570\u7EC4";
        }
        if (data === null) {
          return "\u7A7A\u503C(null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u8F93\u5165",
    email: "\u7535\u5B50\u90AE\u4EF6",
    url: "URL",
    emoji: "\u8868\u60C5\u7B26\u53F7",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO\u65E5\u671F\u65F6\u95F4",
    date: "ISO\u65E5\u671F",
    time: "ISO\u65F6\u95F4",
    duration: "ISO\u65F6\u957F",
    ipv4: "IPv4\u5730\u5740",
    ipv6: "IPv6\u5730\u5740",
    cidrv4: "IPv4\u7F51\u6BB5",
    cidrv6: "IPv6\u7F51\u6BB5",
    base64: "base64\u7F16\u7801\u5B57\u7B26\u4E32",
    base64url: "base64url\u7F16\u7801\u5B57\u7B26\u4E32",
    json_string: "JSON\u5B57\u7B26\u4E32",
    e164: "E.164\u53F7\u7801",
    jwt: "JWT",
    template_literal: "\u8F93\u5165"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u65E0\u6548\u8F93\u5165\uFF1A\u671F\u671B ${issue2.expected}\uFF0C\u5B9E\u9645\u63A5\u6536 ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u65E0\u6548\u8F93\u5165\uFF1A\u671F\u671B ${stringifyPrimitive(issue2.values[0])}`;
        return `\u65E0\u6548\u9009\u9879\uFF1A\u671F\u671B\u4EE5\u4E0B\u4E4B\u4E00 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u6570\u503C\u8FC7\u5927\uFF1A\u671F\u671B ${issue2.origin ?? "\u503C"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u4E2A\u5143\u7D20"}`;
        return `\u6570\u503C\u8FC7\u5927\uFF1A\u671F\u671B ${issue2.origin ?? "\u503C"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u6570\u503C\u8FC7\u5C0F\uFF1A\u671F\u671B ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u6570\u503C\u8FC7\u5C0F\uFF1A\u671F\u671B ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u4EE5 "${_issue.prefix}" \u5F00\u5934`;
        if (_issue.format === "ends_with")
          return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u4EE5 "${_issue.suffix}" \u7ED3\u5C3E`;
        if (_issue.format === "includes")
          return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u5305\u542B "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u6EE1\u8DB3\u6B63\u5219\u8868\u8FBE\u5F0F ${_issue.pattern}`;
        return `\u65E0\u6548${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u65E0\u6548\u6570\u5B57\uFF1A\u5FC5\u987B\u662F ${issue2.divisor} \u7684\u500D\u6570`;
      case "unrecognized_keys":
        return `\u51FA\u73B0\u672A\u77E5\u7684\u952E(key): ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} \u4E2D\u7684\u952E(key)\u65E0\u6548`;
      case "invalid_union":
        return "\u65E0\u6548\u8F93\u5165";
      case "invalid_element":
        return `${issue2.origin} \u4E2D\u5305\u542B\u65E0\u6548\u503C(value)`;
      default:
        return `\u65E0\u6548\u8F93\u5165`;
    }
  };
};
function zh_CN_default() {
  return {
    localeError: error42()
  };
}

// node_modules/zod/v4/locales/zh-TW.js
var error43 = () => {
  const Sizable = {
    string: { unit: "\u5B57\u5143", verb: "\u64C1\u6709" },
    file: { unit: "\u4F4D\u5143\u7D44", verb: "\u64C1\u6709" },
    array: { unit: "\u9805\u76EE", verb: "\u64C1\u6709" },
    set: { unit: "\u9805\u76EE", verb: "\u64C1\u6709" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u8F38\u5165",
    email: "\u90F5\u4EF6\u5730\u5740",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO \u65E5\u671F\u6642\u9593",
    date: "ISO \u65E5\u671F",
    time: "ISO \u6642\u9593",
    duration: "ISO \u671F\u9593",
    ipv4: "IPv4 \u4F4D\u5740",
    ipv6: "IPv6 \u4F4D\u5740",
    cidrv4: "IPv4 \u7BC4\u570D",
    cidrv6: "IPv6 \u7BC4\u570D",
    base64: "base64 \u7DE8\u78BC\u5B57\u4E32",
    base64url: "base64url \u7DE8\u78BC\u5B57\u4E32",
    json_string: "JSON \u5B57\u4E32",
    e164: "E.164 \u6578\u503C",
    jwt: "JWT",
    template_literal: "\u8F38\u5165"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\u7121\u6548\u7684\u8F38\u5165\u503C\uFF1A\u9810\u671F\u70BA ${issue2.expected}\uFF0C\u4F46\u6536\u5230 ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\u7121\u6548\u7684\u8F38\u5165\u503C\uFF1A\u9810\u671F\u70BA ${stringifyPrimitive(issue2.values[0])}`;
        return `\u7121\u6548\u7684\u9078\u9805\uFF1A\u9810\u671F\u70BA\u4EE5\u4E0B\u5176\u4E2D\u4E4B\u4E00 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `\u6578\u503C\u904E\u5927\uFF1A\u9810\u671F ${issue2.origin ?? "\u503C"} \u61C9\u70BA ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "\u500B\u5143\u7D20"}`;
        return `\u6578\u503C\u904E\u5927\uFF1A\u9810\u671F ${issue2.origin ?? "\u503C"} \u61C9\u70BA ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `\u6578\u503C\u904E\u5C0F\uFF1A\u9810\u671F ${issue2.origin} \u61C9\u70BA ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `\u6578\u503C\u904E\u5C0F\uFF1A\u9810\u671F ${issue2.origin} \u61C9\u70BA ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u4EE5 "${_issue.prefix}" \u958B\u982D`;
        }
        if (_issue.format === "ends_with")
          return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u4EE5 "${_issue.suffix}" \u7D50\u5C3E`;
        if (_issue.format === "includes")
          return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u5305\u542B "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u7B26\u5408\u683C\u5F0F ${_issue.pattern}`;
        return `\u7121\u6548\u7684 ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `\u7121\u6548\u7684\u6578\u5B57\uFF1A\u5FC5\u9808\u70BA ${issue2.divisor} \u7684\u500D\u6578`;
      case "unrecognized_keys":
        return `\u7121\u6CD5\u8B58\u5225\u7684\u9375\u503C${issue2.keys.length > 1 ? "\u5011" : ""}\uFF1A${joinValues(issue2.keys, "\u3001")}`;
      case "invalid_key":
        return `${issue2.origin} \u4E2D\u6709\u7121\u6548\u7684\u9375\u503C`;
      case "invalid_union":
        return "\u7121\u6548\u7684\u8F38\u5165\u503C";
      case "invalid_element":
        return `${issue2.origin} \u4E2D\u6709\u7121\u6548\u7684\u503C`;
      default:
        return `\u7121\u6548\u7684\u8F38\u5165\u503C`;
    }
  };
};
function zh_TW_default() {
  return {
    localeError: error43()
  };
}

// node_modules/zod/v4/locales/yo.js
var error44 = () => {
  const Sizable = {
    string: { unit: "\xE0mi", verb: "n\xED" },
    file: { unit: "bytes", verb: "n\xED" },
    array: { unit: "nkan", verb: "n\xED" },
    set: { unit: "nkan", verb: "n\xED" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "n\u1ECD\u0301mb\xE0";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "akop\u1ECD";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "\u1EB9\u0300r\u1ECD \xECb\xE1w\u1ECDl\xE9",
    email: "\xE0d\xEDr\u1EB9\u0301s\xEC \xECm\u1EB9\u0301l\xEC",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "\xE0k\xF3k\xF2 ISO",
    date: "\u1ECDj\u1ECD\u0301 ISO",
    time: "\xE0k\xF3k\xF2 ISO",
    duration: "\xE0k\xF3k\xF2 t\xF3 p\xE9 ISO",
    ipv4: "\xE0d\xEDr\u1EB9\u0301s\xEC IPv4",
    ipv6: "\xE0d\xEDr\u1EB9\u0301s\xEC IPv6",
    cidrv4: "\xE0gb\xE8gb\xE8 IPv4",
    cidrv6: "\xE0gb\xE8gb\xE8 IPv6",
    base64: "\u1ECD\u0300r\u1ECD\u0300 t\xED a k\u1ECD\u0301 n\xED base64",
    base64url: "\u1ECD\u0300r\u1ECD\u0300 base64url",
    json_string: "\u1ECD\u0300r\u1ECD\u0300 JSON",
    e164: "n\u1ECD\u0301mb\xE0 E.164",
    jwt: "JWT",
    template_literal: "\u1EB9\u0300r\u1ECD \xECb\xE1w\u1ECDl\xE9"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e: a n\xED l\xE1ti fi ${issue2.expected}, \xE0m\u1ECD\u0300 a r\xED ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e: a n\xED l\xE1ti fi ${stringifyPrimitive(issue2.values[0])}`;
        return `\xC0\u1E63\xE0y\xE0n a\u1E63\xEC\u1E63e: yan \u1ECD\u0300kan l\xE1ra ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `T\xF3 p\u1ECD\u0300 j\xF9: a n\xED l\xE1ti j\u1EB9\u0301 p\xE9 ${issue2.origin ?? "iye"} ${sizing.verb} ${adj}${issue2.maximum} ${sizing.unit}`;
        return `T\xF3 p\u1ECD\u0300 j\xF9: a n\xED l\xE1ti j\u1EB9\u0301 ${adj}${issue2.maximum}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `K\xE9r\xE9 ju: a n\xED l\xE1ti j\u1EB9\u0301 p\xE9 ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum} ${sizing.unit}`;
        return `K\xE9r\xE9 ju: a n\xED l\xE1ti j\u1EB9\u0301 ${adj}${issue2.minimum}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `\u1ECC\u0300r\u1ECD\u0300 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 b\u1EB9\u0300r\u1EB9\u0300 p\u1EB9\u0300l\xFA "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `\u1ECC\u0300r\u1ECD\u0300 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 par\xED p\u1EB9\u0300l\xFA "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `\u1ECC\u0300r\u1ECD\u0300 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 n\xED "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `\u1ECC\u0300r\u1ECD\u0300 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 b\xE1 \xE0p\u1EB9\u1EB9r\u1EB9 mu ${_issue.pattern}`;
        return `A\u1E63\xEC\u1E63e: ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `N\u1ECD\u0301mb\xE0 a\u1E63\xEC\u1E63e: gb\u1ECD\u0301d\u1ECD\u0300 j\u1EB9\u0301 \xE8y\xE0 p\xEDp\xEDn ti ${issue2.divisor}`;
      case "unrecognized_keys":
        return `B\u1ECDt\xECn\xEC \xE0\xECm\u1ECD\u0300: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `B\u1ECDt\xECn\xEC a\u1E63\xEC\u1E63e n\xEDn\xFA ${issue2.origin}`;
      case "invalid_union":
        return "\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e";
      case "invalid_element":
        return `Iye a\u1E63\xEC\u1E63e n\xEDn\xFA ${issue2.origin}`;
      default:
        return "\xCCb\xE1w\u1ECDl\xE9 a\u1E63\xEC\u1E63e";
    }
  };
};
function yo_default() {
  return {
    localeError: error44()
  };
}

// node_modules/zod/v4/core/registries.js
var $output = Symbol("ZodOutput");
var $input = Symbol("ZodInput");
var $ZodRegistry = class {
  constructor() {
    this._map = /* @__PURE__ */ new WeakMap();
    this._idmap = /* @__PURE__ */ new Map();
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      if (this._idmap.has(meta.id)) {
        throw new Error(`ID ${meta.id} already exists in the registry`);
      }
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = /* @__PURE__ */ new WeakMap();
    this._idmap = /* @__PURE__ */ new Map();
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : void 0;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
};
function registry() {
  return new $ZodRegistry();
}
var globalRegistry = /* @__PURE__ */ registry();

// node_modules/zod/v4/core/api.js
function _string(Class2, params) {
  return new Class2({
    type: "string",
    ...normalizeParams(params)
  });
}
function _coercedString(Class2, params) {
  return new Class2({
    type: "string",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _email(Class2, params) {
  return new Class2({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _guid(Class2, params) {
  return new Class2({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuidv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
function _uuidv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
function _uuidv7(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
function _url(Class2, params) {
  return new Class2({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _emoji2(Class2, params) {
  return new Class2({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _nanoid(Class2, params) {
  return new Class2({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid2(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ulid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _xid(Class2, params) {
  return new Class2({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ksuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64url(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _e164(Class2, params) {
  return new Class2({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _jwt(Class2, params) {
  return new Class2({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
var TimePrecision = {
  Any: null,
  Minute: -1,
  Second: 0,
  Millisecond: 3,
  Microsecond: 6
};
function _isoDateTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDate(Class2, params) {
  return new Class2({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _isoTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDuration(Class2, params) {
  return new Class2({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _number(Class2, params) {
  return new Class2({
    type: "number",
    checks: [],
    ...normalizeParams(params)
  });
}
function _coercedNumber(Class2, params) {
  return new Class2({
    type: "number",
    coerce: true,
    checks: [],
    ...normalizeParams(params)
  });
}
function _int(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
function _float32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "float32",
    ...normalizeParams(params)
  });
}
function _float64(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "float64",
    ...normalizeParams(params)
  });
}
function _int32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "int32",
    ...normalizeParams(params)
  });
}
function _uint32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "uint32",
    ...normalizeParams(params)
  });
}
function _boolean(Class2, params) {
  return new Class2({
    type: "boolean",
    ...normalizeParams(params)
  });
}
function _coercedBoolean(Class2, params) {
  return new Class2({
    type: "boolean",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _bigint(Class2, params) {
  return new Class2({
    type: "bigint",
    ...normalizeParams(params)
  });
}
function _coercedBigint(Class2, params) {
  return new Class2({
    type: "bigint",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _int64(Class2, params) {
  return new Class2({
    type: "bigint",
    check: "bigint_format",
    abort: false,
    format: "int64",
    ...normalizeParams(params)
  });
}
function _uint64(Class2, params) {
  return new Class2({
    type: "bigint",
    check: "bigint_format",
    abort: false,
    format: "uint64",
    ...normalizeParams(params)
  });
}
function _symbol(Class2, params) {
  return new Class2({
    type: "symbol",
    ...normalizeParams(params)
  });
}
function _undefined2(Class2, params) {
  return new Class2({
    type: "undefined",
    ...normalizeParams(params)
  });
}
function _null2(Class2, params) {
  return new Class2({
    type: "null",
    ...normalizeParams(params)
  });
}
function _any(Class2) {
  return new Class2({
    type: "any"
  });
}
function _unknown(Class2) {
  return new Class2({
    type: "unknown"
  });
}
function _never(Class2, params) {
  return new Class2({
    type: "never",
    ...normalizeParams(params)
  });
}
function _void(Class2, params) {
  return new Class2({
    type: "void",
    ...normalizeParams(params)
  });
}
function _date(Class2, params) {
  return new Class2({
    type: "date",
    ...normalizeParams(params)
  });
}
function _coercedDate(Class2, params) {
  return new Class2({
    type: "date",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _nan(Class2, params) {
  return new Class2({
    type: "nan",
    ...normalizeParams(params)
  });
}
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _positive(params) {
  return _gt(0, params);
}
function _negative(params) {
  return _lt(0, params);
}
function _nonpositive(params) {
  return _lte(0, params);
}
function _nonnegative(params) {
  return _gte(0, params);
}
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
function _maxSize(maximum, params) {
  return new $ZodCheckMaxSize({
    check: "max_size",
    ...normalizeParams(params),
    maximum
  });
}
function _minSize(minimum, params) {
  return new $ZodCheckMinSize({
    check: "min_size",
    ...normalizeParams(params),
    minimum
  });
}
function _size(size, params) {
  return new $ZodCheckSizeEquals({
    check: "size_equals",
    ...normalizeParams(params),
    size
  });
}
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
function _property(property, schema, params) {
  return new $ZodCheckProperty({
    check: "property",
    property,
    schema,
    ...normalizeParams(params)
  });
}
function _mime(types, params) {
  return new $ZodCheckMimeType({
    check: "mime_type",
    mime: types,
    ...normalizeParams(params)
  });
}
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
function _normalize(form) {
  return _overwrite((input) => input.normalize(form));
}
function _trim() {
  return _overwrite((input) => input.trim());
}
function _toLowerCase() {
  return _overwrite((input) => input.toLowerCase());
}
function _toUpperCase() {
  return _overwrite((input) => input.toUpperCase());
}
function _array(Class2, element, params) {
  return new Class2({
    type: "array",
    element,
    // get element() {
    //   return element;
    // },
    ...normalizeParams(params)
  });
}
function _union(Class2, options, params) {
  return new Class2({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
function _discriminatedUnion(Class2, discriminator, options, params) {
  return new Class2({
    type: "union",
    options,
    discriminator,
    ...normalizeParams(params)
  });
}
function _intersection(Class2, left, right) {
  return new Class2({
    type: "intersection",
    left,
    right
  });
}
function _tuple(Class2, items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof $ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new Class2({
    type: "tuple",
    items,
    rest,
    ...normalizeParams(params)
  });
}
function _record(Class2, keyType, valueType, params) {
  return new Class2({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
function _map(Class2, keyType, valueType, params) {
  return new Class2({
    type: "map",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
function _set(Class2, valueType, params) {
  return new Class2({
    type: "set",
    valueType,
    ...normalizeParams(params)
  });
}
function _enum(Class2, values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new Class2({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
function _nativeEnum(Class2, entries, params) {
  return new Class2({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
function _literal(Class2, value, params) {
  return new Class2({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
function _file(Class2, params) {
  return new Class2({
    type: "file",
    ...normalizeParams(params)
  });
}
function _transform(Class2, fn) {
  return new Class2({
    type: "transform",
    transform: fn
  });
}
function _optional(Class2, innerType) {
  return new Class2({
    type: "optional",
    innerType
  });
}
function _nullable(Class2, innerType) {
  return new Class2({
    type: "nullable",
    innerType
  });
}
function _default(Class2, innerType, defaultValue) {
  return new Class2({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
function _nonoptional(Class2, innerType, params) {
  return new Class2({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
function _success(Class2, innerType) {
  return new Class2({
    type: "success",
    innerType
  });
}
function _catch(Class2, innerType, catchValue) {
  return new Class2({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
function _pipe(Class2, in_, out) {
  return new Class2({
    type: "pipe",
    in: in_,
    out
  });
}
function _readonly(Class2, innerType) {
  return new Class2({
    type: "readonly",
    innerType
  });
}
function _templateLiteral(Class2, parts, params) {
  return new Class2({
    type: "template_literal",
    parts,
    ...normalizeParams(params)
  });
}
function _lazy(Class2, getter) {
  return new Class2({
    type: "lazy",
    getter
  });
}
function _promise(Class2, innerType) {
  return new Class2({
    type: "promise",
    innerType
  });
}
function _custom(Class2, fn, _params) {
  const norm = normalizeParams(_params);
  norm.abort ?? (norm.abort = true);
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...norm
  });
  return schema;
}
function _refine(Class2, fn, _params) {
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
function _superRefine(fn) {
  const ch = _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  });
  return ch;
}
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
function _stringbool(Classes, _params) {
  const params = normalizeParams(_params);
  let truthyArray = params.truthy ?? ["true", "1", "yes", "on", "y", "enabled"];
  let falsyArray = params.falsy ?? ["false", "0", "no", "off", "n", "disabled"];
  if (params.case !== "sensitive") {
    truthyArray = truthyArray.map((v) => typeof v === "string" ? v.toLowerCase() : v);
    falsyArray = falsyArray.map((v) => typeof v === "string" ? v.toLowerCase() : v);
  }
  const truthySet = new Set(truthyArray);
  const falsySet = new Set(falsyArray);
  const _Codec = Classes.Codec ?? $ZodCodec;
  const _Boolean = Classes.Boolean ?? $ZodBoolean;
  const _String = Classes.String ?? $ZodString;
  const stringSchema = new _String({ type: "string", error: params.error });
  const booleanSchema = new _Boolean({ type: "boolean", error: params.error });
  const codec2 = new _Codec({
    type: "pipe",
    in: stringSchema,
    out: booleanSchema,
    transform: ((input, payload) => {
      let data = input;
      if (params.case !== "sensitive")
        data = data.toLowerCase();
      if (truthySet.has(data)) {
        return true;
      } else if (falsySet.has(data)) {
        return false;
      } else {
        payload.issues.push({
          code: "invalid_value",
          expected: "stringbool",
          values: [...truthySet, ...falsySet],
          input: payload.value,
          inst: codec2,
          continue: false
        });
        return {};
      }
    }),
    reverseTransform: ((input, _payload) => {
      if (input === true) {
        return truthyArray[0] || "true";
      } else {
        return falsyArray[0] || "false";
      }
    }),
    error: params.error
  });
  return codec2;
}
function _stringFormat(Class2, format, fnOrRegex, _params = {}) {
  const params = normalizeParams(_params);
  const def = {
    ...normalizeParams(_params),
    check: "string_format",
    type: "string",
    format,
    fn: typeof fnOrRegex === "function" ? fnOrRegex : (val) => fnOrRegex.test(val),
    ...params
  };
  if (fnOrRegex instanceof RegExp) {
    def.pattern = fnOrRegex;
  }
  const inst = new Class2(def);
  return inst;
}

// node_modules/zod/v4/core/to-json-schema.js
var JSONSchemaGenerator = class {
  constructor(params) {
    this.counter = 0;
    this.metadataRegistry = params?.metadata ?? globalRegistry;
    this.target = params?.target ?? "draft-2020-12";
    this.unrepresentable = params?.unrepresentable ?? "throw";
    this.override = params?.override ?? (() => {
    });
    this.io = params?.io ?? "output";
    this.seen = /* @__PURE__ */ new Map();
  }
  process(schema, _params = { path: [], schemaPath: [] }) {
    var _a;
    const def = schema._zod.def;
    const formatMap = {
      guid: "uuid",
      url: "uri",
      datetime: "date-time",
      json_string: "json-string",
      regex: ""
      // do not set
    };
    const seen = this.seen.get(schema);
    if (seen) {
      seen.count++;
      const isCycle = _params.schemaPath.includes(schema);
      if (isCycle) {
        seen.cycle = _params.path;
      }
      return seen.schema;
    }
    const result = { schema: {}, count: 1, cycle: void 0, path: _params.path };
    this.seen.set(schema, result);
    const overrideSchema = schema._zod.toJSONSchema?.();
    if (overrideSchema) {
      result.schema = overrideSchema;
    } else {
      const params = {
        ..._params,
        schemaPath: [..._params.schemaPath, schema],
        path: _params.path
      };
      const parent = schema._zod.parent;
      if (parent) {
        result.ref = parent;
        this.process(parent, params);
        this.seen.get(parent).isParent = true;
      } else {
        const _json = result.schema;
        switch (def.type) {
          case "string": {
            const json2 = _json;
            json2.type = "string";
            const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
            if (typeof minimum === "number")
              json2.minLength = minimum;
            if (typeof maximum === "number")
              json2.maxLength = maximum;
            if (format) {
              json2.format = formatMap[format] ?? format;
              if (json2.format === "")
                delete json2.format;
            }
            if (contentEncoding)
              json2.contentEncoding = contentEncoding;
            if (patterns && patterns.size > 0) {
              const regexes = [...patterns];
              if (regexes.length === 1)
                json2.pattern = regexes[0].source;
              else if (regexes.length > 1) {
                result.schema.allOf = [
                  ...regexes.map((regex) => ({
                    ...this.target === "draft-7" || this.target === "draft-4" || this.target === "openapi-3.0" ? { type: "string" } : {},
                    pattern: regex.source
                  }))
                ];
              }
            }
            break;
          }
          case "number": {
            const json2 = _json;
            const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
            if (typeof format === "string" && format.includes("int"))
              json2.type = "integer";
            else
              json2.type = "number";
            if (typeof exclusiveMinimum === "number") {
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json2.minimum = exclusiveMinimum;
                json2.exclusiveMinimum = true;
              } else {
                json2.exclusiveMinimum = exclusiveMinimum;
              }
            }
            if (typeof minimum === "number") {
              json2.minimum = minimum;
              if (typeof exclusiveMinimum === "number" && this.target !== "draft-4") {
                if (exclusiveMinimum >= minimum)
                  delete json2.minimum;
                else
                  delete json2.exclusiveMinimum;
              }
            }
            if (typeof exclusiveMaximum === "number") {
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json2.maximum = exclusiveMaximum;
                json2.exclusiveMaximum = true;
              } else {
                json2.exclusiveMaximum = exclusiveMaximum;
              }
            }
            if (typeof maximum === "number") {
              json2.maximum = maximum;
              if (typeof exclusiveMaximum === "number" && this.target !== "draft-4") {
                if (exclusiveMaximum <= maximum)
                  delete json2.maximum;
                else
                  delete json2.exclusiveMaximum;
              }
            }
            if (typeof multipleOf === "number")
              json2.multipleOf = multipleOf;
            break;
          }
          case "boolean": {
            const json2 = _json;
            json2.type = "boolean";
            break;
          }
          case "bigint": {
            if (this.unrepresentable === "throw") {
              throw new Error("BigInt cannot be represented in JSON Schema");
            }
            break;
          }
          case "symbol": {
            if (this.unrepresentable === "throw") {
              throw new Error("Symbols cannot be represented in JSON Schema");
            }
            break;
          }
          case "null": {
            if (this.target === "openapi-3.0") {
              _json.type = "string";
              _json.nullable = true;
              _json.enum = [null];
            } else
              _json.type = "null";
            break;
          }
          case "any": {
            break;
          }
          case "unknown": {
            break;
          }
          case "undefined": {
            if (this.unrepresentable === "throw") {
              throw new Error("Undefined cannot be represented in JSON Schema");
            }
            break;
          }
          case "void": {
            if (this.unrepresentable === "throw") {
              throw new Error("Void cannot be represented in JSON Schema");
            }
            break;
          }
          case "never": {
            _json.not = {};
            break;
          }
          case "date": {
            if (this.unrepresentable === "throw") {
              throw new Error("Date cannot be represented in JSON Schema");
            }
            break;
          }
          case "array": {
            const json2 = _json;
            const { minimum, maximum } = schema._zod.bag;
            if (typeof minimum === "number")
              json2.minItems = minimum;
            if (typeof maximum === "number")
              json2.maxItems = maximum;
            json2.type = "array";
            json2.items = this.process(def.element, { ...params, path: [...params.path, "items"] });
            break;
          }
          case "object": {
            const json2 = _json;
            json2.type = "object";
            json2.properties = {};
            const shape = def.shape;
            for (const key in shape) {
              json2.properties[key] = this.process(shape[key], {
                ...params,
                path: [...params.path, "properties", key]
              });
            }
            const allKeys = new Set(Object.keys(shape));
            const requiredKeys = new Set([...allKeys].filter((key) => {
              const v = def.shape[key]._zod;
              if (this.io === "input") {
                return v.optin === void 0;
              } else {
                return v.optout === void 0;
              }
            }));
            if (requiredKeys.size > 0) {
              json2.required = Array.from(requiredKeys);
            }
            if (def.catchall?._zod.def.type === "never") {
              json2.additionalProperties = false;
            } else if (!def.catchall) {
              if (this.io === "output")
                json2.additionalProperties = false;
            } else if (def.catchall) {
              json2.additionalProperties = this.process(def.catchall, {
                ...params,
                path: [...params.path, "additionalProperties"]
              });
            }
            break;
          }
          case "union": {
            const json2 = _json;
            const options = def.options.map((x, i) => this.process(x, {
              ...params,
              path: [...params.path, "anyOf", i]
            }));
            json2.anyOf = options;
            break;
          }
          case "intersection": {
            const json2 = _json;
            const a = this.process(def.left, {
              ...params,
              path: [...params.path, "allOf", 0]
            });
            const b = this.process(def.right, {
              ...params,
              path: [...params.path, "allOf", 1]
            });
            const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
            const allOf = [
              ...isSimpleIntersection(a) ? a.allOf : [a],
              ...isSimpleIntersection(b) ? b.allOf : [b]
            ];
            json2.allOf = allOf;
            break;
          }
          case "tuple": {
            const json2 = _json;
            json2.type = "array";
            const prefixPath = this.target === "draft-2020-12" ? "prefixItems" : "items";
            const restPath = this.target === "draft-2020-12" ? "items" : this.target === "openapi-3.0" ? "items" : "additionalItems";
            const prefixItems = def.items.map((x, i) => this.process(x, {
              ...params,
              path: [...params.path, prefixPath, i]
            }));
            const rest = def.rest ? this.process(def.rest, {
              ...params,
              path: [...params.path, restPath, ...this.target === "openapi-3.0" ? [def.items.length] : []]
            }) : null;
            if (this.target === "draft-2020-12") {
              json2.prefixItems = prefixItems;
              if (rest) {
                json2.items = rest;
              }
            } else if (this.target === "openapi-3.0") {
              json2.items = {
                anyOf: prefixItems
              };
              if (rest) {
                json2.items.anyOf.push(rest);
              }
              json2.minItems = prefixItems.length;
              if (!rest) {
                json2.maxItems = prefixItems.length;
              }
            } else {
              json2.items = prefixItems;
              if (rest) {
                json2.additionalItems = rest;
              }
            }
            const { minimum, maximum } = schema._zod.bag;
            if (typeof minimum === "number")
              json2.minItems = minimum;
            if (typeof maximum === "number")
              json2.maxItems = maximum;
            break;
          }
          case "record": {
            const json2 = _json;
            json2.type = "object";
            if (this.target === "draft-7" || this.target === "draft-2020-12") {
              json2.propertyNames = this.process(def.keyType, {
                ...params,
                path: [...params.path, "propertyNames"]
              });
            }
            json2.additionalProperties = this.process(def.valueType, {
              ...params,
              path: [...params.path, "additionalProperties"]
            });
            break;
          }
          case "map": {
            if (this.unrepresentable === "throw") {
              throw new Error("Map cannot be represented in JSON Schema");
            }
            break;
          }
          case "set": {
            if (this.unrepresentable === "throw") {
              throw new Error("Set cannot be represented in JSON Schema");
            }
            break;
          }
          case "enum": {
            const json2 = _json;
            const values = getEnumValues(def.entries);
            if (values.every((v) => typeof v === "number"))
              json2.type = "number";
            if (values.every((v) => typeof v === "string"))
              json2.type = "string";
            json2.enum = values;
            break;
          }
          case "literal": {
            const json2 = _json;
            const vals = [];
            for (const val of def.values) {
              if (val === void 0) {
                if (this.unrepresentable === "throw") {
                  throw new Error("Literal `undefined` cannot be represented in JSON Schema");
                } else {
                }
              } else if (typeof val === "bigint") {
                if (this.unrepresentable === "throw") {
                  throw new Error("BigInt literals cannot be represented in JSON Schema");
                } else {
                  vals.push(Number(val));
                }
              } else {
                vals.push(val);
              }
            }
            if (vals.length === 0) {
            } else if (vals.length === 1) {
              const val = vals[0];
              json2.type = val === null ? "null" : typeof val;
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json2.enum = [val];
              } else {
                json2.const = val;
              }
            } else {
              if (vals.every((v) => typeof v === "number"))
                json2.type = "number";
              if (vals.every((v) => typeof v === "string"))
                json2.type = "string";
              if (vals.every((v) => typeof v === "boolean"))
                json2.type = "string";
              if (vals.every((v) => v === null))
                json2.type = "null";
              json2.enum = vals;
            }
            break;
          }
          case "file": {
            const json2 = _json;
            const file2 = {
              type: "string",
              format: "binary",
              contentEncoding: "binary"
            };
            const { minimum, maximum, mime } = schema._zod.bag;
            if (minimum !== void 0)
              file2.minLength = minimum;
            if (maximum !== void 0)
              file2.maxLength = maximum;
            if (mime) {
              if (mime.length === 1) {
                file2.contentMediaType = mime[0];
                Object.assign(json2, file2);
              } else {
                json2.anyOf = mime.map((m) => {
                  const mFile = { ...file2, contentMediaType: m };
                  return mFile;
                });
              }
            } else {
              Object.assign(json2, file2);
            }
            break;
          }
          case "transform": {
            if (this.unrepresentable === "throw") {
              throw new Error("Transforms cannot be represented in JSON Schema");
            }
            break;
          }
          case "nullable": {
            const inner = this.process(def.innerType, params);
            if (this.target === "openapi-3.0") {
              result.ref = def.innerType;
              _json.nullable = true;
            } else {
              _json.anyOf = [inner, { type: "null" }];
            }
            break;
          }
          case "nonoptional": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "success": {
            const json2 = _json;
            json2.type = "boolean";
            break;
          }
          case "default": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            _json.default = JSON.parse(JSON.stringify(def.defaultValue));
            break;
          }
          case "prefault": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            if (this.io === "input")
              _json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
            break;
          }
          case "catch": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            let catchValue;
            try {
              catchValue = def.catchValue(void 0);
            } catch {
              throw new Error("Dynamic catch values are not supported in JSON Schema");
            }
            _json.default = catchValue;
            break;
          }
          case "nan": {
            if (this.unrepresentable === "throw") {
              throw new Error("NaN cannot be represented in JSON Schema");
            }
            break;
          }
          case "template_literal": {
            const json2 = _json;
            const pattern = schema._zod.pattern;
            if (!pattern)
              throw new Error("Pattern not found in template literal");
            json2.type = "string";
            json2.pattern = pattern.source;
            break;
          }
          case "pipe": {
            const innerType = this.io === "input" ? def.in._zod.def.type === "transform" ? def.out : def.in : def.out;
            this.process(innerType, params);
            result.ref = innerType;
            break;
          }
          case "readonly": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            _json.readOnly = true;
            break;
          }
          // passthrough types
          case "promise": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "optional": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "lazy": {
            const innerType = schema._zod.innerType;
            this.process(innerType, params);
            result.ref = innerType;
            break;
          }
          case "custom": {
            if (this.unrepresentable === "throw") {
              throw new Error("Custom types cannot be represented in JSON Schema");
            }
            break;
          }
          case "function": {
            if (this.unrepresentable === "throw") {
              throw new Error("Function types cannot be represented in JSON Schema");
            }
            break;
          }
          default: {
            def;
          }
        }
      }
    }
    const meta = this.metadataRegistry.get(schema);
    if (meta)
      Object.assign(result.schema, meta);
    if (this.io === "input" && isTransforming(schema)) {
      delete result.schema.examples;
      delete result.schema.default;
    }
    if (this.io === "input" && result.schema._prefault)
      (_a = result.schema).default ?? (_a.default = result.schema._prefault);
    delete result.schema._prefault;
    const _result = this.seen.get(schema);
    return _result.schema;
  }
  emit(schema, _params) {
    const params = {
      cycles: _params?.cycles ?? "ref",
      reused: _params?.reused ?? "inline",
      // unrepresentable: _params?.unrepresentable ?? "throw",
      // uri: _params?.uri ?? ((id) => `${id}`),
      external: _params?.external ?? void 0
    };
    const root = this.seen.get(schema);
    if (!root)
      throw new Error("Unprocessed schema. This is a bug in Zod.");
    const makeURI = (entry) => {
      const defsSegment = this.target === "draft-2020-12" ? "$defs" : "definitions";
      if (params.external) {
        const externalId = params.external.registry.get(entry[0])?.id;
        const uriGenerator = params.external.uri ?? ((id2) => id2);
        if (externalId) {
          return { ref: uriGenerator(externalId) };
        }
        const id = entry[1].defId ?? entry[1].schema.id ?? `schema${this.counter++}`;
        entry[1].defId = id;
        return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}` };
      }
      if (entry[1] === root) {
        return { ref: "#" };
      }
      const uriPrefix = `#`;
      const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
      const defId = entry[1].schema.id ?? `__schema${this.counter++}`;
      return { defId, ref: defUriPrefix + defId };
    };
    const extractToDef = (entry) => {
      if (entry[1].schema.$ref) {
        return;
      }
      const seen = entry[1];
      const { ref, defId } = makeURI(entry);
      seen.def = { ...seen.schema };
      if (defId)
        seen.defId = defId;
      const schema2 = seen.schema;
      for (const key in schema2) {
        delete schema2[key];
      }
      schema2.$ref = ref;
    };
    if (params.cycles === "throw") {
      for (const entry of this.seen.entries()) {
        const seen = entry[1];
        if (seen.cycle) {
          throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
        }
      }
    }
    for (const entry of this.seen.entries()) {
      const seen = entry[1];
      if (schema === entry[0]) {
        extractToDef(entry);
        continue;
      }
      if (params.external) {
        const ext = params.external.registry.get(entry[0])?.id;
        if (schema !== entry[0] && ext) {
          extractToDef(entry);
          continue;
        }
      }
      const id = this.metadataRegistry.get(entry[0])?.id;
      if (id) {
        extractToDef(entry);
        continue;
      }
      if (seen.cycle) {
        extractToDef(entry);
        continue;
      }
      if (seen.count > 1) {
        if (params.reused === "ref") {
          extractToDef(entry);
          continue;
        }
      }
    }
    const flattenRef = (zodSchema, params2) => {
      const seen = this.seen.get(zodSchema);
      const schema2 = seen.def ?? seen.schema;
      const _cached = { ...schema2 };
      if (seen.ref === null) {
        return;
      }
      const ref = seen.ref;
      seen.ref = null;
      if (ref) {
        flattenRef(ref, params2);
        const refSchema = this.seen.get(ref).schema;
        if (refSchema.$ref && (params2.target === "draft-7" || params2.target === "draft-4" || params2.target === "openapi-3.0")) {
          schema2.allOf = schema2.allOf ?? [];
          schema2.allOf.push(refSchema);
        } else {
          Object.assign(schema2, refSchema);
          Object.assign(schema2, _cached);
        }
      }
      if (!seen.isParent)
        this.override({
          zodSchema,
          jsonSchema: schema2,
          path: seen.path ?? []
        });
    };
    for (const entry of [...this.seen.entries()].reverse()) {
      flattenRef(entry[0], { target: this.target });
    }
    const result = {};
    if (this.target === "draft-2020-12") {
      result.$schema = "https://json-schema.org/draft/2020-12/schema";
    } else if (this.target === "draft-7") {
      result.$schema = "http://json-schema.org/draft-07/schema#";
    } else if (this.target === "draft-4") {
      result.$schema = "http://json-schema.org/draft-04/schema#";
    } else if (this.target === "openapi-3.0") {
    } else {
      console.warn(`Invalid target: ${this.target}`);
    }
    if (params.external?.uri) {
      const id = params.external.registry.get(schema)?.id;
      if (!id)
        throw new Error("Schema is missing an `id` property");
      result.$id = params.external.uri(id);
    }
    Object.assign(result, root.def);
    const defs = params.external?.defs ?? {};
    for (const entry of this.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        defs[seen.defId] = seen.def;
      }
    }
    if (params.external) {
    } else {
      if (Object.keys(defs).length > 0) {
        if (this.target === "draft-2020-12") {
          result.$defs = defs;
        } else {
          result.definitions = defs;
        }
      }
    }
    try {
      return JSON.parse(JSON.stringify(result));
    } catch (_err) {
      throw new Error("Error converting schema to JSON.");
    }
  }
};
function toJSONSchema(input, _params) {
  if (input instanceof $ZodRegistry) {
    const gen2 = new JSONSchemaGenerator(_params);
    const defs = {};
    for (const entry of input._idmap.entries()) {
      const [_, schema] = entry;
      gen2.process(schema);
    }
    const schemas = {};
    const external = {
      registry: input,
      uri: _params?.uri,
      defs
    };
    for (const entry of input._idmap.entries()) {
      const [key, schema] = entry;
      schemas[key] = gen2.emit(schema, {
        ..._params,
        external
      });
    }
    if (Object.keys(defs).length > 0) {
      const defsSegment = gen2.target === "draft-2020-12" ? "$defs" : "definitions";
      schemas.__shared = {
        [defsSegment]: defs
      };
    }
    return { schemas };
  }
  const gen = new JSONSchemaGenerator(_params);
  gen.process(input);
  return gen.emit(input, _params);
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const schema = _schema;
  const def = schema._zod.def;
  switch (def.type) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
    case "date":
    case "symbol":
    case "undefined":
    case "null":
    case "any":
    case "unknown":
    case "never":
    case "void":
    case "literal":
    case "enum":
    case "nan":
    case "file":
    case "template_literal":
      return false;
    case "array": {
      return isTransforming(def.element, ctx);
    }
    case "object": {
      for (const key in def.shape) {
        if (isTransforming(def.shape[key], ctx))
          return true;
      }
      return false;
    }
    case "union": {
      for (const option of def.options) {
        if (isTransforming(option, ctx))
          return true;
      }
      return false;
    }
    case "intersection": {
      return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
    }
    case "tuple": {
      for (const item of def.items) {
        if (isTransforming(item, ctx))
          return true;
      }
      if (def.rest && isTransforming(def.rest, ctx))
        return true;
      return false;
    }
    case "record": {
      return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
    }
    case "map": {
      return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
    }
    case "set": {
      return isTransforming(def.valueType, ctx);
    }
    // inner types
    case "promise":
    case "optional":
    case "nonoptional":
    case "nullable":
    case "readonly":
      return isTransforming(def.innerType, ctx);
    case "lazy":
      return isTransforming(def.getter(), ctx);
    case "default": {
      return isTransforming(def.innerType, ctx);
    }
    case "prefault": {
      return isTransforming(def.innerType, ctx);
    }
    case "custom": {
      return false;
    }
    case "transform": {
      return true;
    }
    case "pipe": {
      return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
    }
    case "success": {
      return false;
    }
    case "catch": {
      return false;
    }
    case "function": {
      return false;
    }
    default:
      def;
  }
  throw new Error(`Unknown schema type: ${def.type}`);
}

// node_modules/zod/v4/core/json-schema.js
var json_schema_exports = {};

// node_modules/zod/v4/classic/iso.js
var iso_exports = {};
__export(iso_exports, {
  ZodISODate: () => ZodISODate,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODuration: () => ZodISODuration,
  ZodISOTime: () => ZodISOTime,
  date: () => date2,
  datetime: () => datetime2,
  duration: () => duration2,
  time: () => time2
});
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function datetime2(params) {
  return _isoDateTime(ZodISODateTime, params);
}
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function date2(params) {
  return _isoDate(ZodISODate, params);
}
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function time2(params) {
  return _isoTime(ZodISOTime, params);
}
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function duration2(params) {
  return _isoDuration(ZodISODuration, params);
}

// node_modules/zod/v4/classic/errors.js
var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  Object.defineProperties(inst, {
    format: {
      value: (mapper) => formatError(inst, mapper)
      // enumerable: false,
    },
    flatten: {
      value: (mapper) => flattenError(inst, mapper)
      // enumerable: false,
    },
    addIssue: {
      value: (issue2) => {
        inst.issues.push(issue2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
      // enumerable: false,
    },
    addIssues: {
      value: (issues2) => {
        inst.issues.push(...issues2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
      // enumerable: false,
    },
    isEmpty: {
      get() {
        return inst.issues.length === 0;
      }
      // enumerable: false,
    }
  });
};
var ZodError = $constructor("ZodError", initializer2);
var ZodRealError = $constructor("ZodError", initializer2, {
  Parent: Error
});

// node_modules/zod/v4/classic/parse.js
var parse2 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync2 = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse2 = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync2 = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode2 = /* @__PURE__ */ _encode(ZodRealError);
var decode2 = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync2 = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync2 = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode2 = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode2 = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync2 = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync2 = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// node_modules/zod/v4/classic/schemas.js
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  $ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
  Object.defineProperty(inst, "_def", { value: def });
  inst.check = (...checks) => {
    return inst.clone(
      {
        ...def,
        checks: [
          ...def.checks ?? [],
          ...checks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
        ]
      }
      // { parent: true }
    );
  };
  inst.clone = (def2, params) => clone(inst, def2, params);
  inst.brand = () => inst;
  inst.register = ((reg, meta) => {
    reg.add(inst, meta);
    return inst;
  });
  inst.parse = (data, params) => parse2(inst, data, params, { callee: inst.parse });
  inst.safeParse = (data, params) => safeParse2(inst, data, params);
  inst.parseAsync = async (data, params) => parseAsync2(inst, data, params, { callee: inst.parseAsync });
  inst.safeParseAsync = async (data, params) => safeParseAsync2(inst, data, params);
  inst.spa = inst.safeParseAsync;
  inst.encode = (data, params) => encode2(inst, data, params);
  inst.decode = (data, params) => decode2(inst, data, params);
  inst.encodeAsync = async (data, params) => encodeAsync2(inst, data, params);
  inst.decodeAsync = async (data, params) => decodeAsync2(inst, data, params);
  inst.safeEncode = (data, params) => safeEncode2(inst, data, params);
  inst.safeDecode = (data, params) => safeDecode2(inst, data, params);
  inst.safeEncodeAsync = async (data, params) => safeEncodeAsync2(inst, data, params);
  inst.safeDecodeAsync = async (data, params) => safeDecodeAsync2(inst, data, params);
  inst.refine = (check2, params) => inst.check(refine(check2, params));
  inst.superRefine = (refinement) => inst.check(superRefine(refinement));
  inst.overwrite = (fn) => inst.check(_overwrite(fn));
  inst.optional = () => optional(inst);
  inst.nullable = () => nullable(inst);
  inst.nullish = () => optional(nullable(inst));
  inst.nonoptional = (params) => nonoptional(inst, params);
  inst.array = () => array(inst);
  inst.or = (arg) => union([inst, arg]);
  inst.and = (arg) => intersection(inst, arg);
  inst.transform = (tx) => pipe(inst, transform(tx));
  inst.default = (def2) => _default2(inst, def2);
  inst.prefault = (def2) => prefault(inst, def2);
  inst.catch = (params) => _catch2(inst, params);
  inst.pipe = (target) => pipe(inst, target);
  inst.readonly = () => readonly(inst);
  inst.describe = (description) => {
    const cl = inst.clone();
    globalRegistry.add(cl, { description });
    return cl;
  };
  Object.defineProperty(inst, "description", {
    get() {
      return globalRegistry.get(inst)?.description;
    },
    configurable: true
  });
  inst.meta = (...args) => {
    if (args.length === 0) {
      return globalRegistry.get(inst);
    }
    const cl = inst.clone();
    globalRegistry.add(cl, args[0]);
    return cl;
  };
  inst.isOptional = () => inst.safeParse(void 0).success;
  inst.isNullable = () => inst.safeParse(null).success;
  return inst;
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  const bag = inst._zod.bag;
  inst.format = bag.format ?? null;
  inst.minLength = bag.minimum ?? null;
  inst.maxLength = bag.maximum ?? null;
  inst.regex = (...args) => inst.check(_regex(...args));
  inst.includes = (...args) => inst.check(_includes(...args));
  inst.startsWith = (...args) => inst.check(_startsWith(...args));
  inst.endsWith = (...args) => inst.check(_endsWith(...args));
  inst.min = (...args) => inst.check(_minLength(...args));
  inst.max = (...args) => inst.check(_maxLength(...args));
  inst.length = (...args) => inst.check(_length(...args));
  inst.nonempty = (...args) => inst.check(_minLength(1, ...args));
  inst.lowercase = (params) => inst.check(_lowercase(params));
  inst.uppercase = (params) => inst.check(_uppercase(params));
  inst.trim = () => inst.check(_trim());
  inst.normalize = (...args) => inst.check(_normalize(...args));
  inst.toLowerCase = () => inst.check(_toLowerCase());
  inst.toUpperCase = () => inst.check(_toUpperCase());
});
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
  inst.email = (params) => inst.check(_email(ZodEmail, params));
  inst.url = (params) => inst.check(_url(ZodURL, params));
  inst.jwt = (params) => inst.check(_jwt(ZodJWT, params));
  inst.emoji = (params) => inst.check(_emoji2(ZodEmoji, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.uuid = (params) => inst.check(_uuid(ZodUUID, params));
  inst.uuidv4 = (params) => inst.check(_uuidv4(ZodUUID, params));
  inst.uuidv6 = (params) => inst.check(_uuidv6(ZodUUID, params));
  inst.uuidv7 = (params) => inst.check(_uuidv7(ZodUUID, params));
  inst.nanoid = (params) => inst.check(_nanoid(ZodNanoID, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.cuid = (params) => inst.check(_cuid(ZodCUID, params));
  inst.cuid2 = (params) => inst.check(_cuid2(ZodCUID2, params));
  inst.ulid = (params) => inst.check(_ulid(ZodULID, params));
  inst.base64 = (params) => inst.check(_base64(ZodBase64, params));
  inst.base64url = (params) => inst.check(_base64url(ZodBase64URL, params));
  inst.xid = (params) => inst.check(_xid(ZodXID, params));
  inst.ksuid = (params) => inst.check(_ksuid(ZodKSUID, params));
  inst.ipv4 = (params) => inst.check(_ipv4(ZodIPv4, params));
  inst.ipv6 = (params) => inst.check(_ipv6(ZodIPv6, params));
  inst.cidrv4 = (params) => inst.check(_cidrv4(ZodCIDRv4, params));
  inst.cidrv6 = (params) => inst.check(_cidrv6(ZodCIDRv6, params));
  inst.e164 = (params) => inst.check(_e164(ZodE164, params));
  inst.datetime = (params) => inst.check(datetime2(params));
  inst.date = (params) => inst.check(date2(params));
  inst.time = (params) => inst.check(time2(params));
  inst.duration = (params) => inst.check(duration2(params));
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function email2(params) {
  return _email(ZodEmail, params);
}
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function guid2(params) {
  return _guid(ZodGUID, params);
}
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function uuid2(params) {
  return _uuid(ZodUUID, params);
}
function uuidv4(params) {
  return _uuidv4(ZodUUID, params);
}
function uuidv6(params) {
  return _uuidv6(ZodUUID, params);
}
function uuidv7(params) {
  return _uuidv7(ZodUUID, params);
}
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function url(params) {
  return _url(ZodURL, params);
}
function httpUrl(params) {
  return _url(ZodURL, {
    protocol: /^https?$/,
    hostname: regexes_exports.domain,
    ...util_exports.normalizeParams(params)
  });
}
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function emoji2(params) {
  return _emoji2(ZodEmoji, params);
}
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function nanoid2(params) {
  return _nanoid(ZodNanoID, params);
}
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cuid3(params) {
  return _cuid(ZodCUID, params);
}
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cuid22(params) {
  return _cuid2(ZodCUID2, params);
}
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ulid2(params) {
  return _ulid(ZodULID, params);
}
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function xid2(params) {
  return _xid(ZodXID, params);
}
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ksuid2(params) {
  return _ksuid(ZodKSUID, params);
}
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ipv42(params) {
  return _ipv4(ZodIPv4, params);
}
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ipv62(params) {
  return _ipv6(ZodIPv6, params);
}
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cidrv42(params) {
  return _cidrv4(ZodCIDRv4, params);
}
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cidrv62(params) {
  return _cidrv6(ZodCIDRv6, params);
}
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function base642(params) {
  return _base64(ZodBase64, params);
}
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function base64url2(params) {
  return _base64url(ZodBase64URL, params);
}
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function e1642(params) {
  return _e164(ZodE164, params);
}
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function jwt(params) {
  return _jwt(ZodJWT, params);
}
var ZodCustomStringFormat = /* @__PURE__ */ $constructor("ZodCustomStringFormat", (inst, def) => {
  $ZodCustomStringFormat.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function stringFormat(format, fnOrRegex, _params = {}) {
  return _stringFormat(ZodCustomStringFormat, format, fnOrRegex, _params);
}
function hostname2(_params) {
  return _stringFormat(ZodCustomStringFormat, "hostname", regexes_exports.hostname, _params);
}
function hex2(_params) {
  return _stringFormat(ZodCustomStringFormat, "hex", regexes_exports.hex, _params);
}
function hash(alg, params) {
  const enc = params?.enc ?? "hex";
  const format = `${alg}_${enc}`;
  const regex = regexes_exports[format];
  if (!regex)
    throw new Error(`Unrecognized hash format: ${format}`);
  return _stringFormat(ZodCustomStringFormat, format, regex, params);
}
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst.gt = (value, params) => inst.check(_gt(value, params));
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.lt = (value, params) => inst.check(_lt(value, params));
  inst.lte = (value, params) => inst.check(_lte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  inst.int = (params) => inst.check(int(params));
  inst.safe = (params) => inst.check(int(params));
  inst.positive = (params) => inst.check(_gt(0, params));
  inst.nonnegative = (params) => inst.check(_gte(0, params));
  inst.negative = (params) => inst.check(_lt(0, params));
  inst.nonpositive = (params) => inst.check(_lte(0, params));
  inst.multipleOf = (value, params) => inst.check(_multipleOf(value, params));
  inst.step = (value, params) => inst.check(_multipleOf(value, params));
  inst.finite = () => inst;
  const bag = inst._zod.bag;
  inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
  inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
  inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? 0.5);
  inst.isFinite = true;
  inst.format = bag.format ?? null;
});
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
function float32(params) {
  return _float32(ZodNumberFormat, params);
}
function float64(params) {
  return _float64(ZodNumberFormat, params);
}
function int32(params) {
  return _int32(ZodNumberFormat, params);
}
function uint32(params) {
  return _uint32(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodBigInt = /* @__PURE__ */ $constructor("ZodBigInt", (inst, def) => {
  $ZodBigInt.init(inst, def);
  ZodType.init(inst, def);
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.gt = (value, params) => inst.check(_gt(value, params));
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.lt = (value, params) => inst.check(_lt(value, params));
  inst.lte = (value, params) => inst.check(_lte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  inst.positive = (params) => inst.check(_gt(BigInt(0), params));
  inst.negative = (params) => inst.check(_lt(BigInt(0), params));
  inst.nonpositive = (params) => inst.check(_lte(BigInt(0), params));
  inst.nonnegative = (params) => inst.check(_gte(BigInt(0), params));
  inst.multipleOf = (value, params) => inst.check(_multipleOf(value, params));
  const bag = inst._zod.bag;
  inst.minValue = bag.minimum ?? null;
  inst.maxValue = bag.maximum ?? null;
  inst.format = bag.format ?? null;
});
function bigint2(params) {
  return _bigint(ZodBigInt, params);
}
var ZodBigIntFormat = /* @__PURE__ */ $constructor("ZodBigIntFormat", (inst, def) => {
  $ZodBigIntFormat.init(inst, def);
  ZodBigInt.init(inst, def);
});
function int64(params) {
  return _int64(ZodBigIntFormat, params);
}
function uint64(params) {
  return _uint64(ZodBigIntFormat, params);
}
var ZodSymbol = /* @__PURE__ */ $constructor("ZodSymbol", (inst, def) => {
  $ZodSymbol.init(inst, def);
  ZodType.init(inst, def);
});
function symbol(params) {
  return _symbol(ZodSymbol, params);
}
var ZodUndefined = /* @__PURE__ */ $constructor("ZodUndefined", (inst, def) => {
  $ZodUndefined.init(inst, def);
  ZodType.init(inst, def);
});
function _undefined3(params) {
  return _undefined2(ZodUndefined, params);
}
var ZodNull = /* @__PURE__ */ $constructor("ZodNull", (inst, def) => {
  $ZodNull.init(inst, def);
  ZodType.init(inst, def);
});
function _null3(params) {
  return _null2(ZodNull, params);
}
var ZodAny = /* @__PURE__ */ $constructor("ZodAny", (inst, def) => {
  $ZodAny.init(inst, def);
  ZodType.init(inst, def);
});
function any() {
  return _any(ZodAny);
}
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
});
function unknown() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodVoid = /* @__PURE__ */ $constructor("ZodVoid", (inst, def) => {
  $ZodVoid.init(inst, def);
  ZodType.init(inst, def);
});
function _void2(params) {
  return _void(ZodVoid, params);
}
var ZodDate = /* @__PURE__ */ $constructor("ZodDate", (inst, def) => {
  $ZodDate.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  const c = inst._zod.bag;
  inst.minDate = c.minimum ? new Date(c.minimum) : null;
  inst.maxDate = c.maximum ? new Date(c.maximum) : null;
});
function date3(params) {
  return _date(ZodDate, params);
}
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst.element = def.element;
  inst.min = (minLength, params) => inst.check(_minLength(minLength, params));
  inst.nonempty = (params) => inst.check(_minLength(1, params));
  inst.max = (maxLength, params) => inst.check(_maxLength(maxLength, params));
  inst.length = (len, params) => inst.check(_length(len, params));
  inst.unwrap = () => inst.element;
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
function keyof(schema) {
  const shape = schema._zod.def.shape;
  return _enum2(Object.keys(shape));
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  util_exports.defineLazy(inst, "shape", () => def.shape);
  inst.keyof = () => _enum2(Object.keys(inst._zod.def.shape));
  inst.catchall = (catchall) => inst.clone({ ...inst._zod.def, catchall });
  inst.passthrough = () => inst.clone({ ...inst._zod.def, catchall: unknown() });
  inst.loose = () => inst.clone({ ...inst._zod.def, catchall: unknown() });
  inst.strict = () => inst.clone({ ...inst._zod.def, catchall: never() });
  inst.strip = () => inst.clone({ ...inst._zod.def, catchall: void 0 });
  inst.extend = (incoming) => {
    return util_exports.extend(inst, incoming);
  };
  inst.safeExtend = (incoming) => {
    return util_exports.safeExtend(inst, incoming);
  };
  inst.merge = (other) => util_exports.merge(inst, other);
  inst.pick = (mask) => util_exports.pick(inst, mask);
  inst.omit = (mask) => util_exports.omit(inst, mask);
  inst.partial = (...args) => util_exports.partial(ZodOptional, inst, args[0]);
  inst.required = (...args) => util_exports.required(ZodNonOptional, inst, args[0]);
});
function object(shape, params) {
  const def = {
    type: "object",
    get shape() {
      util_exports.assignProp(this, "shape", shape ? util_exports.objectClone(shape) : {});
      return this.shape;
    },
    ...util_exports.normalizeParams(params)
  };
  return new ZodObject(def);
}
function strictObject(shape, params) {
  return new ZodObject({
    type: "object",
    get shape() {
      util_exports.assignProp(this, "shape", util_exports.objectClone(shape));
      return this.shape;
    },
    catchall: never(),
    ...util_exports.normalizeParams(params)
  });
}
function looseObject(shape, params) {
  return new ZodObject({
    type: "object",
    get shape() {
      util_exports.assignProp(this, "shape", util_exports.objectClone(shape));
      return this.shape;
    },
    catchall: unknown(),
    ...util_exports.normalizeParams(params)
  });
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...util_exports.normalizeParams(params)
  });
}
var ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodDiscriminatedUnion", (inst, def) => {
  ZodUnion.init(inst, def);
  $ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
  return new ZodDiscriminatedUnion({
    type: "union",
    options,
    discriminator,
    ...util_exports.normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodTuple = /* @__PURE__ */ $constructor("ZodTuple", (inst, def) => {
  $ZodTuple.init(inst, def);
  ZodType.init(inst, def);
  inst.rest = (rest) => inst.clone({
    ...inst._zod.def,
    rest
  });
});
function tuple(items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof $ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new ZodTuple({
    type: "tuple",
    items,
    rest,
    ...util_exports.normalizeParams(params)
  });
}
var ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
  $ZodRecord.init(inst, def);
  ZodType.init(inst, def);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
function partialRecord(keyType, valueType, params) {
  const k = clone(keyType);
  k._zod.values = void 0;
  return new ZodRecord({
    type: "record",
    keyType: k,
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
var ZodMap = /* @__PURE__ */ $constructor("ZodMap", (inst, def) => {
  $ZodMap.init(inst, def);
  ZodType.init(inst, def);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function map(keyType, valueType, params) {
  return new ZodMap({
    type: "map",
    keyType,
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
var ZodSet = /* @__PURE__ */ $constructor("ZodSet", (inst, def) => {
  $ZodSet.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (...args) => inst.check(_minSize(...args));
  inst.nonempty = (params) => inst.check(_minSize(1, params));
  inst.max = (...args) => inst.check(_maxSize(...args));
  inst.size = (...args) => inst.check(_size(...args));
});
function set(valueType, params) {
  return new ZodSet({
    type: "set",
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst.enum = def.entries;
  inst.options = Object.values(def.entries);
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...util_exports.normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...util_exports.normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum2(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...util_exports.normalizeParams(params)
  });
}
function nativeEnum(entries, params) {
  return new ZodEnum({
    type: "enum",
    entries,
    ...util_exports.normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...util_exports.normalizeParams(params)
  });
}
var ZodFile = /* @__PURE__ */ $constructor("ZodFile", (inst, def) => {
  $ZodFile.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (size, params) => inst.check(_minSize(size, params));
  inst.max = (size, params) => inst.check(_maxSize(size, params));
  inst.mime = (types, params) => inst.check(_mime(Array.isArray(types) ? types : [types], params));
});
function file(params) {
  return _file(ZodFile, params);
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(util_exports.issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(util_exports.issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output2) => {
        payload.value = output2;
        return payload;
      });
    }
    payload.value = output;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
function nullish2(innerType) {
  return optional(nullable(innerType));
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default2(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : util_exports.shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : util_exports.shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...util_exports.normalizeParams(params)
  });
}
var ZodSuccess = /* @__PURE__ */ $constructor("ZodSuccess", (inst, def) => {
  $ZodSuccess.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function success(innerType) {
  return new ZodSuccess({
    type: "success",
    innerType
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch2(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
var ZodNaN = /* @__PURE__ */ $constructor("ZodNaN", (inst, def) => {
  $ZodNaN.init(inst, def);
  ZodType.init(inst, def);
});
function nan(params) {
  return _nan(ZodNaN, params);
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
    // ...util.normalizeParams(params),
  });
}
var ZodCodec = /* @__PURE__ */ $constructor("ZodCodec", (inst, def) => {
  ZodPipe.init(inst, def);
  $ZodCodec.init(inst, def);
});
function codec(in_, out, params) {
  return new ZodCodec({
    type: "pipe",
    in: in_,
    out,
    transform: params.decode,
    reverseTransform: params.encode
  });
}
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodTemplateLiteral = /* @__PURE__ */ $constructor("ZodTemplateLiteral", (inst, def) => {
  $ZodTemplateLiteral.init(inst, def);
  ZodType.init(inst, def);
});
function templateLiteral(parts, params) {
  return new ZodTemplateLiteral({
    type: "template_literal",
    parts,
    ...util_exports.normalizeParams(params)
  });
}
var ZodLazy = /* @__PURE__ */ $constructor("ZodLazy", (inst, def) => {
  $ZodLazy.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.getter();
});
function lazy(getter) {
  return new ZodLazy({
    type: "lazy",
    getter
  });
}
var ZodPromise = /* @__PURE__ */ $constructor("ZodPromise", (inst, def) => {
  $ZodPromise.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function promise(innerType) {
  return new ZodPromise({
    type: "promise",
    innerType
  });
}
var ZodFunction = /* @__PURE__ */ $constructor("ZodFunction", (inst, def) => {
  $ZodFunction.init(inst, def);
  ZodType.init(inst, def);
});
function _function(params) {
  return new ZodFunction({
    type: "function",
    input: Array.isArray(params?.input) ? tuple(params?.input) : params?.input ?? array(unknown()),
    output: params?.output ?? unknown()
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
});
function check(fn) {
  const ch = new $ZodCheck({
    check: "custom"
    // ...util.normalizeParams(params),
  });
  ch._zod.check = fn;
  return ch;
}
function custom(fn, _params) {
  return _custom(ZodCustom, fn ?? (() => true), _params);
}
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn) {
  return _superRefine(fn);
}
function _instanceof(cls, params = {
  error: `Input not instance of ${cls.name}`
}) {
  const inst = new ZodCustom({
    type: "custom",
    check: "custom",
    fn: (data) => data instanceof cls,
    abort: true,
    ...util_exports.normalizeParams(params)
  });
  inst._zod.bag.Class = cls;
  return inst;
}
var stringbool = (...args) => _stringbool({
  Codec: ZodCodec,
  Boolean: ZodBoolean,
  String: ZodString
}, ...args);
function json(params) {
  const jsonSchema = lazy(() => {
    return union([string2(params), number2(), boolean2(), _null3(), array(jsonSchema), record(string2(), jsonSchema)]);
  });
  return jsonSchema;
}
function preprocess(fn, schema) {
  return pipe(transform(fn), schema);
}

// node_modules/zod/v4/classic/compat.js
var ZodIssueCode = {
  invalid_type: "invalid_type",
  too_big: "too_big",
  too_small: "too_small",
  invalid_format: "invalid_format",
  not_multiple_of: "not_multiple_of",
  unrecognized_keys: "unrecognized_keys",
  invalid_union: "invalid_union",
  invalid_key: "invalid_key",
  invalid_element: "invalid_element",
  invalid_value: "invalid_value",
  custom: "custom"
};
function setErrorMap(map2) {
  config({
    customError: map2
  });
}
function getErrorMap() {
  return config().customError;
}
var ZodFirstPartyTypeKind;
/* @__PURE__ */ (function(ZodFirstPartyTypeKind2) {
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));

// node_modules/zod/v4/classic/coerce.js
var coerce_exports = {};
__export(coerce_exports, {
  bigint: () => bigint3,
  boolean: () => boolean3,
  date: () => date4,
  number: () => number3,
  string: () => string3
});
function string3(params) {
  return _coercedString(ZodString, params);
}
function number3(params) {
  return _coercedNumber(ZodNumber, params);
}
function boolean3(params) {
  return _coercedBoolean(ZodBoolean, params);
}
function bigint3(params) {
  return _coercedBigint(ZodBigInt, params);
}
function date4(params) {
  return _coercedDate(ZodDate, params);
}

// node_modules/zod/v4/classic/external.js
config(en_default());

// node_modules/@opencode-ai/plugin/dist/tool.js
function tool(input) {
  return input;
}
tool.schema = external_exports;

// src/plugin.js
import { resolve as resolve22 } from "node:path";
import { readFile as readFile24 } from "node:fs/promises";

// src/adapter.js
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
var ADAPTER_CONTRACT_VERSION = 1;
var LOCK_FILENAME = "delivery.lock.json";
var ADAPTER_FILENAME = "delivery.json";
var KNOWN_KEYS = /* @__PURE__ */ new Set([
  "contractVersion",
  "repository",
  "forge",
  "worktree",
  "verification",
  "review",
  "ci",
  "ready",
  "merge",
  "cleanup"
]);
var KNOWN_REPOSITORY_KEYS = /* @__PURE__ */ new Set(["remote", "defaultBranch"]);
var KNOWN_FORGE_KEYS = /* @__PURE__ */ new Set([
  "driver",
  "issueRequired",
  "draftAfterFirstCommit",
  "issueClosingSyntax"
]);
var KNOWN_WORKTREE_KEYS = /* @__PURE__ */ new Set(["root", "branchTemplate", "bootstrap"]);
var KNOWN_VERIFICATION_KEYS = /* @__PURE__ */ new Set([
  "commands",
  "requireCleanDiffAfter",
  "invalidateOnHeadChange"
]);
var KNOWN_REVIEW_KEYS = /* @__PURE__ */ new Set(["agent", "required", "invalidateOnHeadChange"]);
var KNOWN_CI_KEYS = /* @__PURE__ */ new Set(["driver", "requiredChecks", "wait", "flakyRetry"]);
var KNOWN_READY_KEYS = /* @__PURE__ */ new Set(["requires", "stopAfterReady"]);
var KNOWN_MERGE_KEYS = /* @__PURE__ */ new Set(["strategy", "policy", "requireFreshGates"]);
var KNOWN_CLEANUP_KEYS = /* @__PURE__ */ new Set(["when", "requires"]);
function issuesFor(prefix, allowed, value) {
  const issues = [];
  for (const k of Object.keys(value)) {
    if (!allowed.has(k)) issues.push(`${prefix}.${k} is not a recognised field`);
  }
  return issues;
}
function isStringArrayOfArrays(v) {
  return Array.isArray(v) && v.every((row) => Array.isArray(row) && row.every((s) => typeof s === "string"));
}
function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}
function validateAdapter(value) {
  const issues = [];
  if (!value || typeof value !== "object") {
    return { ok: false, issues: ["root must be an object"] };
  }
  const obj = value;
  for (const k of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(k)) issues.push(`root.${k} is not a recognised field`);
  }
  if (obj.contractVersion !== 1) issues.push("contractVersion must be the literal 1");
  if (obj.repository !== void 0) {
    const r = obj.repository;
    issues.push(...issuesFor("repository", KNOWN_REPOSITORY_KEYS, r));
    if (r.defaultBranch !== void 0) {
      const db = r.defaultBranch;
      if (db.discover !== void 0 && typeof db.discover !== "boolean")
        issues.push("repository.defaultBranch.discover must be boolean");
      if (db.name !== void 0 && typeof db.name !== "string")
        issues.push("repository.defaultBranch.name must be string");
    }
  }
  if (obj.forge !== void 0) {
    const f = obj.forge;
    issues.push(...issuesFor("forge", KNOWN_FORGE_KEYS, f));
    if (f.driver !== void 0 && f.driver !== "github")
      issues.push("forge.driver must be 'github'");
    if (f.issueRequired !== void 0 && typeof f.issueRequired !== "boolean")
      issues.push("forge.issueRequired must be boolean");
    if (f.draftAfterFirstCommit !== void 0 && typeof f.draftAfterFirstCommit !== "boolean")
      issues.push("forge.draftAfterFirstCommit must be boolean");
    if (f.issueClosingSyntax !== void 0 && typeof f.issueClosingSyntax !== "boolean")
      issues.push("forge.issueClosingSyntax must be boolean");
  }
  if (obj.worktree !== void 0) {
    const w = obj.worktree;
    issues.push(...issuesFor("worktree", KNOWN_WORKTREE_KEYS, w));
    if (w.root !== void 0 && typeof w.root !== "string")
      issues.push("worktree.root must be string");
    if (w.branchTemplate !== void 0 && typeof w.branchTemplate !== "string")
      issues.push("worktree.branchTemplate must be string");
    if (w.bootstrap !== void 0 && !isStringArrayOfArrays(w.bootstrap))
      issues.push("worktree.bootstrap must be an array of argv arrays");
  }
  if (obj.verification !== void 0) {
    const v = obj.verification;
    issues.push(...issuesFor("verification", KNOWN_VERIFICATION_KEYS, v));
    if (v.commands !== void 0) {
      if (!Array.isArray(v.commands)) issues.push("verification.commands must be an array");
      else {
        for (let i = 0; i < v.commands.length; i++) {
          const cmd = v.commands[i];
          if (typeof cmd.id !== "string")
            issues.push(`verification.commands[${i}].id must be string`);
          if (!Array.isArray(cmd.argv) || !cmd.argv.every((s) => typeof s === "string"))
            issues.push(`verification.commands[${i}].argv must be string[]`);
          if (cmd.timeoutMs !== void 0 && typeof cmd.timeoutMs !== "number")
            issues.push(`verification.commands[${i}].timeoutMs must be number`);
        }
      }
    }
    if (v.requireCleanDiffAfter !== void 0 && typeof v.requireCleanDiffAfter !== "boolean")
      issues.push("verification.requireCleanDiffAfter must be boolean");
    if (v.invalidateOnHeadChange !== void 0 && typeof v.invalidateOnHeadChange !== "boolean")
      issues.push("verification.invalidateOnHeadChange must be boolean");
  }
  if (obj.review !== void 0) {
    const r = obj.review;
    issues.push(...issuesFor("review", KNOWN_REVIEW_KEYS, r));
    if (r.agent !== void 0 && typeof r.agent !== "string")
      issues.push("review.agent must be string");
    if (r.required !== void 0 && typeof r.required !== "boolean")
      issues.push("review.required must be boolean");
    if (r.invalidateOnHeadChange !== void 0 && typeof r.invalidateOnHeadChange !== "boolean")
      issues.push("review.invalidateOnHeadChange must be boolean");
  }
  if (obj.ci !== void 0) {
    const c = obj.ci;
    issues.push(...issuesFor("ci", KNOWN_CI_KEYS, c));
    if (c.driver !== void 0 && c.driver !== "github-status-checks")
      issues.push("ci.driver must be 'github-status-checks'");
    if (c.requiredChecks !== void 0 && !isStringArray(c.requiredChecks))
      issues.push("ci.requiredChecks must be string[]");
    if (c.wait !== void 0 && typeof c.wait !== "boolean")
      issues.push("ci.wait must be boolean");
    if (c.flakyRetry !== void 0 && c.flakyRetry !== 0 && c.flakyRetry !== 1)
      issues.push("ci.flakyRetry must be 0 or 1");
  }
  if (obj.ready !== void 0) {
    const r = obj.ready;
    issues.push(...issuesFor("ready", KNOWN_READY_KEYS, r));
    if (r.requires !== void 0) {
      const set2 = /* @__PURE__ */ new Set(["review", "local-verification", "remote-ci"]);
      const arr = r.requires;
      if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string" && set2.has(x))) {
        issues.push("ready.requires must be one of review|local-verification|remote-ci");
      }
    }
    if (r.stopAfterReady !== void 0 && typeof r.stopAfterReady !== "boolean")
      issues.push("ready.stopAfterReady must be boolean");
  }
  if (obj.merge !== void 0) {
    const m = obj.merge;
    issues.push(...issuesFor("merge", KNOWN_MERGE_KEYS, m));
    if (m.strategy !== void 0 && m.strategy !== "squash")
      issues.push("merge.strategy must be 'squash'");
    if (m.policy !== void 0 && m.policy !== "explicit-user-request-only")
      issues.push("merge.policy must be 'explicit-user-request-only'");
    if (m.requireFreshGates !== void 0 && typeof m.requireFreshGates !== "boolean")
      issues.push("merge.requireFreshGates must be boolean");
  }
  if (obj.cleanup !== void 0) {
    const c = obj.cleanup;
    issues.push(...issuesFor("cleanup", KNOWN_CLEANUP_KEYS, c));
    if (c.when !== void 0 && c.when !== "next-task")
      issues.push("cleanup.when must be 'next-task'");
    if (c.requires !== void 0) {
      const set2 = /* @__PURE__ */ new Set(["pr-merged", "worktree-clean", "no-unpublished-commits"]);
      const arr = c.requires;
      if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string" && set2.has(x))) {
        issues.push(
          "cleanup.requires must be one of pr-merged|worktree-clean|no-unpublished-commits"
        );
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, adapter: obj };
}
async function loadAdapter(repoRoot) {
  const path = resolve(repoRoot, ".opencode", ADAPTER_FILENAME);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { ok: false, error: { kind: "missing", path } };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: { kind: "parse", path, message: e.message } };
  }
  const v = validateAdapter(parsed);
  if (!v.ok) return { ok: false, error: { kind: "contract", path, issues: v.issues } };
  const sha2565 = createHash("sha256").update(raw).digest("hex");
  return { ok: true, adapter: v.adapter, path, sha256: sha2565 };
}
async function readLock(repoRoot) {
  const lockPath2 = resolve(repoRoot, ".opencode", LOCK_FILENAME);
  try {
    const raw = await readFile(lockPath2, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.contractVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

// src/drivers/gh-cli.js
import { spawn } from "node:child_process";

// src/drivers/github.js
function parseRepoSlug(slug) {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) return null;
  return { owner: slug.slice(0, slash), name: slug.slice(slash + 1) };
}

// src/drivers/github-command-policy.js
var ALLOWED_VERBS = /* @__PURE__ */ new Set([
  "issue list",
  "issue view",
  "issue create",
  "issue comment",
  "issue edit",
  "issue close",
  "pr list",
  "pr view",
  "pr create",
  "pr edit",
  "pr checks",
  "pr ready",
  "pr merge"
]);
var FORBIDDEN_FLAGS = /* @__PURE__ */ new Set([
  "--web",
  "--body-file",
  "--template"
]);
function validateGhArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 2) {
    return { ok: false, reason: "argv must be a non-empty array starting with the binary" };
  }
  const [bin, ...rest] = argv;
  if (bin !== "gh") {
    return { ok: false, reason: `expected 'gh' binary, got ${JSON.stringify(bin)}` };
  }
  if (rest.length === 0) {
    return { ok: false, reason: "no gh subcommand" };
  }
  const verb = rest.slice(0, 2).join(" ");
  if (verb.includes("api")) {
    return { ok: false, reason: "gh api is not allowed (use typed Ship tools instead)" };
  }
  if (!ALLOWED_VERBS.has(verb)) {
    return { ok: false, reason: `gh subcommand not in the allowlist: ${verb}` };
  }
  for (const arg of rest.slice(2)) {
    if (FORBIDDEN_FLAGS.has(arg)) {
      return { ok: false, reason: `gh flag ${arg} is forbidden (use Ship's typed body argument instead)` };
    }
    if (typeof arg !== "string" || arg.length === 0) {
      return { ok: false, reason: "gh argv must contain only non-empty strings" };
    }
  }
  return { ok: true, verb: (
    /** @type {any} */
    verb
  ) };
}

// src/drivers/gh-cli.js
function defaultRunner(cwd, env) {
  return (args) => new Promise((resolve23, reject2) => {
    const proc = spawn("gh", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => stdout += d.toString());
    proc.stderr.on("data", (d) => stderr += d.toString());
    proc.on("error", reject2);
    proc.on("close", (status) => resolve23({ status: status ?? -1, stdout, stderr }));
  });
}
function viewFields() {
  return [
    "number",
    "url",
    "baseRefName",
    "headRefName",
    "headRefOid",
    "isDraft",
    "mergeable",
    "mergeStateStatus",
    "state",
    "mergedAt"
  ].join(",");
}
function pullRequestSummaryFromView(fields) {
  const merged = fields.state === "MERGED" || fields.merged === true || typeof fields.mergedAt === "string" && fields.mergedAt.length > 0;
  return {
    number: fields.number,
    url: fields.url,
    baseRefName: fields.baseRefName,
    headRefName: fields.headRefName,
    headSha: fields.headRefOid,
    draft: Boolean(fields.isDraft),
    mergeable: fields.mergeable ?? "UNKNOWN",
    mergeStateStatus: fields.mergeStateStatus ?? "UNKNOWN",
    state: fields.state ?? "UNKNOWN",
    merged: Boolean(merged),
    mergedAt: fields.mergedAt ?? null
  };
}
async function ghJson(run, args) {
  const r = await run(args);
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${r.stderr.trim() || "(no stderr)"}`);
  }
  if (!r.stdout.trim()) {
    throw new Error(`gh ${args.join(" ")} returned empty stdout`);
  }
  return JSON.parse(r.stdout);
}
function createGhDriver(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const run = opts.runner ?? defaultRunner(cwd, env);
  return {
    async ensureIssue({ repo, title, body, labels }) {
      const repoSlug = parseRepoSlug(repo);
      if (!repoSlug) throw new Error(`ensureIssue: invalid repo slug ${repo}`);
      const list = await run([
        "issue",
        "list",
        "--repo",
        repo,
        "--search",
        title,
        "--state",
        "open",
        "--json",
        "number,title,state,url",
        "--limit",
        "20"
      ]);
      if (list.status === 0 && list.stdout.trim()) {
        const issues = JSON.parse(list.stdout);
        const exact = issues.find(
          (i) => i.title?.trim() === title.trim() && i.state === "OPEN"
        );
        if (exact) {
          return {
            summary: {
              number: exact.number,
              url: exact.url,
              state: "OPEN",
              pullRequest: null
            },
            created: false
          };
        }
      }
      const createArgs = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
      for (const label of labels ?? []) {
        createArgs.push("--label", label);
      }
      const created = await run(createArgs);
      if (created.status !== 0) {
        throw new Error(`gh issue create failed: ${created.stderr.trim() || "(no stderr)"}`);
      }
      const url2 = (created.stdout.trim().split("\n").pop() ?? "").trim();
      const m = url2.match(/\/issues\/(\d+)/);
      const number4 = m && m[1] ? parseInt(m[1], 10) : -1;
      return {
        summary: { number: number4, url: url2, state: "OPEN", pullRequest: null },
        created: true
      };
    },
    async openDraftPullRequest({ repo, head, base, title, body, issueNumber }) {
      if (!parseRepoSlug(repo)) throw new Error(`openDraftPullRequest: invalid repo slug ${repo}`);
      if (typeof issueNumber !== "number") throw new Error("openDraftPullRequest: issueNumber is required");
      const issueBody = body.includes(`Closes #${issueNumber}`) ? body : `${body}

Closes #${issueNumber}`;
      const args = [
        "pr",
        "create",
        "--repo",
        repo,
        "--draft",
        "--base",
        base,
        "--head",
        head,
        "--title",
        title,
        "--body",
        issueBody
      ];
      const r = await run(args);
      if (r.status !== 0) {
        throw new Error(`gh pr create failed: ${r.stderr.trim() || "(no stderr)"}`);
      }
      const url2 = (r.stdout.trim().split("\n").pop() ?? "").trim();
      const m = url2.match(/\/pull\/(\d+)/);
      const number4 = m && m[1] ? parseInt(m[1], 10) : -1;
      const fields = await ghJson(run, [
        "pr",
        "view",
        String(number4),
        "--repo",
        repo,
        "--json",
        viewFields()
      ]);
      return pullRequestSummaryFromView(fields);
    },
    async updatePullRequestBody({ repo, number: number4, body }) {
      if (typeof number4 !== "number") throw new Error("updatePullRequestBody: number is required");
      const r = await run(["pr", "edit", String(number4), "--repo", repo, "--body", body]);
      if (r.status !== 0) throw new Error(`gh pr edit failed: ${r.stderr.trim() || "(no stderr)"}`);
    },
    async markReady({ repo, number: number4 }) {
      if (typeof number4 !== "number") throw new Error("markReady: number is required");
      const r = await run(["pr", "ready", String(number4), "--repo", repo]);
      if (r.status !== 0) throw new Error(`gh pr ready failed: ${r.stderr.trim() || "(no stderr)"}`);
    },
    async mergePullRequest({ repo, number: number4, subject }) {
      if (typeof number4 !== "number") throw new Error("mergePullRequest: number is required");
      const args = [
        "pr",
        "merge",
        String(number4),
        "--repo",
        repo,
        "--squash",
        "--subject",
        subject
      ];
      const r = await run(args);
      if (r.status !== 0) {
        throw new Error(`gh pr merge failed: ${r.stderr.trim() || "(no stderr)"}`);
      }
      const fields = await ghJson(run, [
        "pr",
        "view",
        String(number4),
        "--repo",
        repo,
        "--json",
        viewFields()
      ]);
      return pullRequestSummaryFromView(fields);
    },
    async readPullRequest({ repo, number: number4 }) {
      if (typeof number4 !== "number") throw new Error("readPullRequest: number is required");
      const fields = await ghJson(run, [
        "pr",
        "view",
        String(number4),
        "--repo",
        repo,
        "--json",
        viewFields()
      ]);
      return pullRequestSummaryFromView(fields);
    },
    async readChecks({ repo, sha, number: number4, branch, required: required2 }) {
      const target = typeof number4 === "number" && Number.isFinite(number4) ? String(number4) : typeof branch === "string" && branch.length > 0 ? branch : typeof sha === "string" && sha.length > 0 ? String(sha) : null;
      if (target === null) {
        throw new Error("readChecks requires either a number, branch, or sha");
      }
      const r = await run([
        "pr",
        "checks",
        target,
        "--repo",
        repo,
        "--json",
        "name,state,bucket"
      ]);
      if (r.status !== 0) {
        if (/no checks reported/i.test(r.stderr ?? "")) {
          return [];
        }
        throw new Error(`gh pr checks failed: ${r.stderr.trim() || "(no stderr)"}`);
      }
      const all = r.stdout.trim() ? JSON.parse(r.stdout) : [];
      const out = [];
      for (const requiredName of required2 ?? []) {
        const match = all.find((c) => c.name === requiredName);
        if (!match) {
          out.push({ name: requiredName, state: "pending", bucket: "pending" });
          continue;
        }
        out.push({ name: match.name, state: match.state, bucket: match.bucket });
      }
      return out;
    },
    async comment({ repo, number: number4, body }) {
      if (typeof number4 !== "number") throw new Error("comment: number is required");
      const r = await run(["issue", "comment", String(number4), "--repo", repo, "--body", body]);
      if (r.status !== 0) throw new Error(`gh issue comment failed: ${r.stderr.trim() || "(no stderr)"}`);
    },
    async refreshHead({ repo, number: number4 }) {
      if (typeof number4 !== "number") throw new Error("refreshHead: number is required");
      const fields = await ghJson(run, [
        "pr",
        "view",
        String(number4),
        "--repo",
        repo,
        "--json",
        "headRefOid"
      ]);
      return fields.headRefOid;
    },
    async runCommand(argv) {
      if (!Array.isArray(argv) || argv.length === 0) {
        throw new Error("runCommand: argv must be a non-empty array");
      }
      if (typeof argv[0] !== "string" || argv[0].length === 0) {
        throw new Error("runCommand: argv[0] must be a non-empty string");
      }
      const policy = validateGhArgv(argv);
      if (!policy.ok) {
        throw new Error(`runCommand: rejected by policy: ${policy.reason}`);
      }
      const r = await run(argv);
      return r;
    }
  };
}

// src/doctor.js
import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve as resolve2 } from "node:path";
function runVersion(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}
async function doctor(repoRoot, packageVersion) {
  const adapter = await loadAdapter(repoRoot);
  const lock = await readLock(repoRoot);
  const checks = [];
  checks.push({
    name: "node>=20",
    ok: /^v(2[0-9]|[3-9]\d)/.test(process.version),
    detail: process.version
  });
  const git2 = runVersion(["git", "--version"]);
  checks.push({
    name: "git installed",
    ok: git2 !== null,
    detail: git2 ?? "git not on PATH"
  });
  const gh = runVersion(["gh", "--version"]);
  checks.push({
    name: "gh installed",
    ok: gh !== null,
    detail: gh ?? "gh CLI not on PATH"
  });
  checks.push({
    name: `adapter contract v${ADAPTER_CONTRACT_VERSION}`,
    ok: adapter.ok,
    detail: adapter.ok ? `loaded from ${adapter.path}` : adapter.error.kind
  });
  if (adapter.ok && lock) {
    checks.push({
      name: "lock sha matches adapter",
      ok: lock.adapterSha256 === adapter.sha256,
      detail: lock.adapterSha256 === adapter.sha256 ? "match" : "drift"
    });
  }
  checks.push({
    name: "package version pinned",
    ok: packageVersion !== null,
    detail: packageVersion ?? "missing"
  });
  return {
    contractVersion: 1,
    adapterPath: adapter.ok ? adapter.path : null,
    adapterSha256: adapter.ok ? adapter.sha256 : null,
    lockPath: lock ? resolve2(repoRoot, ".opencode", "delivery.lock.json") : null,
    lockSha256: lock ? lock.adapterSha256 : null,
    packageVersion,
    nodeVersion: process.version,
    ghVersion: gh,
    gitVersion: git2,
    checks
  };
}

// src/state/manifest-store.js
import { readFile as readFile3, readdir as readdir2, unlink as unlink2 } from "node:fs/promises";
import { join as join4, resolve as resolve5 } from "node:path";

// src/state/git-common-dir.js
import { spawn as spawn2 } from "node:child_process";
import { resolve as resolve3, join as join2 } from "node:path";
var STATE_DIRNAME = "opencode-ship";
async function resolveGitCommonDir(repoRoot) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new Error("resolveGitCommonDir: repoRoot must be a non-empty string");
  }
  return new Promise((resolveP, reject2) => {
    const proc = spawn2(
      "git",
      ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { stdio: ["ignore", "pipe", "pipe"], shell: false }
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => {
      out += d.toString("utf8");
    });
    proc.stderr.on("data", (d) => {
      err += d.toString("utf8");
    });
    proc.on("error", reject2);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject2(new Error(
          `git rev-parse --git-common-dir failed (exit ${code}): ${err.trim() || "unknown error"}`
        ));
        return;
      }
      const trimmed = out.trim();
      if (!trimmed) {
        reject2(new Error("git rev-parse --git-common-dir returned an empty path"));
        return;
      }
      resolveP(resolve3(repoRoot, trimmed));
    });
  });
}
function opencodeShipStateDir(commonDir, ...segments) {
  if (typeof commonDir !== "string" || commonDir.length === 0) {
    throw new Error("opencodeShipStateDir: commonDir must be a non-empty string");
  }
  return join2(commonDir, STATE_DIRNAME, ...segments);
}

// src/state/manifest-store.js
init_durable_store();
var SHIP_DIRNAME = "opencode-ship";
var LEGACY_DIRNAME = "opencode-delivery";
function canonicalManifestPath(commonDir, taskId) {
  return join4(commonDir, SHIP_DIRNAME, "delivery", "manifests", `${taskId}.json`);
}
function legacyManifestPath(commonDir, taskId) {
  return join4(commonDir, LEGACY_DIRNAME, "manifests", `${taskId}.json`);
}
async function commonDirFromRepoRoot(repoRoot) {
  return resolveGitCommonDir(repoRoot);
}
async function readJsonOrNull(path) {
  try {
    const raw = await readFile3(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function writeManifest(repoRoot, manifest) {
  const commonDir = await commonDirFromRepoRoot(repoRoot);
  const path = canonicalManifestPath(commonDir, manifest.taskId);
  await atomicReplaceJson(path, manifest);
  return resolve5(path);
}
async function readManifest(repoRoot, taskId) {
  const commonDir = await commonDirFromRepoRoot(repoRoot);
  const canonical = await readJsonOrNull(canonicalManifestPath(commonDir, taskId));
  if (canonical !== null) return canonical;
  const legacy = await readJsonOrNull(legacyManifestPath(commonDir, taskId));
  if (legacy !== null) return legacy;
  return null;
}
async function listManifests(repoRoot) {
  const commonDir = await commonDirFromRepoRoot(repoRoot);
  const canonicalDir = join4(commonDir, SHIP_DIRNAME, "delivery", "manifests");
  const legacyDir = join4(commonDir, LEGACY_DIRNAME, "manifests");
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const dir of [canonicalDir, legacyDir]) {
    let names;
    try {
      names = await readdir2(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      if (seen.has(name)) continue;
      const parsed = await readJsonOrNull(join4(dir, name));
      if (parsed !== null) {
        seen.add(name);
        out.push(parsed);
      }
    }
  }
  return out;
}
async function deleteManifest(repoRoot, taskId) {
  const commonDir = await commonDirFromRepoRoot(repoRoot);
  const canonical = canonicalManifestPath(commonDir, taskId);
  const legacy = legacyManifestPath(commonDir, taskId);
  await unlink2(canonical).catch(() => null);
  await unlink2(legacy).catch(() => null);
}

// src/tools/delivery-inspect.js
function createInspectTool(deps) {
  return async function inspect(input) {
    const manifest = await readManifest(deps.repoRoot, input.taskId);
    const doc = await doctor(deps.repoRoot, deps.packageVersion);
    return {
      contractVersion: 1,
      manifest: manifest ?? null,
      doctor: doc
    };
  };
}

// src/state/lifecycle.js
var STATES = [
  "issue-linked",
  "worktree-created",
  "draft-open",
  "validating",
  "ready",
  "merged",
  "cleanup-pending",
  "cleaned",
  "failed",
  "aborted"
];
var NEXT = {
  "issue-linked": ["issue-linked", "worktree-created", "aborted", "failed"],
  "worktree-created": ["worktree-created", "draft-open", "validating", "aborted", "failed"],
  "draft-open": ["draft-open", "validating", "aborted", "failed"],
  "validating": ["validating", "ready", "draft-open", "aborted", "failed"],
  "ready": ["ready", "merged", "validating", "aborted", "failed"],
  "merged": ["merged", "cleanup-pending", "aborted", "failed"],
  "cleanup-pending": ["cleanup-pending", "cleaned", "aborted", "failed"],
  "cleaned": ["cleaned"],
  "failed": ["failed", "aborted"],
  "aborted": ["aborted"]
};
function transition(m, to, opts) {
  opts = opts ?? {};
  if (!m || typeof m !== "object") {
    return { ok: false, from: void 0, attempted: to, reason: "manifest is missing" };
  }
  if (!STATES.includes(m.state)) {
    return { ok: false, from: m.state, attempted: to, reason: `manifest state ${m.state} is not recognised` };
  }
  if (!STATES.includes(to)) {
    return { ok: false, from: m.state, attempted: to, reason: `target state ${to} is not recognised` };
  }
  const allowed = NEXT[m.state];
  if (!allowed.includes(to)) {
    return { ok: false, from: m.state, attempted: to, reason: `transition from ${m.state} to ${to} is not permitted` };
  }
  const now = (opts.now ?? (() => /* @__PURE__ */ new Date()))();
  const at = now.getTime();
  const entry = { from: m.state, to, at };
  if (opts.reason !== void 0) entry.reason = opts.reason;
  const next = {
    ...m,
    state: to,
    transitionLog: [...m.transitionLog, entry],
    updatedAt: now.toISOString()
  };
  if (to === "failed") {
    next.fatalReason = opts.reason ?? "unspecified";
  }
  return { ok: true, from: m.state, to, at, reason: opts.reason };
}
function createManifest(input) {
  const now = (input.now ?? (() => /* @__PURE__ */ new Date()))();
  return {
    schemaVersion: 2,
    taskId: input.taskId,
    repoIdentity: input.repoIdentity,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber ?? null,
    baseBranch: input.baseBranch,
    baseSha: input.baseSha,
    branch: input.branch,
    worktreePath: input.worktreePath ?? null,
    lastPrHeadSha: input.lastPrHeadSha ?? null,
    lastReviewerSha: input.lastReviewerSha ?? null,
    lastVerifierSha: input.lastVerifierSha ?? null,
    workflowId: input.workflowId ?? null,
    owner: input.owner,
    state: "issue-linked",
    transitionLog: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

// src/tools/delivery-issue.js
function createIssueTool(deps) {
  return async function issue2(input) {
    if (!input.taskId) return { kind: "missing-input", field: "taskId" };
    if (!input.title) return { kind: "missing-input", field: "title" };
    if (!input.baseBranch) return { kind: "missing-input", field: "baseBranch" };
    if (!input.branch) return { kind: "missing-input", field: "branch" };
    const existing = await readManifest(deps.repoRoot, input.taskId);
    if (existing) {
      return {
        contractVersion: 1,
        created: false,
        issueNumber: existing.issueNumber,
        issueUrl: `https://github.com/${deps.repoSlug}/issues/${existing.issueNumber}`,
        manifestPath: "preserved",
        preserved: true
      };
    }
    const ensured = await deps.driver.ensureIssue({
      repo: deps.repoSlug,
      title: input.title,
      body: input.body ?? "",
      labels: input.labels ?? []
    });
    const m = createManifest({
      taskId: input.taskId,
      repoIdentity: deps.repoSlug,
      issueNumber: ensured.summary.number,
      baseBranch: input.baseBranch,
      baseSha: input.baseSha ?? "0000000000000000000000000000000000000000",
      branch: input.branch,
      owner: deps.owner,
      prNumber: null,
      lastPrHeadSha: null,
      lastReviewerSha: null,
      lastVerifierSha: null
    });
    const t = transition(m, "issue-linked", {
      reason: ensured.created ? "issue just created" : "issue reused"
    });
    if (!t.ok) {
      return { kind: "lifecycle", reason: t.reason };
    }
    const next = {
      ...m,
      state: t.to,
      transitionLog: [
        ...m.transitionLog,
        { from: t.from, to: t.to, at: t.at, reason: t.reason }
      ],
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const path = await writeManifest(deps.repoRoot, next);
    return {
      contractVersion: 1,
      created: ensured.created,
      issueNumber: ensured.summary.number,
      issueUrl: ensured.summary.url,
      manifestPath: path
    };
  };
}

// src/tools/delivery-worktree.js
import { resolve as resolve7 } from "node:path";
import { spawn as spawn3 } from "node:child_process";

// src/drivers/git.js
import { spawnSync as spawnSync2 } from "node:child_process";
import { resolve as resolve6 } from "node:path";
import { existsSync as existsSync3 } from "node:fs";
function runGit(args, cwd) {
  return spawnSync2("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
}
function listWorktrees(cwd) {
  const r = runGit(["worktree", "list", "--porcelain"], cwd);
  if (r.status !== 0) return [];
  const records = [];
  let cur = {};
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path && cur.branch && cur.head) {
        records.push({ path: cur.path, branch: cur.branch, head: cur.head });
      }
      cur = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  if (cur.path && cur.branch && cur.head) {
    records.push({ path: cur.path, branch: cur.branch, head: cur.head });
  }
  return records;
}
function isWorktreeClean(cwd) {
  const r = runGit(["status", "--porcelain"], cwd);
  if (r.status !== 0) return false;
  return r.stdout.trim().length === 0;
}
function isRebaseInProgress(cwd) {
  const merge2 = runGit(["rev-parse", "--git-path", "rebase-merge"], cwd);
  const apply = runGit(["rev-parse", "--git-path", "rebase-apply"], cwd);
  const mergeExists = merge2.status === 0 && safeExists(resolve6(cwd, merge2.stdout.trim()));
  const applyExists = apply.status === 0 && safeExists(resolve6(cwd, apply.stdout.trim()));
  return mergeExists || applyExists;
}
function safeExists(p) {
  try {
    return existsSync3(p);
  } catch {
    return false;
  }
}
function fetchBranch(remote, branch, cwd) {
  const r = runGit(["fetch", remote, branch], cwd);
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}
function remoteExists(remote, cwd) {
  const r = runGit(["remote", "get-url", remote], cwd);
  return r.status === 0;
}
function createWorktree(opts) {
  const args = ["worktree", "add", "-b", opts.branch, opts.worktreePath, opts.base];
  const r = runGit(args, opts.cwd);
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}
function worktreeExists(cwd, path) {
  return listWorktrees(cwd).some((w) => w.path === path);
}
function branchExistsLocally(branch, cwd) {
  const r = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
  return r.status === 0;
}
function branchExistsRemotely(remote, branch, cwd) {
  const r = runGit(["ls-remote", "--heads", remote, branch], cwd);
  return r.status === 0 && r.stdout.includes(`refs/heads/${branch}`);
}
function currentHead(cwd) {
  const r = runGit(["rev-parse", "HEAD"], cwd);
  return r.status === 0 ? r.stdout.trim() : null;
}
function mergeBaseRemoteHead(remote, branch, cwd) {
  const r = runGit(["rev-parse", "--verify", `${remote}/${branch}`], cwd);
  return r.status === 0 ? r.stdout.trim() : null;
}

// src/tools/delivery-worktree.js
function runBootstrap(args, cwd) {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn3(args[0], args.slice(1), {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    let stderr = "";
    proc.stderr.on("data", (d) => stderr += d.toString());
    proc.on("error", rejectP);
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectP(new Error(`bootstrap ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`));
      } else {
        resolveP();
      }
    });
  });
}
function isPathContained(repoRoot, worktreeRoot, candidatePath) {
  const rootAbs = resolve7(repoRoot, worktreeRoot);
  const normalized = resolve7(candidatePath);
  if (normalized !== rootAbs && !normalized.startsWith(rootAbs + "/")) {
    return false;
  }
  return true;
}
async function markBootstrapFailed(repoRoot, manifest, error45, argv) {
  const failed = {
    ...manifest,
    state: "cleanup-pending",
    fatalReason: `bootstrap failed: ${error45.message}`,
    transitionLog: [
      ...manifest.transitionLog,
      {
        from: manifest.state,
        to: "cleanup-pending",
        at: Date.now(),
        reason: `bootstrap failed: ${error45.message}`
      }
    ],
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeManifest(repoRoot, failed);
}
function createWorktreeTool(deps) {
  return async function worktree(input) {
    const m = await readManifest(deps.repoRoot, input.taskId);
    if (!m) return { kind: "missing-manifest", taskId: input.taskId };
    if (m.state !== "issue-linked" && m.state !== "worktree-created") {
      return { kind: "manifest-state", state: m.state };
    }
    if (!input.branch) return { kind: "missing-input", field: "branch" };
    if (!input.worktreeRelativePath) {
      return { kind: "missing-input", field: "worktreeRelativePath" };
    }
    const worktreeRoot = deps.adapter?.worktree?.root ?? ".worktrees";
    const worktreePath = resolve7(deps.repoRoot, input.worktreeRelativePath);
    if (!isPathContained(deps.repoRoot, worktreeRoot, worktreePath)) {
      return {
        kind: "path-escape",
        resolvedPath: worktreePath,
        expectedRoot: resolve7(deps.repoRoot, worktreeRoot)
      };
    }
    const remote = deps.remote ?? "origin";
    const hasRemote = remoteExists(remote, deps.repoRoot);
    if (hasRemote) {
      const fetched = fetchBranch(remote, m.baseBranch, deps.repoRoot);
      if (fetched.status !== 0) {
        return { kind: "remote-fetch", stderr: fetched.stderr };
      }
    }
    if (branchExistsLocally(input.branch, deps.repoRoot)) {
      return { kind: "branch-exists-locally", branch: input.branch };
    }
    if (branchExistsRemotely(remote, input.branch, deps.repoRoot)) {
      return { kind: "branch-exists-remotely", branch: input.branch };
    }
    if (worktreeExists(deps.repoRoot, worktreePath)) {
      return { kind: "worktree-exists" };
    }
    const baseRef = hasRemote ? `${remote}/${m.baseBranch}` : m.baseBranch;
    const created = createWorktree({
      cwd: deps.repoRoot,
      branch: input.branch,
      worktreePath,
      base: baseRef
    });
    if (created.status !== 0) {
      return { kind: "create-failed", stderr: created.stderr };
    }
    const head = currentHead(worktreePath);
    if (!head) {
      return { kind: "create-failed", stderr: "no HEAD after worktree create" };
    }
    const bootstrap = deps.adapter?.worktree?.bootstrap ?? [];
    for (const argv of bootstrap) {
      if (!Array.isArray(argv) || argv.length === 0) {
        return { kind: "bootstrap-invalid", bootstrap };
      }
      try {
        await runBootstrap(argv, worktreePath);
      } catch (e) {
        await markBootstrapFailed(
          deps.repoRoot,
          {
            ...m,
            worktreePath,
            branch: input.branch,
            baseSha: m.baseSha
          },
          e,
          argv
        );
        return { kind: "bootstrap-failed", stderr: e.message, argv };
      }
    }
    const baseSha = mergeBaseRemoteHead(remote, m.baseBranch, deps.repoRoot) ?? m.baseSha ?? null;
    if (!baseSha) return { kind: "missing-base-sha" };
    const t = transition(
      { ...m, worktreePath, branch: input.branch, baseSha },
      "worktree-created",
      { reason: "worktree created" }
    );
    if (!t.ok) return { kind: "lifecycle", reason: t.reason };
    const next = {
      ...m,
      worktreePath,
      branch: input.branch,
      baseSha,
      state: t.to,
      transitionLog: [
        ...m.transitionLog,
        { from: t.from, to: t.to, at: t.at, reason: t.reason }
      ],
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const path = await writeManifest(deps.repoRoot, next);
    return {
      contractVersion: 1,
      branch: input.branch,
      worktreePath,
      headSha: head,
      manifestPath: path
    };
  };
}

// src/tools/delivery-verify.js
import { spawn as spawn4 } from "node:child_process";

// src/workflow/gate-receipts.js
import { createHash as createHash3 } from "node:crypto";
import { mkdir as mkdir3, readFile as readFile4 } from "node:fs/promises";
import { existsSync as existsSync4 } from "node:fs";
import { join as join5 } from "node:path";

// src/installer/json-pointer.js
function isObject2(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject2(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function canonicalJson(value) {
  return stableStringify(value);
}

// src/workflow/gate-receipts.js
init_durable_store();
var SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
var HASH_RE = /^[0-9a-f]{64}$/;
var HEAD_RE = /^[0-9a-f]{40}$/;
function validateIdentity(taskId, kind, headSha, receiptHash = null) {
  if (!SAFE_ID_RE.test(taskId) || !SAFE_ID_RE.test(kind) || !HEAD_RE.test(headSha)) {
    throw new Error("invalid gate receipt identity");
  }
  if (receiptHash !== null && !HASH_RE.test(receiptHash)) throw new Error("invalid gate receipt hash");
}
function hashGateReceipt(receipt) {
  const { receiptHash: _receiptHash, ...payload } = receipt;
  return createHash3("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}
async function publishGateReceipt(repoRoot, taskId, kind, input) {
  validateIdentity(taskId, kind, input?.headSha);
  const receipt = { ...input, kind, taskId };
  receipt.receiptHash = hashGateReceipt(receipt);
  const commonDir = await resolveGitCommonDir(repoRoot);
  const dir = join5(opencodeShipStateDir(commonDir), "gate-receipts", taskId, kind, receipt.headSha);
  await mkdir3(dir, { recursive: true });
  const path = join5(dir, `${receipt.receiptHash}.json`);
  if (!existsSync4(path)) await publishImmutableJson(path, receipt);
  return { receipt, path };
}
async function readGateReceipt(repoRoot, taskId, kind, receiptHash) {
  if (!SAFE_ID_RE.test(taskId) || !SAFE_ID_RE.test(kind) || !HASH_RE.test(receiptHash)) {
    throw new Error("invalid gate receipt lookup");
  }
  const commonDir = await resolveGitCommonDir(repoRoot);
  const root = join5(opencodeShipStateDir(commonDir), "gate-receipts", taskId, kind);
  if (!existsSync4(root)) return null;
  const { readdir: readdir10 } = await import("node:fs/promises");
  for (const head of await readdir10(root)) {
    validateIdentity(taskId, kind, head, receiptHash);
    const path = join5(root, head, `${receiptHash}.json`);
    if (!existsSync4(path)) continue;
    const receipt = JSON.parse(await readFile4(path, "utf8"));
    if (receipt.kind !== kind || receipt.taskId !== taskId || hashGateReceipt(receipt) !== receipt.receiptHash) {
      throw new Error(`invalid ${kind} gate receipt`);
    }
    return receipt;
  }
  return null;
}

// src/tools/delivery-verify.js
import { createHash as createHash4 } from "node:crypto";
function runCommand(argv, cwd, timeoutMs) {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn4(argv[0], argv.slice(1), {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.stdout.on("data", (d) => stdoutChunks.push(d.toString()));
    proc.stderr.on("data", (d) => stderrChunks.push(d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolveP({
        status: killed ? -1 : code ?? -1,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join("")
      });
    });
  });
}
function createVerifyTool(deps) {
  return async function verify(input) {
    const m = await readManifest(deps.repoRoot, input.taskId);
    if (!m) return { kind: "missing-manifest", taskId: input.taskId };
    const commands = deps.adapter?.verification?.commands ?? [];
    if (commands.length === 0) return { kind: "no-commands" };
    const cmd = input.commandId ? commands.find((c) => c.id === input.commandId) : commands[0];
    if (!cmd) return { kind: "command-not-found", commandId: input.commandId ?? commands[0]?.id };
    if (!m.worktreePath) {
      return { kind: "manifest-state", state: m.state, reason: "no worktree" };
    }
    if (m.state !== "worktree-created" && m.state !== "draft-open" && m.state !== "validating" && m.state !== "ready") {
      return { kind: "manifest-state", state: m.state };
    }
    if (deps.adapter?.verification?.requireCleanDiffAfter) {
      if (!isWorktreeClean(m.worktreePath)) {
        return { kind: "worktree-dirty" };
      }
    }
    const head = currentHead(m.worktreePath);
    if (!head) return { kind: "no-head" };
    const timeoutMs = cmd.timeoutMs ?? 18e5;
    const result = await runCommand(cmd.argv, m.worktreePath, timeoutMs);
    const stdoutTail = result.stdout.slice(-2e3);
    const stderrTail = result.stderr.slice(-2e3);
    if (result.status !== 0) {
      return {
        kind: "verify-failed",
        commandId: cmd.id,
        status: result.status,
        stdoutTail,
        stderrTail,
        headSha: head
      };
    }
    const { receipt } = await publishGateReceipt(deps.repoRoot, m.taskId, "verification", {
      headSha: head,
      commandId: cmd.id,
      argv: cmd.argv,
      exitCode: 0,
      stdoutSha256: createHash4("sha256").update(result.stdout, "utf8").digest("hex"),
      stderrSha256: createHash4("sha256").update(result.stderr, "utf8").digest("hex")
    });
    const t = transition(
      { ...m, lastVerifierSha: head, lastVerificationHash: receipt.receiptHash },
      "validating",
      { reason: `verify ok (${cmd.id})` }
    );
    if (!t.ok) return { kind: "lifecycle", reason: t.reason };
    const next = {
      ...m,
      lastVerifierSha: head,
      lastVerificationHash: receipt.receiptHash,
      state: t.to,
      transitionLog: [
        ...m.transitionLog,
        { from: t.from, to: t.to, at: t.at, reason: t.reason }
      ],
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const manifestPath = await writeManifest(deps.repoRoot, next);
    return {
      contractVersion: 1,
      commandId: cmd.id,
      status: 0,
      stdoutTail,
      stderrTail,
      headSha: head,
      verificationHash: receipt.receiptHash,
      manifestPath
    };
  };
}

// src/tools/delivery-review.js
function createReviewTool(deps) {
  return async function review(input) {
    const m = await readManifest(deps.repoRoot, input.taskId);
    if (!m) return { kind: "missing-manifest", taskId: input.taskId };
    if (m.prNumber === null) return { kind: "missing-pr" };
    if (m.state !== "worktree-created" && m.state !== "draft-open" && m.state !== "validating" && m.state !== "ready") {
      return { kind: "manifest-state", state: m.state };
    }
    const prHead = await deps.driver.refreshHead({
      repo: deps.repoSlug,
      number: m.prNumber
    });
    if (input.status !== "pass") {
      return {
        kind: "review-not-pass",
        status: input.status,
        headSha: prHead,
        recordedReviewerSha: m.lastReviewerSha ?? null
      };
    }
    if (!input.headSha) {
      return {
        kind: "missing-head-sha",
        prHeadSha: prHead
      };
    }
    if (input.headSha !== prHead) {
      return {
        kind: "head-mismatch",
        reviewSha: input.headSha,
        prHeadSha: prHead
      };
    }
    const next = {
      ...m,
      lastReviewerSha: prHead,
      transitionLog: [
        ...m.transitionLog,
        {
          from: m.state,
          to: m.state,
          at: Date.now(),
          reason: `reviewer pass at ${prHead.slice(0, 7)}`
        }
      ],
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const path = await writeManifest(deps.repoRoot, next);
    return {
      contractVersion: 1,
      pr: m.prNumber,
      reviewerSha: prHead,
      manifestPath: path
    };
  };
}

// src/tools/delivery-pr.js
function preserveClosingReference(existingBody, issueNumber) {
  if (!existingBody) return null;
  const match = existingBody.match(/Closes\s+#(\d+)/i);
  if (match) {
    if (match[1] === String(issueNumber)) return existingBody;
    return existingBody.replace(/Closes\s+#\d+/i, `Closes #${issueNumber}`);
  }
  return `${existingBody}

Closes #${issueNumber}`;
}
function createPrTool(deps) {
  return async function pr(input) {
    const m = await readManifest(deps.repoRoot, input.taskId);
    if (!m) return { kind: "missing-manifest", taskId: input.taskId };
    if (m.state !== "worktree-created" && m.state !== "draft-open") {
      return { kind: "manifest-state", state: m.state };
    }
    if (m.prNumber === null) {
      const opened = await deps.driver.openDraftPullRequest({
        repo: deps.repoSlug,
        head: m.branch,
        base: m.baseBranch,
        title: input.title,
        body: input.body,
        issueNumber: m.issueNumber
      });
      const t = transition(m, "draft-open", { reason: "draft opened" });
      if (!t.ok) return { kind: "lifecycle", reason: t.reason };
      const next2 = {
        ...m,
        prNumber: opened.number,
        lastPrHeadSha: opened.headSha,
        state: t.to,
        transitionLog: [
          ...m.transitionLog,
          { from: t.from, to: t.to, at: t.at, reason: t.reason }
        ],
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const path2 = await writeManifest(deps.repoRoot, next2);
      return { contractVersion: 1, pr: opened, manifestPath: path2 };
    }
    const existingPr = await deps.driver.readPullRequest({
      repo: deps.repoSlug,
      number: m.prNumber
    });
    const mergedBody = preserveClosingReference(
      input.body,
      m.issueNumber
    ) ?? input.body;
    await deps.driver.updatePullRequestBody({
      repo: deps.repoSlug,
      number: m.prNumber,
      body: mergedBody
    });
    const refreshed = typeof existingPr?.headSha === "string" && existingPr.headSha ? existingPr.headSha : await deps.driver.refreshHead({ repo: deps.repoSlug, number: m.prNumber });
    const next = {
      ...m,
      lastPrHeadSha: refreshed,
      transitionLog: [
        ...m.transitionLog,
        {
          from: m.state,
          to: m.state,
          at: Date.now(),
          reason: `pr body updated (head ${refreshed.slice(0, 7)})`
        }
      ],
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const path = await writeManifest(deps.repoRoot, next);
    return {
      contractVersion: 1,
      pr: {
        number: m.prNumber,
        url: existingPr?.url ?? "",
        baseRefName: existingPr?.baseRefName ?? m.baseBranch,
        headRefName: existingPr?.headRefName ?? m.branch,
        headSha: refreshed,
        draft: existingPr?.draft ?? true,
        mergeable: existingPr?.mergeable ?? "UNKNOWN",
        mergeStateStatus: existingPr?.mergeStateStatus ?? "UNKNOWN",
        merged: existingPr?.merged ?? false,
        mergedAt: existingPr?.mergedAt ?? null
      },
      manifestPath: path
    };
  };
}

// src/gates.js
var CHECK_BUCKETS = /* @__PURE__ */ new Map([
  ["pass", "pass"],
  ["fail", "fail"],
  ["pending", "pending"],
  ["skip", "skip"],
  ["neutral", "neutral"]
]);
function bucketFor(check2) {
  if (!check2) return "pending";
  if (CHECK_BUCKETS.has(check2.bucket)) return check2.bucket;
  if (check2.state === "success") return "pass";
  if (check2.state === "failure") return "fail";
  return "pending";
}
function finalReviewGateSnapshot(manifest) {
  return {
    standards: manifest?.finalStandardsReview ?? null,
    spec: manifest?.finalSpecReview ?? null
  };
}
function gateSnapshot({ manifest, prHead, checks }) {
  const required2 = manifest.adapter?.ci?.requiredChecks ?? [];
  const observed = checks ?? [];
  const missing = [];
  const failing = [];
  const pending = [];
  for (const name of required2) {
    const match = observed.find((c) => c.name === name);
    if (!match) {
      missing.push(name);
      pending.push(name);
      continue;
    }
    const bucket = bucketFor(match);
    if (bucket === "fail") failing.push(name);
    else if (bucket === "pending") pending.push(name);
  }
  return {
    prHead: prHead ?? null,
    reviewerSha: manifest?.lastReviewerSha ?? null,
    verifierSha: manifest?.lastVerifierSha ?? null,
    finalReviews: finalReviewGateSnapshot(manifest ?? {}),
    checks: observed,
    missingChecks: missing,
    failingChecks: failing,
    pendingChecks: pending
  };
}
function checkGates({ manifest, prHead, checks, requires }) {
  const snap = gateSnapshot({ manifest, prHead, checks });
  const need = new Set(requires ?? ["review", "local-verification", "remote-ci"]);
  const hasDualFinalReview = Boolean(
    manifest?.finalStandardsReview || manifest?.finalSpecReview
  );
  if (need.has("review")) {
    if (hasDualFinalReview) {
      const standards = manifest?.finalStandardsReview;
      const spec = manifest?.finalSpecReview;
      if (!standards || !standards.headSha) {
        return { ok: false, reason: "missing-final-review", axis: "standards", snapshot: snap };
      }
      if (!spec || !spec.headSha) {
        return { ok: false, reason: "missing-final-review", axis: "spec", snapshot: snap };
      }
      if (standards.headSha !== prHead) {
        return { ok: false, reason: "head-changed-after-final-review", axis: "standards", snapshot: snap };
      }
      if (spec.headSha !== prHead) {
        return { ok: false, reason: "head-changed-after-final-review", axis: "spec", snapshot: snap };
      }
      if (standards.headSha !== spec.headSha) {
        return { ok: false, reason: "final-review-head-mismatch", snapshot: snap };
      }
      if ((standards.packageHash ?? null) !== (spec.packageHash ?? null)) {
        return { ok: false, reason: "final-review-package-mismatch", snapshot: snap };
      }
      if ((standards.verdict ?? null) !== "pass" || (spec.verdict ?? null) !== "pass") {
        return { ok: false, reason: "final-review-failed", snapshot: snap };
      }
    } else {
      if (!manifest?.lastReviewerSha) return { ok: false, reason: "missing-review", snapshot: snap };
      if (manifest.lastReviewerSha !== prHead) {
        return { ok: false, reason: "head-changed-after-review", snapshot: snap };
      }
    }
  }
  if (need.has("local-verification")) {
    if (!manifest?.lastVerifierSha) return { ok: false, reason: "missing-verifier", snapshot: snap };
    if (manifest.lastVerifierSha !== prHead) {
      return { ok: false, reason: "head-changed-after-verifier", snapshot: snap };
    }
  }
  if (need.has("remote-ci")) {
    if (snap.missingChecks.length > 0) {
      return { ok: false, reason: "ci-missing", snapshot: snap };
    }
    if (snap.failingChecks.length > 0) {
      return { ok: false, reason: "ci-failing", snapshot: snap };
    }
    if (snap.pendingChecks.length > 0) {
      return { ok: false, reason: "ci-pending", snapshot: snap };
    }
  }
  return { ok: true, snapshot: snap };
}
function gateFailureEnvelope(result) {
  switch (result.reason) {
    case "missing-review":
      return { kind: "missing-gate", gate: "review" };
    case "missing-verifier":
      return { kind: "missing-gate", gate: "local-verification" };
    case "missing-final-review":
      return {
        kind: "missing-final-review",
        axis: result.axis
      };
    case "final-review-head-mismatch":
      return { kind: "final-review-head-mismatch" };
    case "final-review-package-mismatch":
      return { kind: "final-review-package-mismatch" };
    case "final-review-failed":
      return { kind: "final-review-failed" };
    case "head-changed-after-review":
      return {
        kind: "head-changed-after-review",
        headSha: result.snapshot.prHead ?? "",
        reviewSha: result.snapshot.reviewerSha ?? ""
      };
    case "head-changed-after-verifier":
      return {
        kind: "head-changed-after-verifier",
        headSha: result.snapshot.prHead ?? "",
        verifierSha: result.snapshot.verifierSha ?? ""
      };
    case "head-changed-after-final-review":
      return {
        kind: "head-changed-after-final-review",
        axis: result.axis,
        headSha: result.snapshot.prHead ?? ""
      };
    case "ci-missing":
      return { kind: "ci-missing", missing: result.snapshot.missingChecks };
    case "ci-failing":
      return { kind: "ci-failing", failing: result.snapshot.failingChecks };
    case "ci-pending":
      return { kind: "ci-pending", pending: result.snapshot.pendingChecks };
    default:
      return { kind: "gate-failed", reason: result.reason };
  }
}

// src/workflow/run-controller.js
import { createHash as createHash5 } from "node:crypto";
import { readFile as readFile5, writeFile as writeFile3, mkdir as mkdir4, readdir as readdir3 } from "node:fs/promises";
import { existsSync as existsSync5 } from "node:fs";
import { join as join6 } from "node:path";
init_durable_store();
async function readSnapshotFromDisk(repoRoot, workflowId) {
  const common = await resolveGitCommonDir(repoRoot);
  const runPath = join6(opencodeShipStateDir(common), "runs", workflowId, "run.json");
  if (!existsSync5(runPath)) return null;
  try {
    const raw = await readFile5(runPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function readEventsFromDisk(repoRoot, workflowId) {
  const common = await resolveGitCommonDir(repoRoot);
  const dir = join6(opencodeShipStateDir(common), "runs", workflowId, "events");
  if (!existsSync5(dir)) return [];
  const entries = await readdir3(dir);
  const sorted = entries.filter((n) => n.endsWith(".json")).sort();
  const out = [];
  for (const name of sorted) {
    const raw = await readFile5(join6(dir, name), "utf8");
    out.push(JSON.parse(raw));
  }
  return out;
}
var STATES2 = Object.freeze({
  CREATED: "created",
  RUNNING: "running",
  COMMIT_PENDING: "commit-pending",
  COMMITTED: "committed",
  FIX_PENDING: "fix-pending",
  REVISION_REQUIRED: "revision-required",
  BLOCKED: "blocked",
  ALL_TASKS_DONE: "all-tasks-done",
  READY_PENDING: "ready-pending",
  READY: "ready",
  MERGED: "merged",
  DONE: "done"
});
var EVENT_KINDS = Object.freeze({
  RUN_START: "run-start",
  TASK_DISPATCH: "task-dispatch",
  TASK_REPORT: "task-report",
  TASK_REVIEW: "task-review",
  COMMIT: "commit",
  TASK_COMPLETE: "task-complete",
  ALL_TASKS_DONE: "all-tasks-done",
  FINAL_REVIEW: "final-review",
  READY_PENDING: "ready-pending",
  READY: "ready",
  MERGE: "merge",
  DONE: "done",
  BLOCKED: "blocked"
});
var MAX_FIX_ROUNDS = 3;
function sha256(value) {
  return createHash5("sha256").update(value, "utf8").digest("hex");
}
function canonicalize(value) {
  const seen = /* @__PURE__ */ new WeakSet();
  const sort = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(sort);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
    return out;
  };
  return JSON.stringify(sort(value));
}
function nextRound(failures) {
  return (failures ?? 0) + 1;
}
function nextSequence(events) {
  return events.length + 1;
}
function appendEvent(state, recorded) {
  const prev = state.events[state.events.length - 1];
  const priorHash = prev?.hash ?? "0".repeat(64);
  const hash2 = sha256(canonicalize({ kind: recorded.kind, data: recorded.data, at: recorded.at, sequence: recorded.sequence, priorHash }));
  const withHash = { ...recorded, priorHash, hash: hash2 };
  return [...state.events, withHash];
}
function normalizeState(state) {
  return {
    ...state,
    completedTasks: Array.isArray(state.completedTasks) ? state.completedTasks : [],
    taskReady: state.taskReady ?? null,
    events: Array.isArray(state.events) ? state.events : [],
    round: Number.isInteger(state.round) ? state.round : 0,
    failures: Number.isInteger(state.failures) ? state.failures : 0
  };
}
function ensureActiveTask(state, taskId) {
  if (state.activeTask === null) return;
  if (state.activeTask !== taskId) {
    throw new Error(`run reducer: another task is active (${state.activeTask}), refusing ${taskId}`);
  }
}
function reduce(state, event) {
  const ev = { ...event, at: event.at ?? (/* @__PURE__ */ new Date()).toISOString() };
  const sequence = nextSequence(state.events);
  const recorded = (kind, data) => ({ sequence, kind, at: ev.at, data });
  const nextState = (extra) => ({ ...state, ...extra, events: appendEvent(state, recorded(event.kind, event.data)) });
  switch (event.kind) {
    case EVENT_KINDS.RUN_START: {
      if (state.state !== STATES2.CREATED) {
        throw new Error(`run reducer: RUN_START requires state=created, got ${state.state}`);
      }
      return {
        state: nextState({ state: STATES2.RUNNING, activeTask: null, round: 0, completedTasks: [] }),
        event: recorded(EVENT_KINDS.RUN_START, { revision: event.data.revision, sha256: event.data.sha256 })
      };
    }
    case EVENT_KINDS.TASK_DISPATCH: {
      if (state.state !== STATES2.RUNNING && state.state !== STATES2.FIX_PENDING) {
        throw new Error(`run reducer: TASK_DISPATCH requires state=running|fix-pending, got ${state.state}`);
      }
      if (state.activeTask !== null) {
        throw new Error(`run reducer: TASK_DISPATCH while another task is active (${state.activeTask})`);
      }
      const round = state.round > 0 ? state.round : 1;
      return {
        state: nextState({ state: STATES2.RUNNING, activeTask: event.data.taskId, round }),
        event: recorded(EVENT_KINDS.TASK_DISPATCH, { taskId: event.data.taskId, briefHash: event.data.briefHash, round })
      };
    }
    case EVENT_KINDS.TASK_REPORT: {
      if (state.state !== STATES2.RUNNING && state.state !== STATES2.FIX_PENDING || state.activeTask === null) {
        throw new Error(`run reducer: TASK_REPORT requires running with active task`);
      }
      ensureActiveTask(state, event.data.taskId);
      return {
        state: nextState({ state: STATES2.RUNNING, taskReady: { taskId: event.data.taskId, reportHash: event.data.reportHash } }),
        event: recorded(EVENT_KINDS.TASK_REPORT, { taskId: event.data.taskId, reportHash: event.data.reportHash })
      };
    }
    case EVENT_KINDS.TASK_REVIEW: {
      if (state.state !== STATES2.RUNNING && state.state !== STATES2.FIX_PENDING || state.activeTask === null) {
        throw new Error(`run reducer: TASK_REVIEW requires running with active task`);
      }
      ensureActiveTask(state, event.data.taskId);
      const failures = event.data.verdict === "pass" ? 0 : nextRound(state.failures);
      if (event.data.verdict === "pass") {
        return {
          state: nextState({ state: STATES2.COMMIT_PENDING, round: state.round, taskReady: { ...state.taskReady ?? {}, taskId: event.data.taskId, reviewHash: event.data.reviewHash } }),
          event: recorded(EVENT_KINDS.TASK_REVIEW, { taskId: event.data.taskId, verdict: "pass", reviewHash: event.data.reviewHash })
        };
      }
      const next = nextRound(state.round);
      if (failures >= MAX_FIX_ROUNDS) {
        return {
          state: nextState({ state: STATES2.REVISION_REQUIRED, failures, round: next, activeTask: null }),
          event: recorded(EVENT_KINDS.TASK_REVIEW, { taskId: event.data.taskId, verdict: "fail", failures })
        };
      }
      return {
        state: nextState({ state: STATES2.FIX_PENDING, failures, round: next, activeTask: null, taskReady: null }),
        event: recorded(EVENT_KINDS.TASK_REVIEW, { taskId: event.data.taskId, verdict: "fail", round: next, failures })
      };
    }
    case EVENT_KINDS.COMMIT: {
      if (state.state !== STATES2.COMMIT_PENDING) {
        throw new Error(`run reducer: COMMIT requires state=commit-pending, got ${state.state}`);
      }
      const taskId = state.taskReady?.taskId;
      const completedTasks = taskId ? state.completedTasks.includes(taskId) ? state.completedTasks : [...state.completedTasks, taskId] : state.completedTasks;
      return {
        state: nextState({ state: STATES2.COMMITTED, activeTask: null, round: 0, failures: 0, completedTasks }),
        event: recorded(EVENT_KINDS.COMMIT, { taskId, commitSha: event.data.commitSha })
      };
    }
    case EVENT_KINDS.TASK_COMPLETE: {
      if (state.state !== STATES2.COMMITTED) {
        throw new Error(`run reducer: TASK_COMPLETE requires state=committed, got ${state.state}`);
      }
      const moreTasks = event.data.moreTasks === false ? false : true;
      const nextStateObj = moreTasks ? { state: STATES2.RUNNING, activeTask: null, taskReady: null, round: 0, failures: 0 } : { state: STATES2.ALL_TASKS_DONE, activeTask: null, taskReady: null };
      return {
        state: nextState(nextStateObj),
        event: recorded(EVENT_KINDS.TASK_COMPLETE, { taskId: event.data.taskId, moreTasks, nextTaskId: event.data.nextTaskId ?? null })
      };
    }
    case EVENT_KINDS.FINAL_REVIEW: {
      if (state.state !== STATES2.ALL_TASKS_DONE && state.state !== STATES2.READY_PENDING) {
        throw new Error(`run reducer: FINAL_REVIEW requires state=all-tasks-done|ready-pending, got ${state.state}`);
      }
      const incomingHash = event.data.packageHash;
      const incomingHead = event.data.headSha;
      const incomingMergeBase = event.data.mergeBaseSha;
      const finalReview = { ...state.finalReview ?? {} };
      if (state.state === STATES2.ALL_TASKS_DONE) {
        finalReview.packageHash = incomingHash;
        finalReview.headSha = incomingHead;
        finalReview.mergeBaseSha = incomingMergeBase;
      } else {
        if (finalReview.packageHash !== incomingHash) {
          throw new Error(`run reducer: FINAL_REVIEW axis ${event.data.axis} disagrees with package hash`);
        }
        if (finalReview.headSha !== incomingHead) {
          throw new Error(`run reducer: FINAL_REVIEW axis ${event.data.axis} disagrees with HEAD`);
        }
        if (finalReview.mergeBaseSha !== incomingMergeBase) {
          throw new Error(`run reducer: FINAL_REVIEW axis ${event.data.axis} disagrees with merge-base`);
        }
      }
      finalReview[event.data.axis] = event.data.review;
      return {
        state: nextState({
          state: STATES2.READY_PENDING,
          finalReview
        }),
        event: recorded(EVENT_KINDS.FINAL_REVIEW, {
          axis: event.data.axis,
          verdict: event.data.verdict,
          headSha: incomingHead,
          mergeBaseSha: incomingMergeBase,
          packageHash: incomingHash,
          sessionID: event.data.sessionID,
          review: event.data.review
        })
      };
    }
    case EVENT_KINDS.READY: {
      if (state.state !== STATES2.COMMITTED && state.state !== STATES2.READY_PENDING) {
        throw new Error(`run reducer: READY requires state=committed|ready-pending, got ${state.state}`);
      }
      if (state.state === STATES2.READY_PENDING && (!state.finalReview?.standards || !state.finalReview?.spec)) {
        throw new Error(`run reducer: READY requires both Standards and Spec final reviews`);
      }
      if (state.state === STATES2.READY_PENDING && state.finalReview.headSha && event.data.headSha && state.finalReview.headSha !== event.data.headSha) {
        throw new Error(`run reducer: READY head drift (finalReview=${state.finalReview.headSha.slice(0, 8)}, ready=${event.data.headSha.slice(0, 8)})`);
      }
      return {
        state: nextState({ state: STATES2.READY, activeTask: null, completedTasks: state.completedTasks }),
        event: recorded(EVENT_KINDS.READY, { headSha: event.data.headSha })
      };
    }
    case EVENT_KINDS.MERGE: {
      if (state.state !== STATES2.READY) {
        throw new Error(`run reducer: MERGE requires state=ready, got ${state.state}`);
      }
      return {
        state: nextState({ state: STATES2.MERGED, mergedAt: ev.at, mergeSha: event.data.mergeSha }),
        event: recorded(EVENT_KINDS.MERGE, { mergeSha: event.data.mergeSha })
      };
    }
    case EVENT_KINDS.DONE: {
      if (state.state !== STATES2.MERGED) {
        throw new Error(`run reducer: DONE requires state=merged, got ${state.state}`);
      }
      return {
        state: nextState({ state: STATES2.DONE, activeTask: null }),
        event: recorded(EVENT_KINDS.DONE, { taskId: event.data.taskId })
      };
    }
    case EVENT_KINDS.BLOCKED: {
      return {
        state: nextState({ state: STATES2.BLOCKED, blockedReason: event.data.reason }),
        event: recorded(EVENT_KINDS.BLOCKED, { reason: event.data.reason })
      };
    }
    default:
      throw new Error(`run reducer: unknown event kind ${event.kind}`);
  }
}
function createInitialState(workflowId, revision, sha2565) {
  return {
    workflowId,
    revision,
    sha256: sha2565,
    state: STATES2.CREATED,
    activeTask: null,
    taskReady: null,
    round: 0,
    failures: 0,
    completedTasks: [],
    events: []
  };
}
var RUN_EVENT_KINDS = EVENT_KINDS;
function snapshotFields(state) {
  return {
    workflowId: state.workflowId,
    revision: state.revision,
    sha256: state.sha256,
    state: state.state,
    activeTask: state.activeTask,
    taskReady: state.taskReady ?? null,
    failures: state.failures,
    round: state.round,
    completedTasks: state.completedTasks,
    finalReview: state.finalReview ?? null
  };
}
function replayPersistedRun(workflowId, snapshot, events) {
  if (!snapshot || events.length === 0) {
    throw new Error("run state has no immutable event ledger");
  }
  const first = events[0];
  if (first.kind !== EVENT_KINDS.RUN_START) {
    throw new Error("run event ledger must begin with run-start");
  }
  let state = createInitialState(workflowId, first.data?.revision, first.data?.sha256);
  let priorHash = "0".repeat(64);
  for (let index = 0; index < events.length; index += 1) {
    const persisted = events[index];
    if (persisted.sequence !== index + 1 || persisted.priorHash !== priorHash) {
      throw new Error(`run event ledger chain mismatch at sequence ${index + 1}`);
    }
    const expectedHash = sha256(canonicalize({
      kind: persisted.kind,
      data: persisted.data,
      at: persisted.at,
      sequence: persisted.sequence,
      priorHash
    }));
    if (persisted.hash !== expectedHash) {
      throw new Error(`run event ledger hash mismatch at sequence ${index + 1}`);
    }
    const reduced = reduce(state, { kind: persisted.kind, data: persisted.data, at: persisted.at });
    const replayedEvent = reduced.state.events.at(-1);
    if (replayedEvent.hash !== persisted.hash) {
      throw new Error(`run event ledger replay mismatch at sequence ${index + 1}`);
    }
    state = reduced.state;
    priorHash = persisted.hash;
  }
  if (canonicalize(snapshotFields(state)) !== canonicalize(snapshotFields(snapshot))) {
    throw new Error("run snapshot does not match immutable event ledger");
  }
  return state;
}
async function runDir(repoRoot, workflowId) {
  const common = await resolveGitCommonDir(repoRoot);
  return join6(opencodeShipStateDir(common), "runs", workflowId);
}
async function appendRunEvent(repoRoot, workflowId, state, event) {
  const common = await resolveGitCommonDir(repoRoot);
  const dir = join6(opencodeShipStateDir(common), "runs", workflowId, "events");
  await mkdir4(dir, { recursive: true });
  const lockKey = `run:${workflowId}`;
  return withResourceLock(opencodeShipStateDir(common), lockKey, async () => {
    const persistedEvents = await readEventsFromDisk(repoRoot, workflowId);
    const persistedSnapshot = await readSnapshotFromDisk(repoRoot, workflowId);
    const liveState = persistedEvents.length > 0 ? replayPersistedRun(workflowId, persistedSnapshot, persistedEvents) : normalizeState(state);
    const { state: next, event: recorded } = reduce(liveState, event);
    const chainedEvent = next.events.at(-1);
    const sequence = String(recorded.sequence).padStart(8, "0");
    const path = join6(dir, `${sequence}.json`);
    await publishImmutableJson(path, chainedEvent);
    const runPath = join6(opencodeShipStateDir(common), "runs", workflowId, "run.json");
    const snapshot = {
      ...snapshotFields(next),
      lastEvent: chainedEvent,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await writeFile3(runPath, JSON.stringify(snapshot, null, 2), "utf8");
    return { state: next, event: chainedEvent };
  });
}
async function readRunState(repoRoot, workflowId) {
  const dir = await runDir(repoRoot, workflowId);
  const runPath = join6(dir, "run.json");
  if (!existsSync5(runPath)) return null;
  const snapshot = JSON.parse(await readFile5(runPath, "utf8"));
  const eventsDir = join6(dir, "events");
  const events = existsSync5(eventsDir) ? await Promise.all(
    (await readdir3(eventsDir)).filter((n) => n.endsWith(".json")).sort().map(async (n) => JSON.parse(await readFile5(join6(eventsDir, n), "utf8")))
  ) : [];
  return replayPersistedRun(workflowId, snapshot, events);
}
function buildCommitTrailers({ workflowId, planHash, taskId, round, reviewHash }) {
  return [
    `Opencode-Ship-Workflow: ${workflowId}`,
    `Opencode-Ship-Plan: ${planHash}`,
    `Opencode-Ship-Task: ${taskId}`,
    `Opencode-Ship-Review: ${reviewHash ?? "n/a"}`,
    `Opencode-Ship-Round: ${round}`
  ];
}

// src/workflow/final-review-store.js
import { readFile as readFile6 } from "node:fs/promises";
import { existsSync as existsSync6 } from "node:fs";
import { join as join7 } from "node:path";

// src/workflow/final-review.js
import { createHash as createHash6 } from "node:crypto";
function buildFinalReviewPackage(input) {
  for (const [k, v] of Object.entries(input)) {
    if (k === "tasks") continue;
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`buildFinalReviewPackage: ${k} must be a non-empty string`);
    }
  }
  if (!Array.isArray(input.tasks)) {
    throw new Error("buildFinalReviewPackage: tasks must be an array");
  }
  for (const t of input.tasks) {
    if (!t || typeof t !== "object") {
      throw new Error("buildFinalReviewPackage: each task entry must be an object");
    }
  }
  for (const t of input.tasks) {
    for (const k of ["taskId", "commitSha", "taskHash", "reviewHash"]) {
      if (typeof t[k] !== "string" || t[k].length === 0) {
        throw new Error(`buildFinalReviewPackage: task.${k} must be a non-empty string`);
      }
    }
  }
  const { tasks, ...header } = input;
  const sortedTasks = [...tasks].sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId === b.taskId ? 0 : 1);
  const packageHash = sha2562(canonicalJson({ ...header, tasks: sortedTasks }));
  return { ...header, tasks: sortedTasks, packageHash };
}
function hashFinalReviewPackage(pkg) {
  const { packageHash: _packageHash, ...payload } = pkg;
  return sha2562(canonicalJson(payload));
}
function hashAxisRecord(record2) {
  const { reviewHash: _reviewHash, ...payload } = record2;
  return sha2562(canonicalJson(payload));
}
function bindFinalReview(standards, spec) {
  if (standards.headSha !== spec.headSha) {
    return { ok: false, reason: `head-mismatch: standards=${standards.headSha} spec=${spec.headSha}` };
  }
  if (standards.mergeBaseSha !== spec.mergeBaseSha) {
    return { ok: false, reason: `merge-base-mismatch: standards=${standards.mergeBaseSha} spec=${spec.mergeBaseSha}` };
  }
  if (standards.packageHash !== spec.packageHash) {
    return { ok: false, reason: `package-mismatch: standards=${standards.packageHash} spec=${spec.packageHash}` };
  }
  if (standards.verdict !== "pass" || spec.verdict !== "pass") {
    return { ok: false, reason: `verdict: standards=${standards.verdict} spec=${spec.verdict}` };
  }
  const blocking = [...standards.findings ?? [], ...spec.findings ?? []].filter((f) => f.severity === "blocking");
  if (blocking.length > 0) {
    return { ok: false, reason: `blocking-findings: ${blocking.length}` };
  }
  return { ok: true, headSha: standards.headSha };
}
function sha2562(text) {
  return createHash6("sha256").update(text, "utf8").digest("hex");
}

// src/workflow/final-review-store.js
async function readFinalReviewEvidence(repoRoot, workflowId) {
  const commonDir = await resolveGitCommonDir(repoRoot);
  const root = join7(opencodeShipStateDir(commonDir), "runs", workflowId, "final-review");
  const paths = {
    package: join7(root, "package.json"),
    standards: join7(root, "standards", "review.json"),
    spec: join7(root, "spec", "review.json")
  };
  for (const [kind, path] of Object.entries(paths)) {
    if (!existsSync6(path)) throw new Error(`canonical final review ${kind} record is missing`);
  }
  const [pkg, standards, spec, runState] = await Promise.all([
    readJson(paths.package),
    readJson(paths.standards),
    readJson(paths.spec),
    readRunState(repoRoot, workflowId)
  ]);
  if (hashFinalReviewPackage(pkg) !== pkg.packageHash) {
    throw new Error("canonical final review package hash is invalid");
  }
  const [verification, ci] = await Promise.all([
    readGateReceipt(repoRoot, pkg.gateTaskId, "verification", pkg.verificationHash),
    readGateReceipt(repoRoot, pkg.gateTaskId, "ci", pkg.ciHash)
  ]);
  if (!verification || verification.headSha !== pkg.headSha || verification.exitCode !== 0) {
    throw new Error("canonical verification receipt does not match the final review package");
  }
  if (!ci || ci.headSha !== pkg.headSha || ci.checks?.some((check2) => check2.bucket !== "pass")) {
    throw new Error("canonical CI receipt does not match the final review package");
  }
  for (const [axis, record2] of [["standards", standards], ["spec", spec]]) {
    if (record2.axis !== axis || hashAxisRecord(record2) !== record2.reviewHash) {
      throw new Error(`canonical ${axis} review record hash is invalid`);
    }
    if (record2.packageHash !== pkg.packageHash || record2.headSha !== pkg.headSha || record2.mergeBaseSha !== pkg.mergeBaseSha) {
      throw new Error(`canonical ${axis} review does not match the final review package`);
    }
  }
  const binding = bindFinalReview(standards, spec);
  if (!binding.ok) throw new Error(`canonical final review is not passing: ${binding.reason}`);
  if (!runState || !["ready-pending", "ready", "merged", "done"].includes(runState.state)) {
    throw new Error(`workflow is not final-review complete (state=${runState?.state ?? "missing"})`);
  }
  const summary = runState.finalReview;
  if (summary?.packageHash !== pkg.packageHash || summary?.headSha !== pkg.headSha || summary?.mergeBaseSha !== pkg.mergeBaseSha || summary?.standards?.reviewHash !== standards.reviewHash || summary?.spec?.reviewHash !== spec.reviewHash) {
    throw new Error("workflow final-review summary does not match immutable review records");
  }
  return { package: pkg, standards, spec, verification, ci, runState };
}
async function readJson(path) {
  return JSON.parse(await readFile6(path, "utf8"));
}

// src/tools/delivery-ready.js
function createReadyTool(deps) {
  return async function ready(input) {
    const m = await readManifest(deps.repoRoot, input.taskId);
    if (!m) return { kind: "missing-manifest", taskId: input.taskId };
    if (m.prNumber === null) return { kind: "missing-pr" };
    const prHead = await deps.driver.refreshHead({
      repo: deps.repoSlug,
      number: m.prNumber
    });
    const required2 = deps.adapter?.ready?.requires ?? [
      "review",
      "local-verification",
      "remote-ci"
    ];
    const ciDriverAvailable = Boolean(deps.adapter?.ci?.driver);
    const checks = ciDriverAvailable ? await deps.driver.readChecks({
      repo: deps.repoSlug,
      number: m.prNumber,
      branch: m.branch,
      required: deps.adapter?.ci?.requiredChecks ?? []
    }) : [];
    let runState = null;
    let gateManifest = m;
    const suppliedWorkflowId = input.workflowId ? String(input.workflowId) : null;
    if (m.workflowId && suppliedWorkflowId && m.workflowId !== suppliedWorkflowId) {
      return { kind: "workflow-mismatch", expected: m.workflowId, received: suppliedWorkflowId };
    }
    const workflowId = m.workflowId ?? suppliedWorkflowId;
    if (m.schemaVersion >= 2 && !workflowId) {
      return { kind: "missing-workflow-link", taskId: m.taskId };
    }
    let finalEvidence = null;
    if (workflowId) {
      try {
        finalEvidence = await readFinalReviewEvidence(deps.repoRoot, workflowId);
      } catch (err) {
        return { kind: "invalid-final-review-evidence", workflowId, reason: String(err?.message ?? err) };
      }
      runState = finalEvidence.runState;
      gateManifest = {
        ...m,
        finalStandardsReview: finalEvidence.standards,
        finalSpecReview: finalEvidence.spec
      };
    }
    const result = checkGates({
      manifest: { ...gateManifest, adapter: deps.adapter },
      prHead,
      checks,
      requires: required2
    });
    if (!result.ok) {
      return gateFailureEnvelope(result);
    }
    await deps.driver.markReady({
      repo: deps.repoSlug,
      number: m.prNumber
    });
    const t = transition(m, "ready", { reason: "all gates fresh" });
    if (!t.ok) return { kind: "lifecycle", reason: t.reason };
    const next = {
      ...m,
      workflowId: workflowId ?? null,
      finalReviewPackageHash: finalEvidence?.package.packageHash ?? m.finalReviewPackageHash ?? null,
      finalStandardsReview: finalEvidence?.standards ?? m.finalStandardsReview ?? null,
      finalSpecReview: finalEvidence?.spec ?? m.finalSpecReview ?? null,
      lastPrHeadSha: prHead,
      state: t.to,
      transitionLog: [
        ...m.transitionLog,
        { from: t.from, to: t.to, at: t.at, reason: t.reason }
      ],
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const path = await writeManifest(deps.repoRoot, next);
    if (runState && workflowId) {
      await appendRunEvent(deps.repoRoot, workflowId, runState, {
        kind: RUN_EVENT_KINDS.READY,
        data: { headSha: prHead, taskId: input.taskId }
      });
    }
    return { contractVersion: 1, manifestPath: path, pr: m.prNumber, workflowId };
  };
}

// src/tools/delivery-merge.js
function createMergeTool(deps) {
  return async function merge2(input) {
    const m = await readManifest(deps.repoRoot, input.taskId);
    if (!m) return { kind: "missing-manifest", taskId: input.taskId };
    if (m.prNumber === null) return { kind: "missing-pr" };
    if (m.state !== "ready") {
      return { kind: "not-ready", state: m.state };
    }
    const pr = await deps.driver.readPullRequest({
      repo: deps.repoSlug,
      number: m.prNumber
    });
    if (pr.baseRefName !== m.baseBranch) {
      return { kind: "wrong-base", base: pr.baseRefName };
    }
    const freshGates = deps.adapter?.merge?.requireFreshGates !== false;
    let finalEvidence = null;
    if (m.workflowId) {
      try {
        finalEvidence = await readFinalReviewEvidence(deps.repoRoot, m.workflowId);
      } catch (err) {
        return { kind: "invalid-final-review-evidence", workflowId: m.workflowId, reason: String(err?.message ?? err) };
      }
    } else if (m.schemaVersion >= 2) {
      return { kind: "missing-workflow-link", taskId: m.taskId };
    }
    if (pr.headSha !== (m.lastPrHeadSha ?? pr.headSha)) {
      return {
        kind: "head-changed",
        headSha: pr.headSha,
        manifestSha: m.lastPrHeadSha ?? ""
      };
    }
    async function recordMerged(merged2, reason) {
      const t = transition(
        { ...m, lastPrHeadSha: merged2.headSha },
        "merged",
        { reason }
      );
      if (!t.ok) return { kind: "lifecycle", reason: t.reason };
      const next = {
        ...m,
        lastPrHeadSha: merged2.headSha,
        state: t.to,
        transitionLog: [
          ...m.transitionLog,
          { from: t.from, to: t.to, at: t.at, reason: t.reason }
        ],
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const path = await writeManifest(deps.repoRoot, next);
      if (finalEvidence && m.workflowId) {
        await appendRunEvent(deps.repoRoot, m.workflowId, finalEvidence.runState, {
          kind: RUN_EVENT_KINDS.MERGE,
          data: { mergeSha: merged2.mergeSha ?? merged2.mergeCommitSha ?? merged2.headSha }
        });
      }
      return { kind: "merge", contractVersion: 1, manifestPath: path, pr: m.prNumber, taskId: m.taskId };
    }
    if (pr.merged) {
      return recordMerged(pr, `reconciled external merge as ${input.subject}`);
    }
    if (freshGates) {
      const required2 = deps.adapter?.ready?.requires ?? [
        "review",
        "local-verification",
        "remote-ci"
      ];
      const ciDriverAvailable = Boolean(deps.adapter?.ci?.driver);
      const checks = ciDriverAvailable ? await deps.driver.readChecks({
        repo: deps.repoSlug,
        number: m.prNumber,
        branch: m.branch,
        required: deps.adapter?.ci?.requiredChecks ?? []
      }) : [];
      const result = checkGates({
        manifest: {
          ...m,
          finalStandardsReview: finalEvidence?.standards ?? m.finalStandardsReview,
          finalSpecReview: finalEvidence?.spec ?? m.finalSpecReview,
          adapter: deps.adapter
        },
        prHead: pr.headSha,
        checks,
        requires: required2
      });
      if (!result.ok) return gateFailureEnvelope(result);
    }
    if (pr.draft) return { kind: "not-mergeable", reason: "PR is still draft" };
    if (pr.mergeable !== "MERGEABLE") {
      return { kind: "not-mergeable", reason: `mergeable=${pr.mergeable}` };
    }
    const merged = await deps.driver.mergePullRequest({
      repo: deps.repoSlug,
      number: m.prNumber,
      subject: input.subject
    });
    return recordMerged(merged, `squash merged as ${input.subject}`);
  };
}

// src/tools/delivery-cleanup.js
import { resolve as resolve8 } from "node:path";
import { spawnSync as spawnSync3 } from "node:child_process";
function safeRemoveWorktree(repoRoot, path) {
  const r = spawnSync3("git", ["worktree", "remove", path], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}
function casDeleteBranch(repoRoot, branch, expectedSha) {
  const args = ["update-ref", "-d"];
  if (expectedSha && /^[0-9a-f]{7,}$/i.test(expectedSha)) {
    args.push(`refs/heads/${branch}`, expectedSha);
  } else {
    args.push(`refs/heads/${branch}`);
  }
  const r = spawnSync3("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}
function branchStillExists(repoRoot, branch) {
  const r = spawnSync3(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env }
  );
  return r.status === 0;
}
function remoteBranchGone(repoRoot, branch, remote) {
  const r = spawnSync3("git", ["ls-remote", "--heads", remote, branch], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
  return r.status === 0 && !r.stdout.includes(`refs/heads/${branch}`);
}
function aheadOfRemote(repoRoot, branch, remote) {
  const r = spawnSync3(
    "git",
    ["rev-list", "--count", `${remote}/${branch}..${branch}`],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env }
  );
  if (r.status !== 0) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}
function createCleanupTool(deps) {
  return async function cleanup(input) {
    const m = await readManifest(deps.repoRoot, input.taskId);
    if (!m) return { kind: "missing-manifest", taskId: input.taskId };
    if (m.state !== "merged" && m.state !== "cleanup-pending") {
      return { kind: "manifest-state", state: m.state };
    }
    if (!m.worktreePath) return { kind: "missing-worktree-path" };
    const wtPath = resolve8(m.worktreePath);
    const mainCwd = resolve8(deps.repoRoot);
    if (wtPath === mainCwd) return { kind: "current-checkout", worktreePath: wtPath };
    if (!isWorktreeClean(wtPath)) return { kind: "dirty-worktree" };
    if (isRebaseInProgress(wtPath)) return { kind: "rebase-in-progress" };
    const head = currentHead(wtPath);
    if (!head || m.lastPrHeadSha && head !== m.lastPrHeadSha) {
      return {
        kind: "head-mismatch",
        headSha: head ?? "",
        manifestSha: m.lastPrHeadSha ?? ""
      };
    }
    const isBootstrapRecovery = m.state === "cleanup-pending" && m.prNumber === null;
    let workflowRun = null;
    if (!isBootstrapRecovery && m.schemaVersion >= 2) {
      if (!m.workflowId) return { kind: "missing-workflow-link", taskId: m.taskId };
      workflowRun = await readRunState(deps.repoRoot, m.workflowId);
      if (!workflowRun || workflowRun.state !== "merged") {
        return { kind: "workflow-not-merged", workflowId: m.workflowId, state: workflowRun?.state ?? null };
      }
    }
    if (!isBootstrapRecovery && m.prNumber === null) {
      return { kind: "missing-pr" };
    }
    let prHeadSha = head;
    let prMerged = true;
    if (!isBootstrapRecovery) {
      const pr = await deps.driver.readPullRequest({
        repo: deps.repoSlug,
        number: m.prNumber
      });
      if (!pr.merged) {
        return {
          kind: "unmerged",
          headSha: pr.headSha,
          manifestSha: m.lastPrHeadSha ?? ""
        };
      }
      if (pr.baseRefName !== m.baseBranch) {
        return { kind: "base-mismatch", manifestBase: m.baseBranch, prBase: pr.baseRefName };
      }
      prHeadSha = pr.headSha;
      prMerged = pr.merged;
    }
    if (!isBootstrapRecovery && prHeadSha && prHeadSha !== head) {
      return {
        kind: "head-mismatch",
        headSha: head,
        manifestSha: prHeadSha
      };
    }
    const remote = deps.remote ?? "origin";
    const remoteGone = isBootstrapRecovery ? true : remoteBranchGone(wtPath, m.branch, remote);
    const ahead = remoteGone ? null : aheadOfRemote(wtPath, m.branch, remote);
    if (!remoteGone && ahead !== null && ahead > 0) {
      return {
        kind: "has-unpublished-commits",
        ahead,
        branch: m.branch,
        remote
      };
    }
    const removed = safeRemoveWorktree(deps.repoRoot, wtPath);
    if (removed.status !== 0) {
      return { kind: "remove-failed", stderr: removed.stderr };
    }
    const expectedSha = m.lastPrHeadSha ?? head ?? null;
    const branchResult = casDeleteBranch(deps.repoRoot, m.branch, expectedSha);
    if (branchResult.status !== 0 && branchStillExists(deps.repoRoot, m.branch)) {
      return { kind: "branch-delete-failed", stderr: branchResult.stderr };
    }
    if (workflowRun && m.workflowId) {
      await appendRunEvent(deps.repoRoot, m.workflowId, workflowRun, {
        kind: RUN_EVENT_KINDS.DONE,
        data: { taskId: m.taskId }
      });
    }
    const tCleanup = transition(m, "cleanup-pending", { reason: "worktree removed" });
    const candidate = tCleanup.ok ? {
      ...m,
      state: tCleanup.to,
      transitionLog: [
        ...m.transitionLog,
        { from: tCleanup.from, to: tCleanup.to, at: tCleanup.at, reason: tCleanup.reason }
      ],
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    } : m;
    const tCleaned = transition(candidate, "cleaned", { reason: "manifest sealed" });
    if (tCleaned.ok) {
      const sealed = {
        ...candidate,
        state: tCleaned.to,
        transitionLog: [
          ...candidate.transitionLog,
          { from: tCleaned.from, to: tCleaned.to, at: tCleaned.at, reason: tCleaned.reason }
        ],
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await writeManifest(deps.repoRoot, sealed);
      await deleteManifest(deps.repoRoot, input.taskId);
    }
    return {
      contractVersion: 1,
      manifestPath: null,
      removedPath: wtPath,
      bootstrapRecovery: isBootstrapRecovery
    };
  };
}

// src/tools/envelope.js
import { randomBytes as randomBytes2 } from "node:crypto";
var CONTRACT_VERSION = 2;
function operationId(prefix = "op") {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes2(4).toString("hex")}`;
}
function success2(kind, data, options = {}) {
  if (typeof kind !== "string" || kind.length === 0) {
    throw new Error("envelope.success: kind must be a non-empty string");
  }
  return {
    contractVersion: CONTRACT_VERSION,
    ok: true,
    kind,
    operationId: options.operationId ?? operationId(kind),
    idempotent: options.idempotent !== false,
    data
  };
}
function failure(kind, message, options = {}) {
  if (typeof kind !== "string" || kind.length === 0) {
    throw new Error("envelope.failure: kind must be a non-empty string");
  }
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("envelope.failure: message must be a non-empty string");
  }
  const details = options.details ?? {};
  return {
    contractVersion: CONTRACT_VERSION,
    ok: false,
    kind,
    operationId: options.operationId ?? operationId(`${kind}-err`),
    retryable: options.retryable === true,
    message,
    details
  };
}

// src/state/github-operation-store.js
import { readFile as readFile7, writeFile as writeFile4, mkdir as mkdir5, readdir as readdir4, unlink as unlink3 } from "node:fs/promises";
import { existsSync as existsSync7 } from "node:fs";
import { join as join8, dirname as dirname3 } from "node:path";
init_durable_store();
async function operationsDir(repoRoot) {
  const common = await resolveGitCommonDir(repoRoot);
  return join8(opencodeShipStateDir(common), "github", "operations");
}
var SAFE_ID_RE2 = /^[A-Za-z0-9._-]{1,128}$/;
function operationPath(dir, operationId2) {
  if (!SAFE_ID_RE2.test(operationId2)) {
    throw new Error(`invalid operationId: ${JSON.stringify(operationId2)}`);
  }
  return join8(dir, `${operationId2}.json`);
}
async function hasOperation(repoRoot, operationId2) {
  const dir = await operationsDir(repoRoot);
  return existsSync7(operationPath(dir, operationId2));
}
async function recordOperation(repoRoot, operationId2, record2) {
  if (typeof operationId2 !== "string" || operationId2.length === 0) {
    throw new Error("recordOperation: operationId must be a non-empty string");
  }
  if (!record2 || typeof record2 !== "object") {
    throw new Error("recordOperation: record must be an object");
  }
  const dir = await operationsDir(repoRoot);
  await mkdir5(dir, { recursive: true });
  const path = operationPath(dir, operationId2);
  if (existsSync7(path)) {
    return { recorded: false, path };
  }
  const fullRecord = {
    operationId: operationId2,
    kind: record2.kind,
    ok: record2.ok,
    payload: record2.payload ?? null,
    recordedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await publishImmutableJson(path, fullRecord);
  return { recorded: true, path };
}

// src/tools/delivery-github-read.js
function createGithubReadTool(deps) {
  return async function githubRead(input) {
    const opId = input.operationId ?? `gh-read-${Date.now().toString(36)}`;
    const resource = String(input.resource ?? "");
    const repo = deps.repoSlug;
    const number4 = Number(input.number);
    if (!repo) return failure("github-read", "repo slug missing", { operationId: opId, retryable: false });
    if (!["issue", "pr", "checks"].includes(resource)) {
      return failure("github-read", `unknown resource: ${resource}`, { operationId: opId, retryable: false });
    }
    if (resource !== "checks" && (!Number.isInteger(number4) || number4 <= 0)) {
      return failure("github-read", "issue/PR number required", { operationId: opId, retryable: false });
    }
    if (await hasOperation(deps.repoRoot, opId)) {
      const prior = await deps.operationStore.readOperation(deps.repoRoot, opId).catch(() => null);
      if (prior && prior.ok) return success2("github-read", prior.payload, { operationId: opId, idempotent: true });
    }
    let argv;
    if (resource === "issue") {
      argv = ["gh", "issue", "view", String(number4), "--repo", repo, "--json", "number,title,state,body,url"];
    } else if (resource === "pr") {
      argv = ["gh", "pr", "view", String(number4), "--repo", repo, "--json", "number,url,state,headRefOid,isDraft"];
    } else {
      const sha = input.sha ? String(input.sha) : null;
      if (!sha) return failure("github-read", "sha required for checks", { operationId: opId, retryable: false });
      argv = ["gh", "pr", "checks", String(number4), "--repo", repo, "--json", "name,state,conclusion"];
    }
    const policy = validateGhArgv(argv);
    if (!policy.ok) return failure("github-read", policy.reason, { operationId: opId, retryable: false });
    try {
      const result = await deps.driver.runCommand(argv);
      if (result.status !== 0) {
        return failure("github-read", `exit ${result.status}: ${result.stderr}`, { operationId: opId, retryable: false });
      }
      const payload = JSON.parse(result.stdout || "{}");
      await recordOperation(deps.repoRoot, opId, { kind: "github-read", ok: true, payload });
      return success2("github-read", { resource, number: number4, payload }, { operationId: opId });
    } catch (err) {
      return failure("github-read", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/tools/delivery-issue-comment.js
function createIssueCommentTool(deps) {
  return async function issueComment(input) {
    const opId = input.operationId ?? `issue-comment-${Date.now().toString(36)}`;
    const number4 = Number(input.number);
    const body = String(input.body ?? "");
    if (!Number.isInteger(number4) || number4 <= 0) {
      return failure("issue-comment", "issue number required", { operationId: opId, retryable: false });
    }
    if (body.length === 0) {
      return failure("issue-comment", "comment body required", { operationId: opId, retryable: false });
    }
    if (await hasOperation(deps.repoRoot, opId)) {
      return success2("issue-comment", { number: number4, idempotent: true }, { operationId: opId, idempotent: true });
    }
    const argv = ["gh", "issue", "comment", String(number4), "--repo", deps.repoSlug, "--body", body];
    const policy = validateGhArgv(argv);
    if (!policy.ok) return failure("issue-comment", policy.reason, { operationId: opId, retryable: false });
    try {
      const result = await deps.driver.runCommand(argv);
      if (result.status !== 0) {
        return failure("issue-comment", `exit ${result.status}: ${result.stderr}`, { operationId: opId, retryable: false });
      }
      await recordOperation(deps.repoRoot, opId, { kind: "issue-comment", ok: true, payload: { number: number4 } });
      return success2("issue-comment", { number: number4 }, { operationId: opId });
    } catch (err) {
      return failure("issue-comment", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/tools/delivery-issue-labels.js
function createIssueLabelsTool(deps) {
  return async function issueLabels(input) {
    const opId = input.operationId ?? `issue-labels-${Date.now().toString(36)}`;
    const number4 = Number(input.number);
    const add = Array.isArray(input.add) ? input.add : [];
    const remove = Array.isArray(input.remove) ? input.remove : [];
    if (!Number.isInteger(number4) || number4 <= 0) {
      return failure("issue-labels", "issue number required", { operationId: opId, retryable: false });
    }
    if (add.length === 0 && remove.length === 0) {
      return failure("issue-labels", "add or remove list required", { operationId: opId, retryable: false });
    }
    if (await hasOperation(deps.repoRoot, opId)) {
      return success2("issue-labels", { number: number4, idempotent: true }, { operationId: opId, idempotent: true });
    }
    const attempted = [];
    for (const label of add) {
      const argv = ["gh", "issue", "edit", String(number4), "--repo", deps.repoSlug, "--add-label", label];
      const policy = validateGhArgv(argv);
      if (!policy.ok) return failure("issue-labels", policy.reason, { operationId: opId, retryable: false });
      attempted.push({ action: "add", label });
    }
    for (const label of remove) {
      const argv = ["gh", "issue", "edit", String(number4), "--repo", deps.repoSlug, "--remove-label", label];
      const policy = validateGhArgv(argv);
      if (!policy.ok) return failure("issue-labels", policy.reason, { operationId: opId, retryable: false });
      attempted.push({ action: "remove", label });
    }
    try {
      for (const { action, label } of attempted) {
        const flag = action === "add" ? "--add-label" : "--remove-label";
        const result = await deps.driver.runCommand(["gh", "issue", "edit", String(number4), "--repo", deps.repoSlug, flag, label]);
        if (result.status !== 0) {
          return failure("issue-labels", `${action} ${label} failed: ${result.stderr}`, { operationId: opId, retryable: false });
        }
      }
      await recordOperation(deps.repoRoot, opId, { kind: "issue-labels", ok: true, payload: { number: number4, add, remove } });
      return success2("issue-labels", { number: number4, add, remove }, { operationId: opId });
    } catch (err) {
      return failure("issue-labels", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/tools/delivery-issue-link.js
var RELATIONSHIPS = /* @__PURE__ */ new Set(["blocks", "is-blocked-by", "closes", "is-closed-by", "related"]);
function createIssueLinkTool(deps) {
  return async function issueLink(input) {
    const opId = input.operationId ?? `issue-link-${Date.now().toString(36)}`;
    const from = Number(input.from);
    const to = Number(input.to);
    const relationship = String(input.relationship ?? "");
    if (!Number.isInteger(from) || from <= 0) return failure("issue-link", "from number required", { operationId: opId, retryable: false });
    if (!Number.isInteger(to) || to <= 0) return failure("issue-link", "to number required", { operationId: opId, retryable: false });
    if (!RELATIONSHIPS.has(relationship)) return failure("issue-link", `unknown relationship: ${relationship}`, { operationId: opId, retryable: false });
    if (await hasOperation(deps.repoRoot, opId)) {
      return success2("issue-link", { from, to, relationship, idempotent: true }, { operationId: opId, idempotent: true });
    }
    const body = `<!-- opencode-ship-link:${relationship} from=${from} to=${to} -->`;
    const argv = ["gh", "issue", "comment", String(from), "--repo", deps.repoSlug, "--body", body];
    const policy = validateGhArgv(argv);
    if (!policy.ok) return failure("issue-link", policy.reason, { operationId: opId, retryable: false });
    try {
      const result = await deps.driver.runCommand(argv);
      if (result.status !== 0) {
        return failure("issue-link", `exit ${result.status}: ${result.stderr}`, { operationId: opId, retryable: false });
      }
      await recordOperation(deps.repoRoot, opId, { kind: "issue-link", ok: true, payload: { from, to, relationship } });
      return success2("issue-link", { from, to, relationship }, { operationId: opId });
    } catch (err) {
      return failure("issue-link", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/tools/delivery-issue-close.js
function createIssueCloseTool(deps) {
  return async function issueClose(input) {
    const opId = input.operationId ?? `issue-close-${Date.now().toString(36)}`;
    const number4 = Number(input.number);
    const subject = String(input.subject ?? "");
    if (!Number.isInteger(number4) || number4 <= 0) {
      return failure("issue-close", "issue number required", { operationId: opId, retryable: false });
    }
    if (subject.length === 0) {
      return failure("issue-close", "user permission subject required", { operationId: opId, retryable: false });
    }
    if (await hasOperation(deps.repoRoot, opId)) {
      return success2("issue-close", { number: number4, idempotent: true }, { operationId: opId, idempotent: true });
    }
    const argv = ["gh", "issue", "close", String(number4), "--repo", deps.repoSlug, "--comment", `closed via Ship (subject=${subject})`];
    const policy = validateGhArgv(argv);
    if (!policy.ok) return failure("issue-close", policy.reason, { operationId: opId, retryable: false });
    try {
      const result = await deps.driver.runCommand(argv);
      if (result.status !== 0) {
        return failure("issue-close", `exit ${result.status}: ${result.stderr}`, { operationId: opId, retryable: false });
      }
      await recordOperation(deps.repoRoot, opId, { kind: "issue-close", ok: true, payload: { number: number4, subject } });
      return success2("issue-close", { number: number4, subject }, { operationId: opId });
    } catch (err) {
      return failure("issue-close", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/tools/delivery-sync.js
function createSyncTool(deps) {
  return async function sync(input) {
    const opId = input.operationId ?? `sync-${Date.now().toString(36)}`;
    const base = String(input.base ?? "");
    const branch = String(input.branch ?? "");
    if (!base || !branch) {
      return failure("sync", "base and branch required", { operationId: opId, retryable: false });
    }
    if (await hasOperation(deps.repoRoot, opId)) {
      return success2("sync", { base, branch, idempotent: true }, { operationId: opId, idempotent: true });
    }
    const argv = ["gh", "pr", "view", "--repo", deps.repoSlug, "--json", "headRefName,baseRefName"];
    const policy = validateGhArgv(argv);
    if (!policy.ok) return failure("sync", policy.reason, { operationId: opId, retryable: false });
    try {
      const fetchResult = await deps.driver.runCommand(["git", "fetch", "origin", base]);
      if (fetchResult.status !== 0) {
        return failure("sync", `fetch failed: ${fetchResult.stderr}`, { operationId: opId, retryable: true });
      }
      const mergeResult = await deps.driver.runCommand(["git", "merge", "--no-ff", `origin/${base}`]);
      if (mergeResult.status !== 0) {
        return failure("sync", `merge failed: ${mergeResult.stderr}`, { operationId: opId, retryable: true });
      }
      const head = await deps.driver.runCommand(["git", "rev-parse", "HEAD"]);
      const headSha = head.stdout.trim();
      await recordOperation(deps.repoRoot, opId, { kind: "sync", ok: true, payload: { base, branch, headSha } });
      return success2("sync", { base, branch, headSha }, { operationId: opId });
    } catch (err) {
      return failure("sync", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/tools/delivery-publish.js
var FORBIDDEN_FLAGS2 = /* @__PURE__ */ new Set(["--force", "-f", "--force-with-lease"]);
function createPublishTool(deps) {
  return async function publish(input) {
    const opId = input.operationId ?? `publish-${Date.now().toString(36)}`;
    const taskId = String(input.taskId ?? "");
    const expectedHead = String(input.expectedHead ?? "");
    if (!taskId) return failure("publish", "taskId required", { operationId: opId, retryable: false });
    if (!expectedHead) return failure("publish", "expectedHead required", { operationId: opId, retryable: false });
    if (await hasOperation(deps.repoRoot, opId)) {
      return success2("publish", { taskId, idempotent: true }, { operationId: opId, idempotent: true });
    }
    const manifest = await readManifest(deps.repoRoot, taskId);
    if (!manifest) return failure("publish", "no manifest for taskId", { operationId: opId, retryable: false });
    const branch = manifest.branch;
    if (!branch) return failure("publish", "manifest has no branch", { operationId: opId, retryable: false });
    const argv = ["git", "push", "origin", `HEAD:refs/heads/${branch}`];
    for (const arg of argv.slice(1)) {
      if (FORBIDDEN_FLAGS2.has(arg)) {
        return failure("publish", `forbidden push flag: ${arg}`, { operationId: opId, retryable: false });
      }
    }
    try {
      const head = await deps.driver.runCommand(["git", "rev-parse", "HEAD"]);
      const currentHead2 = head.stdout.trim();
      if (currentHead2 !== expectedHead) {
        return failure("publish", `HEAD drift (expected ${expectedHead.slice(0, 8)}, got ${currentHead2.slice(0, 8)})`, { operationId: opId, retryable: false });
      }
      const result = await deps.driver.runCommand(argv);
      if (result.status !== 0) {
        return failure("publish", `push failed: ${result.stderr}`, { operationId: opId, retryable: false });
      }
      await recordOperation(deps.repoRoot, opId, { kind: "publish", ok: true, payload: { taskId, branch, headSha: currentHead2 } });
      return success2("publish", { taskId, branch, headSha: currentHead2 }, { operationId: opId });
    } catch (err) {
      return failure("publish", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/profile.js
var PROFILES = Object.freeze(["engineering"]);
var LEGACY_PROFILES = Object.freeze(["core"]);

// src/installer/engineering-config.js
var MODEL_ID_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
var DEFAULTS = Object.freeze({
  planner: "openai/gpt-5.6-sol",
  builder: "minimax/MiniMax-M3",
  finalReviewer: "openai/gpt-5.6-sol"
});
function resolveModelRoles(cfg, { strict = false, allowDeferred = false } = {}) {
  const REQUIRED = ["planner", "builder", "finalReviewer"];
  if (strict) {
    const issues = [];
    for (const role of REQUIRED) {
      const id = cfg?.models?.[role];
      if (typeof id !== "string" || id.length === 0 || !MODEL_ID_RE.test(id)) {
        issues.push(role);
      }
    }
    if (issues.length > 0) {
      throw new Error(`resolveModelRoles: required role(s) missing or invalid: ${issues.join(", ")}`);
    }
    return { planner: cfg.models.planner, builder: cfg.models.builder, finalReviewer: cfg.models.finalReviewer };
  }
  const out = { ...DEFAULTS };
  if (cfg && cfg.models) {
    for (const [role, id] of Object.entries(cfg.models)) {
      if (id && typeof id === "string" && id.length > 0) {
        out[role] = id;
      } else if (strict && Object.prototype.hasOwnProperty.call(cfg.models, role)) {
        throw new Error(`resolveModelRoles: user provided empty model id for '${role}'`);
      }
    }
  }
  if (allowDeferred) {
    return { planner: out.planner ?? null, builder: out.builder ?? null, finalReviewer: out.finalReviewer ?? null };
  }
  for (const role of REQUIRED) {
    if (!out[role]) {
      throw new Error(`resolveModelRoles: required role '${role}' missing and no default available`);
    }
  }
  return out;
}

// src/installer/lock.js
import { readFile as readFile8, writeFile as writeFile5, rename as rename3, mkdir as mkdir6 } from "node:fs/promises";
import { existsSync as existsSync8 } from "node:fs";
import { dirname as dirname4, resolve as resolve9, posix } from "node:path";

// src/installer/hash.js
import { createHash as createHash7 } from "node:crypto";
function bytesHash(buffer) {
  return createHash7("sha256").update(buffer).digest("hex");
}
function bytesHashString(text) {
  return bytesHash(Buffer.from(text, "utf8"));
}

// src/installer/lock.js
function lockPath(repoRoot) {
  return resolve9(repoRoot, ".opencode", "ship.lock.json");
}
async function readLock2(repoRoot) {
  const path = lockPath(repoRoot);
  if (!existsSync8(path)) return null;
  try {
    const raw = await readFile8(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function isSetupComplete(lock) {
  if (!lock || typeof lock !== "object") return false;
  const manager = lock.manager;
  if (!manager || typeof manager !== "object") return false;
  return manager.setupComplete === true;
}

// src/tools/ship-plan-start.js
import { join as join10 } from "node:path";
import { mkdir as mkdir8, writeFile as writeFile6 } from "node:fs/promises";

// src/runtime/opencode-dispatcher.js
import { mkdir as mkdir7 } from "node:fs/promises";
import { join as join9 } from "node:path";
init_durable_store();
import { createHash as createHash8 } from "node:crypto";
import { dirname as dirnameOf } from "node:path";
var ROLE_PLANNER = "planner";
var ROLE_BUILDER = "builder";
var ROLE_TASK_REVIEWER = "task-reviewer";
var ROLE_FINAL_STANDARDS = "final-standards";
var ROLE_FINAL_SPEC = "final-spec";
var ROLE_KEYS = /* @__PURE__ */ new Set([ROLE_PLANNER, ROLE_BUILDER, ROLE_TASK_REVIEWER, ROLE_FINAL_STANDARDS, ROLE_FINAL_SPEC]);
function dispatchKeyFor(role, input) {
  switch (role) {
    case ROLE_PLANNER:
      return `planner:${input.revision}`;
    case ROLE_BUILDER:
      return `builder:${input.taskId}:${input.round}`;
    case ROLE_TASK_REVIEWER:
      return `task-reviewer:${input.taskId}:${input.round}`;
    case ROLE_FINAL_STANDARDS:
      return `final-reviewer:${input.packageHash}:standards`;
    case ROLE_FINAL_SPEC:
      return `final-reviewer:${input.packageHash}:spec`;
    default:
      throw new Error(`dispatchKeyFor: unknown role ${role}`);
  }
}
function dispatchDir(commonDir, workflowId, dispatchKey) {
  return join9(opencodeShipStateDir(commonDir), "runs", workflowId, "dispatch", dispatchKey);
}
async function dispatchPath(commonDir, workflowId, dispatchKey) {
  return join9(dispatchDir(commonDir, workflowId, dispatchKey), "dispatch.json");
}
function hashPayload(value) {
  return createHash8("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
async function prepareDispatch(repoRoot, workflowId, role, keyInput, payload) {
  if (!ROLE_KEYS.has(role)) {
    throw new Error(`prepareDispatch: unknown role ${role}`);
  }
  const common = await resolveGitCommonDir(repoRoot);
  const dispatchKey = dispatchKeyFor(role, keyInput);
  const commonDir = opencodeShipStateDir(common);
  const dir = dispatchDir(common, workflowId, dispatchKey);
  await mkdir7(dir, { recursive: true });
  const path = await dispatchPath(common, workflowId, dispatchKey);
  const record2 = {
    workflowId,
    dispatchKey,
    role,
    keyInput,
    payloadHash: hashPayload(payload),
    state: "prepared",
    preparedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await publishImmutableJson(path, record2);
  return { dispatchKey, dispatchPath: path, state: "prepared" };
}
async function transitionDispatch(repoRoot, workflowId, dispatchKey, nextState, fields = {}) {
  const common = await resolveGitCommonDir(repoRoot);
  const baseDir = join9(opencodeShipStateDir(common), "runs", workflowId, "dispatch", dispatchKey);
  await mkdir7(baseDir, { recursive: true });
  const next = Number(fields.sequence ?? 0);
  const path = join9(baseDir, `seq-${String(next).padStart(6, "0")}.json`);
  const record2 = {
    workflowId,
    dispatchKey,
    state: nextState,
    ...fields,
    recordedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await publishImmutableJson(path, record2);
  return record2;
}
async function readLatestDispatch(repoRoot, workflowId, dispatchKey) {
  const { readdir: readdir10, readFile: readFile25 } = await import("node:fs/promises");
  const common = await resolveGitCommonDir(repoRoot);
  const baseDir = join9(opencodeShipStateDir(common), "runs", workflowId, "dispatch", dispatchKey);
  const { readdirSync: readdirSync2, statSync: statSync2 } = await import("node:fs");
  if (!statSync2(baseDir, { throwIfNoEntry: false })) return null;
  const files = readdirSync2(baseDir).filter((f) => f.startsWith("seq-")).sort();
  if (files.length === 0) {
    const initial = join9(baseDir, "dispatch.json");
    if (!statSync2(initial, { throwIfNoEntry: false })) return null;
    return JSON.parse(await readFile25(initial, "utf8"));
  }
  const last = files[files.length - 1];
  const raw = await readFile25(join9(baseDir, last), "utf8");
  return JSON.parse(raw);
}
async function readPreparedDispatch(repoRoot, workflowId, dispatchKey) {
  const { readFile: readFile25 } = await import("node:fs/promises");
  const common = await resolveGitCommonDir(repoRoot);
  const path = join9(opencodeShipStateDir(common), "runs", workflowId, "dispatch", dispatchKey, "dispatch.json");
  try {
    return JSON.parse(await readFile25(path, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}
async function dispatchWorker(input) {
  const { repoRoot, workflowId, role, keyInput, payload, client, parentSessionID, titleMarker, agent, model } = input;
  if (!ROLE_KEYS.has(role)) {
    throw new Error(`dispatchWorker: unknown role ${role}`);
  }
  if (!client || typeof client.session?.create !== "function" || typeof client.session?.promptAsync !== "function") {
    throw new Error("dispatchWorker: client.session.create and client.session.promptAsync are required");
  }
  if (!parentSessionID || typeof parentSessionID !== "string") {
    throw new Error("dispatchWorker: parentSessionID required");
  }
  await assertControllerLease(repoRoot, workflowId, parentSessionID);
  const dispatchKey = dispatchKeyFor(role, keyInput);
  const common = await resolveGitCommonDir(repoRoot);
  const stateDir = opencodeShipStateDir(common);
  const preparedPayload = { ...payload, agent: agent ?? null, model: model ?? null };
  return withResourceLock(stateDir, `dispatch:${workflowId}:${dispatchKey}`, async () => {
    let latest = await readLatestDispatch(repoRoot, workflowId, dispatchKey);
    const preparedRecord = await readPreparedDispatch(repoRoot, workflowId, dispatchKey);
    if (preparedRecord && preparedRecord.payloadHash !== hashPayload(preparedPayload)) {
      throw new Error(`dispatchWorker: payload changed for existing dispatch ${dispatchKey}`);
    }
    if (latest?.state === "prompted" || latest?.state === "completed") {
      return { sessionID: latest.sessionID, dispatchKey };
    }
    if (!preparedRecord) {
      await prepareDispatch(repoRoot, workflowId, role, keyInput, preparedPayload);
      latest = { state: "prepared", sequence: 0 };
    }
    let sequence = Number(latest?.sequence ?? 0);
    const title = titleMarker ?? `ship-${role}-${dispatchKey}`;
    let sessionID = latest?.state === "created" ? latest.sessionID : null;
    if (!sessionID) {
      try {
        const created = await client.session.create({
          body: { parentID: parentSessionID, title },
          query: { directory: repoRoot }
        });
        if (created?.error) {
          throw new Error(`dispatchWorker: session.create failed: ${formatSdkError(created.error)}`);
        }
        const createdData = created?.data ?? created;
        sessionID = createdData?.id ?? createdData?.sessionID;
        if (!sessionID) {
          throw new Error(`dispatchWorker: client.session.create did not return a session id`);
        }
      } catch (err) {
        sequence += 1;
        await transitionDispatch(repoRoot, workflowId, dispatchKey, "failed", {
          sequence,
          lastError: `create: ${err?.message ?? err}`
        });
        throw err;
      }
      sequence += 1;
      await transitionDispatch(repoRoot, workflowId, dispatchKey, "created", {
        sequence,
        sessionID,
        controllerSessionID: parentSessionID
      });
    }
    try {
      const body = {
        parts: [{ type: "text", text: String(payload?.promptText ?? "") }]
      };
      if (agent) body.agent = agent;
      if (model) body.model = parseModelId(model);
      const prompted = await client.session.promptAsync({
        path: { id: sessionID },
        body,
        query: { directory: repoRoot }
      });
      if (prompted?.error) {
        throw new Error(`dispatchWorker: session.promptAsync failed: ${formatSdkError(prompted.error)}`);
      }
    } catch (err) {
      sequence += 1;
      await transitionDispatch(repoRoot, workflowId, dispatchKey, "failed", {
        sequence,
        sessionID,
        controllerSessionID: parentSessionID,
        lastError: `promptAsync: ${err?.message ?? err}`
      });
      throw err;
    }
    sequence += 1;
    await transitionDispatch(repoRoot, workflowId, dispatchKey, "prompted", {
      sequence,
      sessionID,
      controllerSessionID: parentSessionID
    });
    return { sessionID, dispatchKey };
  });
}
function parseModelId(value) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`dispatchWorker: model must be <provider>/<model>`);
  }
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}
function formatSdkError(error45) {
  if (typeof error45 === "string") return error45;
  if (error45 && typeof error45.message === "string") return error45.message;
  try {
    return JSON.stringify(error45);
  } catch {
    return String(error45);
  }
}
async function issueControllerLease(repoRoot, workflowId, controllerSessionID) {
  const { atomicReplaceJson: atomicReplaceJson2 } = await Promise.resolve().then(() => (init_durable_store(), durable_store_exports));
  const common = await resolveGitCommonDir(repoRoot);
  const path = join9(opencodeShipStateDir(common), "runs", workflowId, "controller.json");
  await mkdir7(dirnameOf(path), { recursive: true });
  await atomicReplaceJson2(path, {
    workflowId,
    controllerSessionID,
    issuedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
}
async function readControllerLease(repoRoot, workflowId) {
  const { readFile: readFile25 } = await import("node:fs/promises");
  const { existsSync: existsSync28 } = await import("node:fs");
  const common = await resolveGitCommonDir(repoRoot);
  const path = join9(opencodeShipStateDir(common), "runs", workflowId, "controller.json");
  if (!existsSync28(path)) return null;
  try {
    return JSON.parse(await readFile25(path, "utf8"));
  } catch {
    return null;
  }
}
async function authorizeControllerCall(repoRoot, workflowId, ctx) {
  const lease = await readControllerLease(repoRoot, workflowId);
  if (!lease) {
    return { ok: false, kind: "no-lease", message: "controller lease not issued; ship_plan_start must run first" };
  }
  if (!ctx || typeof ctx.sessionID !== "string") {
    return { ok: false, kind: "no-session", message: "ToolContext.sessionID required" };
  }
  if (ctx.sessionID !== lease.controllerSessionID) {
    return { ok: false, kind: "lease-mismatch", message: `ToolContext.sessionID (${ctx.sessionID.slice(0, 8)}) does not match controller lease (${lease.controllerSessionID.slice(0, 8)})` };
  }
  if (ctx.agent && ctx.agent !== "ship-controller") {
    return { ok: false, kind: "wrong-agent", message: `ToolContext.agent (${ctx.agent}) is not ship-controller` };
  }
  return { ok: true, sessionID: lease.controllerSessionID, message: "controller lease matched" };
}
async function authorizeChildCall(repoRoot, workflowId, role, keyInput, ctx) {
  if (!ROLE_KEYS.has(role)) {
    return { ok: false, kind: "unknown-role", message: `unknown role ${role}` };
  }
  const dispatchKey = dispatchKeyFor(role, keyInput);
  const latest = await readLatestDispatch(repoRoot, workflowId, dispatchKey);
  if (!latest) {
    return { ok: false, kind: "no-dispatch", message: `no dispatch record for ${role} ${dispatchKey}` };
  }
  if (!latest.sessionID) {
    return { ok: false, kind: "no-session", message: `dispatch ${dispatchKey} has no session id` };
  }
  if (!ctx || typeof ctx.sessionID !== "string") {
    return { ok: false, kind: "no-session", message: "ToolContext.sessionID required" };
  }
  if (ctx.sessionID !== latest.sessionID) {
    return { ok: false, kind: "session-mismatch", message: `ToolContext.sessionID (${ctx.sessionID.slice(0, 8)}) does not match dispatch session (${latest.sessionID.slice(0, 8)})` };
  }
  if (latest.state !== "created" && latest.state !== "prompted" && latest.state !== "completed") {
    return { ok: false, kind: "bad-state", message: `dispatch ${dispatchKey} is in state ${latest.state}` };
  }
  return { ok: true, sessionID: latest.sessionID, dispatchKey, message: "dispatch session matched" };
}
async function withControllerLease(repoRoot, workflowId, controllerSessionID, callback) {
  const common = await resolveGitCommonDir(repoRoot);
  const lockKey = `controller:${workflowId}`;
  return withResourceLock(opencodeShipStateDir(common), lockKey, async () => {
    await issueControllerLease(repoRoot, workflowId, controllerSessionID);
    return callback();
  });
}
async function assertControllerLease(repoRoot, workflowId, controllerSessionID) {
  const lease = await readControllerLease(repoRoot, workflowId);
  if (!lease) {
    throw new Error(`assertControllerLease: controller lease not issued for ${workflowId}; call ship_plan_start first`);
  }
  if (lease.controllerSessionID !== controllerSessionID) {
    throw new Error(`assertControllerLease: parent session (${controllerSessionID.slice(0, 8)}) does not hold the lease (${lease.controllerSessionID.slice(0, 8)})`);
  }
}
var ROLES = Object.freeze({
  PLANNER: ROLE_PLANNER,
  BUILDER: ROLE_BUILDER,
  TASK_REVIEWER: ROLE_TASK_REVIEWER,
  FINAL_STANDARDS: ROLE_FINAL_STANDARDS,
  FINAL_SPEC: ROLE_FINAL_SPEC
});

// src/tools/ship-plan-start.js
function normalizeWorkflowId(issueNumber) {
  return `wf-${issueNumber}`;
}
function createPlanStartTool(deps) {
  return async function planStart(input) {
    const opId = input.operationId ?? `plan-start-${Date.now().toString(36)}`;
    const issueNumber = Number(input.issueNumber);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return failure("plan-start", "issueNumber required", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    if (!ctx || typeof ctx.sessionID !== "string" || ctx.agent !== "ship-controller") {
      return failure("plan-start", "ToolContext.sessionID required (controller session)", { operationId: opId, retryable: false });
    }
    const lock = await readLock2(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("plan-start", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let models;
    try {
      models = resolveModelRoles(deps.config?.workflow, { strict: true });
    } catch (err) {
      return failure("plan-start", `model roles unresolved: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    const workflowId = normalizeWorkflowId(issueNumber);
    const repoRoot = deps.repoRoot;
    try {
      const commonDir = await resolveGitCommonDir(repoRoot);
      const wfDir = join10(opencodeShipStateDir(commonDir), "plans", workflowId);
      await mkdir8(wfDir, { recursive: true });
      await issueControllerLease(repoRoot, workflowId, ctx.sessionID);
      const matchingManifests = (await listManifests(repoRoot)).filter((manifest) => manifest.issueNumber === issueNumber);
      if (matchingManifests.length > 1) {
        throw new Error(`multiple delivery manifests are linked to issue #${issueNumber}`);
      }
      if (matchingManifests.length === 1) {
        const manifest = matchingManifests[0];
        if (manifest.workflowId && manifest.workflowId !== workflowId) {
          throw new Error(`delivery manifest ${manifest.taskId} is already linked to ${manifest.workflowId}`);
        }
        await writeManifest(repoRoot, { ...manifest, workflowId, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
      }
      const client = deps.opencodeClient;
      let dispatchResult = null;
      if (client) {
        dispatchResult = await dispatchWorker({
          repoRoot,
          workflowId,
          role: ROLES.PLANNER,
          keyInput: { revision: 1 },
          payload: { promptText: `Plan issue #${issueNumber}` },
          client,
          parentSessionID: ctx.sessionID,
          titleMarker: `ship-planner-${workflowId}`,
          agent: "ship-planner",
          model: models.planner
        });
      }
      const indexRecord = {
        workflowId,
        issueNumber,
        owner: deps.owner,
        planner: models.planner,
        builder: models.builder,
        finalReviewer: models.finalReviewer,
        controllerSessionID: ctx.sessionID,
        plannerSessionID: dispatchResult?.sessionID ?? null,
        dispatchKey: dispatchResult?.dispatchKey ?? null,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        state: "drafting"
      };
      await writeFile6(join10(wfDir, "index.json"), JSON.stringify(indexRecord, null, 2), "utf8");
      return success2("plan-start", {
        workflowId,
        issueNumber,
        controllerSessionID: ctx.sessionID,
        plannerSessionID: indexRecord.plannerSessionID,
        dispatchKey: indexRecord.dispatchKey,
        models: {
          planner: models.planner,
          builder: models.builder,
          finalReviewer: models.finalReviewer
        }
      }, { operationId: opId });
    } catch (err) {
      return failure("plan-start", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/workflow/plan.js
import { createHash as createHash9 } from "node:crypto";
function isPlainObject2(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function expectString(obj, key, issues) {
  const v = obj?.[key];
  if (typeof v !== "string" || v.length === 0) {
    issues.push(`field ${key} must be a non-empty string`);
    return null;
  }
  return v;
}
function isAbsoluteOrParentPath(path) {
  if (typeof path !== "string") return true;
  if (path.startsWith("/") || path.startsWith("\\")) return true;
  if (path === ".." || path.startsWith("../") || path.startsWith("..\\")) return true;
  return false;
}
function isGitPath(path) {
  return typeof path === "string" && (path === ".git" || path === "/.git" || path.startsWith(".git/") || path.startsWith(".git\\") || path.startsWith("/.git/") || path.startsWith("/.git\\"));
}
function looksLikeShellCommand(s) {
  if (typeof s !== "string") return false;
  if (s.length > 256) return false;
  if (/^[/~]/.test(s)) return true;
  if (/[|&;()<>`$]/.test(s)) return true;
  if (/\b(?:rm|chmod|chown|curl|wget|sudo|bash|sh)\b/.test(s)) return true;
  return false;
}
function validatePlanV2(raw) {
  const issues = [];
  if (!isPlainObject2(raw)) {
    return { ok: false, kind: "shape", issues: ["plan root must be an object"] };
  }
  const plan = (
    /** @type {any} */
    raw
  );
  if (plan.schemaVersion !== 2) {
    issues.push(`unsupported schemaVersion: ${JSON.stringify(plan.schemaVersion)} (expected 2)`);
  }
  expectString(plan, "workflowId", issues);
  if (typeof plan.revision !== "number" || !Number.isInteger(plan.revision) || plan.revision < 1) {
    issues.push("revision must be a positive integer");
  }
  if (plan.supersedes !== null && plan.supersedes !== void 0) {
    if (!isPlainObject2(plan.supersedes)) {
      issues.push("supersedes must be null or an object");
    } else {
      expectString(plan.supersedes, "revision", issues);
      expectString(plan.supersedes, "sha256", issues);
    }
  }
  if (!isPlainObject2(plan.authoredBy)) {
    issues.push("authoredBy must be an object");
  } else {
    expectString(plan.authoredBy, "sessionID", issues);
    const model = plan.authoredBy.model;
    if (typeof model !== "string" || !/^[^/]+\/[^/]+$/.test(model)) {
      issues.push("authoredBy.model must be a <provider>/<model> id");
    }
    expectString(plan.authoredBy, "createdAt", issues);
  }
  if (!isPlainObject2(plan.source)) {
    issues.push("source must be an object");
  } else {
    expectString(plan.source, "repository", issues);
    if (typeof plan.source.issueNumber !== "number" || !Number.isInteger(plan.source.issueNumber) || plan.source.issueNumber < 1) {
      issues.push("source.issueNumber must be a positive integer");
    }
    expectString(plan.source, "issueUrl", issues);
    expectString(plan.source, "baseBranch", issues);
    if (typeof plan.source.baseSha !== "string" || !/^[0-9a-f]{40}$/.test(plan.source.baseSha)) {
      issues.push("source.baseSha must be a 40-char commit SHA");
    }
  }
  if (typeof plan.goal !== "string" || plan.goal.length < 8) {
    issues.push("goal must be a non-trivial string");
  }
  if (!isPlainObject2(plan.architecture)) {
    issues.push("architecture must be an object");
  } else {
    expectString(plan.architecture, "summary", issues);
    if (!Array.isArray(plan.architecture.decisions)) {
      issues.push("architecture.decisions must be an array");
    }
  }
  if (!Array.isArray(plan.constraints)) {
    issues.push("constraints must be an array");
  }
  if (!Array.isArray(plan.files)) {
    issues.push("files must be an array");
  } else {
    for (const f of plan.files) {
      if (!isPlainObject2(f)) {
        issues.push("file entry is not an object");
        continue;
      }
      if (!["create", "modify", "delete"].includes(f.action)) {
        issues.push(`file action must be one of create|modify|delete, got ${JSON.stringify(f.action)}`);
      }
      if (isAbsoluteOrParentPath(f.path)) {
        issues.push(`file path must be a relative package path, got ${JSON.stringify(f.path)}`);
      }
    }
  }
  if (!Array.isArray(plan.tasks)) {
    issues.push("tasks must be an array");
    return finalize(plan, issues);
  }
  if (plan.tasks.length === 0) {
    issues.push("tasks must contain at least one task");
  }
  const seenIds = /* @__PURE__ */ new Set();
  for (const t of plan.tasks) {
    validateTask(t, issues, seenIds, plan);
  }
  return finalize(plan, issues);
}
function finalize(raw, issues) {
  if (Array.isArray(raw.tasks)) {
    const ids = new Set(raw.tasks.map((t) => t.id));
    for (const t of raw.tasks) {
      if (!Array.isArray(t.dependsOn)) continue;
      for (const dep of t.dependsOn) {
        if (!ids.has(dep)) {
          issues.push(`task ${t.id} depends on unknown task ${dep}`);
        }
      }
    }
  }
  if (Array.isArray(raw.tasks) && Array.isArray(raw.files)) {
    const declared = new Set(raw.files.map((f) => f.path));
    for (const t of raw.tasks) {
      for (const c of t.changes ?? []) {
        if (!declared.has(c.path)) {
          issues.push(`task ${t.id} changes undeclared file: ${c.path}`);
        }
      }
    }
  }
  return {
    ok: issues.length === 0,
    kind: issues.length === 0 ? "ok" : "shape",
    issues
  };
}
function validateTask(t, issues, seenIds, plan) {
  if (!isPlainObject2(t)) {
    issues.push("task entry is not an object");
    return;
  }
  if (typeof t.id !== "string" || t.id.length === 0) {
    issues.push("task id must be a non-empty string");
  } else if (seenIds.has(t.id)) {
    issues.push(`duplicate task id: ${t.id}`);
  } else {
    seenIds.add(t.id);
  }
  if (typeof t.ordinal !== "number" || !Number.isInteger(t.ordinal) || t.ordinal < 1) {
    issues.push(`task ${t.id}: ordinal must be a positive integer`);
  }
  expectString(t, "title", issues);
  expectString(t, "objective", issues);
  if (!Array.isArray(t.dependsOn)) {
    issues.push(`task ${t.id}: dependsOn must be an array`);
  }
  if (!Array.isArray(t.preconditions)) {
    issues.push(`task ${t.id}: preconditions must be an array`);
  }
  if (!Array.isArray(t.changes)) {
    issues.push(`task ${t.id}: changes must be an array`);
  } else {
    for (const c of t.changes) {
      if (!isPlainObject2(c)) continue;
      if (!["create", "modify", "delete"].includes(c.operation)) {
        issues.push(`task ${t.id}: change operation must be create|modify|delete, got ${JSON.stringify(c.operation)}`);
      }
      if (isAbsoluteOrParentPath(c.path)) {
        issues.push(`task ${t.id}: change path must be relative, got ${JSON.stringify(c.path)}`);
      }
      if (isGitPath(c.path)) {
        issues.push(`task ${t.id}: change path must not target .git, got ${JSON.stringify(c.path)}`);
      }
      if (!Array.isArray(c.instructions) || c.instructions.length === 0) {
        issues.push(`task ${t.id}: change ${c.path} must declare at least one instruction`);
      } else {
        for (const ins of c.instructions) {
          if (typeof ins !== "string" || ins.length === 0) {
            issues.push(`task ${t.id}: change ${c.path} instructions must be non-empty strings`);
            break;
          }
        }
      }
      if (!Array.isArray(c.preserve) || c.preserve.length === 0) {
        issues.push(`task ${t.id}: change ${c.path} must declare at least one preserve entry`);
      }
    }
  }
  if (!Array.isArray(t.interfaces)) {
    issues.push(`task ${t.id}: interfaces must be an array`);
  }
  if (!Array.isArray(t.tests)) {
    issues.push(`task ${t.id}: tests must be an array`);
  } else {
    for (const tc of t.tests) {
      if (!isPlainObject2(tc)) continue;
      if (typeof tc.file !== "string" || tc.file.length === 0) {
        issues.push(`task ${t.id}: test file must be a non-empty string`);
      }
      if (!Array.isArray(tc.cases) || tc.cases.length === 0) {
        issues.push(`task ${t.id}: test ${tc.file} must declare at least one case`);
      }
    }
  }
  if (!Array.isArray(t.commands)) {
    issues.push(`task ${t.id}: commands must be an array`);
  } else {
    for (const cmd of t.commands) {
      if (!isPlainObject2(cmd)) continue;
      if (!Array.isArray(cmd.argv) || cmd.argv.length < 1) {
        issues.push(`task ${t.id}: command argv must be a non-empty array`);
        continue;
      }
      for (const a of cmd.argv) {
        if (typeof a !== "string") {
          issues.push(`task ${t.id}: command argv entries must be strings`);
          break;
        }
        if (looksLikeShellCommand(a)) {
          issues.push(`task ${t.id}: command argv entry looks like a shell command: ${JSON.stringify(a)}`);
          break;
        }
      }
    }
  }
  if (!Array.isArray(t.acceptance) || t.acceptance.length === 0) {
    issues.push(`task ${t.id}: acceptance must be a non-empty array`);
  } else {
    for (const a of t.acceptance) {
      if (!isPlainObject2(a)) continue;
      expectString(a, "id", issues);
      expectString(a, "assertion", issues);
      if (!Array.isArray(a.evidence) || a.evidence.length === 0) {
        issues.push(`task ${t.id}: acceptance ${a.id} must declare non-empty evidence`);
      }
    }
  }
  if (!isPlainObject2(t.commit) || typeof t.commit.message !== "string" || t.commit.message.length === 0) {
    issues.push(`task ${t.id}: commit.message must be a non-empty string`);
  }
}
function computePlanHash(plan) {
  const json2 = canonicalJson(plan);
  return sha2563(json2);
}
function sha2563(text) {
  return createHash9("sha256").update(text, "utf8").digest("hex");
}

// src/workflow/plan-store.js
import { readFile as readFile9, writeFile as writeFile7, mkdir as mkdir9, readdir as readdir5, unlink as unlink4 } from "node:fs/promises";
import { existsSync as existsSync9 } from "node:fs";
import { join as join11, dirname as dirname5 } from "node:path";
init_durable_store();
import { createHash as createHash10 } from "node:crypto";
function revisionsDir(commonDir, workflowId) {
  return join11(opencodeShipStateDir(commonDir), "plans", workflowId, "revisions");
}
function revisionDir(commonDir, workflowId, revision) {
  const n = String(revision).padStart(6, "0");
  return join11(revisionsDir(commonDir, workflowId), n);
}
async function resolveCommon(repoRoot) {
  return resolveGitCommonDir(repoRoot);
}
async function publishPlanRevision(repoRoot, plan) {
  const v = validatePlanV2(plan);
  if (!v.ok) {
    throw new Error(`publishPlanRevision: invalid plan: ${v.issues.join("; ")}`);
  }
  const hash2 = computePlanHash(plan);
  const common = await resolveCommon(repoRoot);
  const dir = revisionDir(common, plan.workflowId, plan.revision);
  await mkdir9(dir, { recursive: true });
  const planPath = join11(dir, "plan.json");
  if (existsSync9(planPath)) {
    const existing = JSON.parse(await readFile9(planPath, "utf8"));
    if (existing?.plan?.workflowId !== plan.workflowId) {
      throw new Error(`publishPlanRevision: workflowId mismatch on existing record at ${planPath}`);
    }
    if (existing?.hash !== hash2) {
      throw new Error(`publishPlanRevision: hash mismatch on existing record at ${planPath} (existing ${existing.hash}, new ${hash2})`);
    }
    return { recorded: false, path: planPath, hash: hash2 };
  }
  const record2 = {
    plan,
    hash: hash2,
    publishedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await publishImmutableJson(planPath, record2);
  return { recorded: true, path: planPath, hash: hash2 };
}
async function publishApproval(repoRoot, approval) {
  if (!approval || typeof approval !== "object") {
    throw new Error("publishApproval: approval must be an object");
  }
  if (approval.decision !== "approved") {
    throw new Error(`publishApproval: unsupported decision ${approval.decision}`);
  }
  if (typeof approval.sha256 !== "string" || approval.sha256.length !== 64) {
    throw new Error("publishApproval: sha256 required");
  }
  const common = await resolveCommon(repoRoot);
  const dir = revisionDir(common, approval.workflowId, approval.revision);
  await mkdir9(dir, { recursive: true });
  const path = join11(dir, "approval.json");
  const planPath = join11(dir, "plan.json");
  if (existsSync9(planPath)) {
    const planRecord = JSON.parse(await readFile9(planPath, "utf8"));
    if (planRecord.hash !== approval.sha256) {
      throw new Error(`publishApproval: sha256 mismatch with plan record (plan ${planRecord.hash?.slice(0, 8)}, approval ${approval.sha256.slice(0, 8)})`);
    }
  }
  if (existsSync9(path)) {
    return { recorded: false, path };
  }
  await publishImmutableJson(path, { ...approval, publishedAt: (/* @__PURE__ */ new Date()).toISOString() });
  return { recorded: true, path };
}
async function readPlanRevision(repoRoot, workflowId, revision) {
  const common = await resolveCommon(repoRoot);
  const path = join11(revisionDir(common, workflowId, revision), "plan.json");
  if (!existsSync9(path)) return null;
  try {
    const raw = await readFile9(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// src/tools/ship-plan-submit.js
var SAFE_ID_RE3 = /^[A-Za-z0-9._-]{1,128}$/;
function createPlanSubmitTool(deps) {
  return async function planSubmit(input) {
    const opId = input.operationId ?? `plan-submit-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const revision = Number(input.revision);
    const plan = input.plan;
    if (!workflowId || !SAFE_ID_RE3.test(workflowId)) {
      return failure("plan-submit", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!Number.isInteger(revision) || revision <= 0) {
      return failure("plan-submit", "revision must be a positive integer", { operationId: opId, retryable: false });
    }
    if (!plan || typeof plan !== "object") {
      return failure("plan-submit", "plan object required", { operationId: opId, retryable: false });
    }
    if (plan.workflowId !== workflowId || plan.revision !== revision) {
      return failure("plan-submit", "plan identity must match workflowId and revision", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    if (!ctx || typeof ctx.sessionID !== "string") {
      return failure("plan-submit", "ToolContext.sessionID required (planner session)", { operationId: opId, retryable: false });
    }
    const auth = await authorizeChildCall(
      deps.repoRoot,
      workflowId,
      ROLES.PLANNER,
      { revision },
      ctx
    );
    if (!auth.ok) {
      return failure("plan-submit", `planner authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const v = validatePlanV2(plan);
    if (!v.ok) {
      return failure("plan-submit", `plan validation failed: ${v.issues.join("; ")}`, { operationId: opId, retryable: false });
    }
    const expectedHash = computePlanHash(plan);
    const providedHash = String(input.sha256 ?? "");
    if (providedHash && providedHash !== expectedHash) {
      return failure("plan-submit", `sha256 mismatch (expected ${expectedHash.slice(0, 8)}, got ${providedHash.slice(0, 8)})`, { operationId: opId, retryable: false });
    }
    try {
      const result = await publishPlanRevision(deps.repoRoot, plan);
      return success2("plan-submit", {
        workflowId,
        revision,
        sha256: result.hash,
        recorded: result.recorded,
        plannerSessionID: ctx.sessionID
      }, { operationId: opId });
    } catch (err) {
      return failure("plan-submit", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/tools/ship-plan-approve.js
var SAFE_ID_RE4 = /^[A-Za-z0-9._-]{1,128}$/;
function createPlanApproveTool(deps) {
  return async function planApprove(input) {
    const opId = input.operationId ?? `plan-approve-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const revision = Number(input.revision);
    const sha2565 = String(input.sha256 ?? "");
    const subject = String(input.subject ?? "");
    if (!workflowId || !SAFE_ID_RE4.test(workflowId)) {
      return failure("plan-approve", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!Number.isInteger(revision) || revision <= 0) {
      return failure("plan-approve", "revision required", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{64}$/.test(sha2565)) {
      return failure("plan-approve", "sha256 required (64 hex chars)", { operationId: opId, retryable: false });
    }
    if (!subject) {
      return failure("plan-approve", "user permission subject required", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeControllerCall(deps.repoRoot, workflowId, ctx);
    if (!auth.ok) {
      return failure("plan-approve", `controller authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    try {
      const planRecord = await readPlanRevision(deps.repoRoot, workflowId, revision);
      if (!planRecord || planRecord.hash !== sha2565) {
        return failure("plan-approve", "plan revision is missing or does not match sha256", { operationId: opId, retryable: false });
      }
      const result = await publishApproval(deps.repoRoot, {
        workflowId,
        revision,
        decision: "approved",
        sessionID: auth.sessionID,
        approvedBy: subject,
        approvedAt: (/* @__PURE__ */ new Date()).toISOString(),
        chunkIds: Array.isArray(input.chunkIds) ? input.chunkIds : [],
        chunkHashes: Array.isArray(input.chunkHashes) ? input.chunkHashes : [],
        baseSha: planRecord.plan.source.baseSha,
        models: planRecord.plan.models ?? deps.configValue?.workflow?.models ?? null,
        sha256: sha2565
      });
      return success2("plan-approve", {
        workflowId,
        revision,
        sha256: sha2565,
        recorded: result.recorded
      }, { operationId: opId });
    } catch (err) {
      return failure("plan-approve", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/tools/ship-run-start.js
import { readFile as readFile10 } from "node:fs/promises";
import { join as join12 } from "node:path";
import { execFile } from "node:child_process";
var SAFE_ID_RE5 = /^[A-Za-z0-9._-]{1,128}$/;
async function readRevisionRecord(repoRoot, workflowId, revision) {
  const commonDir = await resolveGitCommonDir(repoRoot);
  const rev = String(revision).padStart(6, "0");
  const dir = join12(opencodeShipStateDir(commonDir), "plans", workflowId, "revisions", rev);
  const planRaw = await readFile10(join12(dir, "plan.json"), "utf8");
  const plan = JSON.parse(planRaw);
  const approvalPath = join12(dir, "approval.json");
  let approval = null;
  try {
    approval = JSON.parse(await readFile10(approvalPath, "utf8"));
  } catch {
    approval = null;
  }
  return { dir, plan, approval };
}
function createRunStartTool(deps) {
  return async function runStart(input) {
    const opId = input.operationId ?? `run-start-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    if (!workflowId || !SAFE_ID_RE5.test(workflowId)) {
      return failure("run-start", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeControllerCall(deps.repoRoot, workflowId, ctx);
    if (!auth.ok) {
      return failure("run-start", `controller authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const configValue = deps.configValue ?? deps.config?.value ?? null;
    const expectedModels = configValue?.workflow?.models ?? null;
    if (!expectedModels) {
      return failure("run-start", "run-start requires configured workflow.models", { operationId: opId, retryable: false });
    }
    const revision = Number(input.revision ?? 0);
    if (!Number.isInteger(revision) || revision <= 0) {
      return failure("run-start", "revision required", { operationId: opId, retryable: false });
    }
    let records;
    try {
      records = await readRevisionRecord(deps.repoRoot, workflowId, revision);
    } catch (err) {
      return failure("run-start", `plan revision not found: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!records.approval) {
      return failure("run-start", "no approval record for this revision", { operationId: opId, retryable: false });
    }
    if (records.approval.sha256 !== records.plan.hash) {
      return failure("run-start", `approval sha256 mismatch: plan ${records.plan.hash?.slice(0, 8)} vs approval ${records.approval.sha256?.slice(0, 8)}`, { operationId: opId, retryable: false });
    }
    const expectedHash = records.approval.sha256;
    if (input.sha256 && input.sha256 !== expectedHash) {
      return failure("run-start", `sha256 mismatch: expected ${expectedHash.slice(0, 8)}, got ${String(input.sha256).slice(0, 8)}`, { operationId: opId, retryable: false });
    }
    if (records.approval.models) {
      const a = records.approval.models;
      if (a.planner !== expectedModels.planner || a.builder !== expectedModels.builder || a.finalReviewer !== expectedModels.finalReviewer) {
        return failure("run-start", "approval models no longer match configured workflow.models", { operationId: opId, retryable: false });
      }
    }
    const approvedBaseSha = String(records.approval.baseSha ?? records.plan.plan?.source?.baseSha ?? "");
    const currentHead2 = await gitHead(deps.repoRoot).catch(() => null);
    if (!/^[0-9a-f]{40}$/.test(approvedBaseSha) || currentHead2 !== approvedBaseSha) {
      return failure("run-start", `approved base SHA is stale (approved ${approvedBaseSha.slice(0, 8)}, current ${String(currentHead2).slice(0, 8)})`, { operationId: opId, retryable: false });
    }
    try {
      const initial = createInitialState(workflowId, revision, expectedHash);
      await appendRunEvent(deps.repoRoot, workflowId, initial, {
        kind: RUN_EVENT_KINDS.RUN_START,
        data: { revision, sha256: expectedHash }
      });
      return success2("run-start", { workflowId, revision, sha256: expectedHash }, { operationId: opId });
    } catch (err) {
      return failure("run-start", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
function gitHead(cwd) {
  return new Promise((resolveP, rejectP) => {
    execFile("git", ["-C", cwd, "rev-parse", "HEAD"], { cwd, shell: false }, (err, stdout, stderr) => {
      if (err) return rejectP(new Error(stderr || err.message));
      resolveP(String(stdout).trim());
    });
  });
}

// src/tools/ship-task-start.js
import { mkdir as mkdir10 } from "node:fs/promises";
import { join as join13 } from "node:path";
init_durable_store();
import { createHash as createHash11 } from "node:crypto";
var SAFE_ID_RE6 = /^[A-Za-z0-9._-]{1,128}$/;
function createTaskStartTool(deps) {
  return async function taskStart(input) {
    const opId = input.operationId ?? `task-start-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const taskId = String(input.taskId ?? "");
    if (!workflowId || !SAFE_ID_RE6.test(workflowId)) {
      return failure("task-start", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!taskId || !SAFE_ID_RE6.test(taskId)) {
      return failure("task-start", "taskId required (safe id)", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeControllerCall(deps.repoRoot, workflowId, ctx);
    if (!auth.ok) {
      return failure("task-start", `controller authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const lock = await readLock2(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("task-start", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let models;
    try {
      models = resolveModelRoles(deps.config?.workflow, { strict: true });
    } catch (err) {
      return failure("task-start", `builder model unresolved: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("task-start", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("task-start", "run not started", { operationId: opId, retryable: false });
    }
    const planRecord = await readPlanRevision(deps.repoRoot, workflowId, runState.revision);
    if (!planRecord || planRecord.hash !== runState.sha256) {
      return failure("task-start", "approved plan is missing or does not match the run", { operationId: opId, retryable: false });
    }
    const remainingTasks = planRecord.plan.tasks.filter((task2) => !runState.completedTasks.includes(task2.id));
    const task = remainingTasks[0];
    if (!task || task.id !== taskId) {
      return failure("task-start", `task ${taskId} is not the next task in the approved plan`, { operationId: opId, retryable: false });
    }
    const unsatisfied = (task.dependsOn ?? []).filter((dependency) => !runState.completedTasks.includes(dependency));
    if (unsatisfied.length > 0) {
      return failure("task-start", `task dependencies are incomplete: ${unsatisfied.join(", ")}`, { operationId: opId, retryable: false });
    }
    const briefHash = createHash11("sha256").update(canonicalJson(task), "utf8").digest("hex");
    const round = runState.round > 0 ? runState.round : 1;
    try {
      let dispatchResult = null;
      if (deps.opencodeClient) {
        dispatchResult = await dispatchWorker({
          repoRoot: deps.repoRoot,
          workflowId,
          role: ROLES.BUILDER,
          keyInput: { taskId, round },
          payload: {
            promptText: [
              `Implement workflow ${workflowId} task ${taskId} round ${round}.`,
              `Call ship_task_report with workflowId=${workflowId}, taskId=${taskId}, and round=${round}.`,
              `Approved task brief:
${JSON.stringify(task, null, 2)}`
            ].join("\n\n")
          },
          client: deps.opencodeClient,
          parentSessionID: ctx.sessionID,
          titleMarker: `ship-task-builder-${workflowId}-${taskId}`,
          agent: "ship-task-builder",
          model: models.builder
        });
      }
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const dispatchDir2 = join13(
        opencodeShipStateDir(commonDir),
        "runs",
        workflowId,
        "tasks",
        taskId,
        "rounds",
        String(round).padStart(4, "0"),
        "dispatch"
      );
      await mkdir10(dispatchDir2, { recursive: true });
      const record2 = {
        workflowId,
        taskId,
        round,
        builderSessionID: dispatchResult?.sessionID ?? null,
        dispatchKey: dispatchResult?.dispatchKey ?? null,
        controllerSessionID: ctx.sessionID,
        builder: models.builder,
        briefHash,
        task,
        dispatchedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await publishImmutableJson(join13(dispatchDir2, "dispatch.json"), record2);
      const { state, event } = await appendRunEvent(
        deps.repoRoot,
        workflowId,
        runState,
        {
          kind: RUN_EVENT_KINDS.TASK_DISPATCH,
          data: { taskId, briefHash, sessionID: dispatchResult?.sessionID ?? null }
        }
      );
      return success2("task-start", {
        workflowId,
        taskId,
        builderSessionID: dispatchResult?.sessionID ?? null,
        dispatchKey: dispatchResult?.dispatchKey ?? null,
        state: state.state,
        sequence: event.sequence,
        round: state.round
      }, { operationId: opId });
    } catch (err) {
      return failure("task-start", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/tools/ship-task-commit.js
import { execFile as execFile2 } from "node:child_process";
import { mkdir as mkdir11, readFile as readFile11 } from "node:fs/promises";
import { existsSync as existsSync10 } from "node:fs";
import { join as join14 } from "node:path";
init_durable_store();
var SAFE_ID_RE7 = /^[A-Za-z0-9._-]{1,128}$/;
function spawn5(cmd, args, cwd) {
  return new Promise((resolveP, rejectP) => {
    execFile2(cmd, args, { cwd, shell: false }, (err, stdout, stderr) => {
      if (err) {
        const msg = typeof stderr === "string" ? stderr : stderr ? String(stderr) : err.message;
        return rejectP(new Error(`${cmd} failed: ${msg}`));
      }
      resolveP(typeof stdout === "string" ? stdout : String(stdout));
    });
  });
}
function createTaskCommitTool(deps) {
  return async function taskCommit(input) {
    const opId = input.operationId ?? `task-commit-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const taskId = String(input.taskId ?? "");
    const expectedHead = String(input.expectedHead ?? "");
    const commitSha = String(input.commitSha ?? "");
    const planHash = String(input.planHash ?? "");
    const reviewHash = String(input.reviewHash ?? "");
    const round = Number(input.round ?? 1);
    if (!workflowId || !SAFE_ID_RE7.test(workflowId)) {
      return failure("task-commit", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!taskId || !SAFE_ID_RE7.test(taskId)) {
      return failure("task-commit", "taskId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{40}$/.test(expectedHead)) {
      return failure("task-commit", "expectedHead required (40-char commit SHA)", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{40}$/.test(commitSha)) {
      return failure("task-commit", "commitSha required (40-char commit SHA)", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{64}$/.test(planHash)) {
      return failure("task-commit", "planHash required (sha256)", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{64}$/.test(reviewHash)) {
      return failure("task-commit", "reviewHash required (sha256 from ship_task_review)", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeControllerCall(deps.repoRoot, workflowId, ctx);
    if (!auth.ok) {
      return failure("task-commit", `controller authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const lock = await readLock2(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("task-commit", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("task-commit", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("task-commit", "run not started", { operationId: opId, retryable: false });
    }
    const priorCommit = runState.events.find((event) => event.kind === RUN_EVENT_KINDS.COMMIT && event.data?.taskId === taskId && event.data?.commitSha === commitSha);
    if (priorCommit) {
      return success2("task-commit", {
        workflowId,
        taskId,
        commitSha,
        state: runState.state,
        sequence: priorCommit.sequence
      }, { operationId: opId, idempotent: true });
    }
    if (runState.activeTask !== taskId) {
      return failure("task-commit", `no active task ${taskId} (active=${runState.activeTask})`, { operationId: opId, retryable: false });
    }
    if (runState.state !== "commit-pending") {
      return failure("task-commit", `task-review must pass before commit; run state=${runState.state}`, { operationId: opId, retryable: false });
    }
    if (commitSha !== expectedHead) {
      return failure("task-commit", "commitSha must equal expectedHead", { operationId: opId, retryable: false });
    }
    if (planHash !== runState.sha256) {
      return failure("task-commit", "planHash does not match the active run", { operationId: opId, retryable: false });
    }
    if (reviewHash !== runState.taskReady?.reviewHash) {
      return failure("task-commit", "reviewHash does not match the recorded task review", { operationId: opId, retryable: false });
    }
    if (round !== runState.round) {
      return failure("task-commit", `round does not match the active run (${runState.round})`, { operationId: opId, retryable: false });
    }
    try {
      const actualHead = (await spawn5("git", ["-C", deps.repoRoot, "rev-parse", "HEAD"], deps.repoRoot)).trim();
      if (actualHead !== expectedHead) {
        return failure("task-commit", `HEAD drift (expected ${expectedHead.slice(0, 8)}, got ${actualHead.slice(0, 8)})`, { operationId: opId, retryable: false });
      }
      const trailers = buildCommitTrailers({ workflowId, planHash, taskId, round, reviewHash });
      const message = await spawn5("git", ["-C", deps.repoRoot, "log", "-1", "--format=%B", expectedHead], deps.repoRoot);
      const trailerLines = trailers.map((t) => `  ${t}`).join("\n");
      const missingTrailer = trailers.find((trailer) => !message.includes(trailer));
      if (missingTrailer) {
        return failure("task-commit", `commit ${expectedHead.slice(0, 8)} missing trailer: ${missingTrailer}`, { operationId: opId, retryable: false });
      }
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const commitDir = join14(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", taskId, "commit");
      await mkdir11(commitDir, { recursive: true });
      const record2 = {
        workflowId,
        taskId,
        round,
        commitSha,
        planHash,
        reviewHash,
        trailers,
        trailerBlock: trailerLines,
        committedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const commitPath = join14(commitDir, "commit.json");
      if (existsSync10(commitPath)) {
        const existing = JSON.parse(await readFile11(commitPath, "utf8"));
        if (existing.workflowId !== workflowId || existing.taskId !== taskId || existing.round !== round || existing.commitSha !== commitSha || existing.planHash !== planHash || existing.reviewHash !== reviewHash) {
          return failure("task-commit", "immutable task commit conflicts with retry", { operationId: opId, retryable: false });
        }
      } else {
        await publishImmutableJson(commitPath, record2);
      }
      const { state, event } = await appendRunEvent(
        deps.repoRoot,
        workflowId,
        runState,
        { kind: RUN_EVENT_KINDS.COMMIT, data: { taskId, commitSha } }
      );
      return success2("task-commit", { workflowId, taskId, commitSha, state: state.state, sequence: event.sequence }, { operationId: opId });
    } catch (err) {
      return failure("task-commit", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/tools/ship-task-complete.js
import { mkdir as mkdir12, readFile as readFile12 } from "node:fs/promises";
import { existsSync as existsSync11 } from "node:fs";
import { join as join15 } from "node:path";
import { execFile as execFile3 } from "node:child_process";
import { createHash as createHash12 } from "node:crypto";
init_durable_store();
var SAFE_ID_RE8 = /^[A-Za-z0-9._-]{1,128}$/;
function createTaskCompleteTool(deps) {
  return async function taskComplete(input) {
    const opId = input.operationId ?? `task-complete-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const taskId = String(input.taskId ?? "");
    const moreTasks = input.moreTasks === false ? false : input.moreTasks === true ? true : null;
    const nextTaskId = input.nextTaskId ? String(input.nextTaskId) : null;
    const expectedHead = String(input.expectedHead ?? "");
    if (!workflowId || !SAFE_ID_RE8.test(workflowId)) {
      return failure("task-complete", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!taskId || !SAFE_ID_RE8.test(taskId)) {
      return failure("task-complete", "taskId required (safe id)", { operationId: opId, retryable: false });
    }
    if (moreTasks === null) {
      return failure("task-complete", "moreTasks must be explicitly true or false", { operationId: opId, retryable: false });
    }
    if (moreTasks && (!nextTaskId || !SAFE_ID_RE8.test(nextTaskId))) {
      return failure("task-complete", "nextTaskId required when moreTasks=true", { operationId: opId, retryable: false });
    }
    if (!moreTasks && !/^[0-9a-f]{40}$/.test(expectedHead)) {
      return failure("task-complete", "expectedHead required for final review", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeControllerCall(deps.repoRoot, workflowId, ctx);
    if (!auth.ok) {
      return failure("task-complete", `controller authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const lock = await readLock2(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("task-complete", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("task-complete", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("task-complete", "run not started", { operationId: opId, retryable: false });
    }
    const priorComplete = runState.events.find((event) => event.kind === RUN_EVENT_KINDS.TASK_COMPLETE && event.data?.taskId === taskId && event.data?.moreTasks === moreTasks && (event.data?.nextTaskId ?? null) === (nextTaskId ?? null));
    if (!priorComplete && runState.state !== "committed") {
      return failure("task-complete", `task-commit must precede task-complete; run state=${runState.state}`, { operationId: opId, retryable: false });
    }
    const planRecord = await readPlanRevision(deps.repoRoot, workflowId, runState.revision);
    if (!planRecord || planRecord.hash !== runState.sha256) {
      return failure("task-complete", "approved plan is missing or does not match the run", { operationId: opId, retryable: false });
    }
    if (!planRecord.plan.tasks.some((task) => task.id === taskId) || !runState.completedTasks.includes(taskId)) {
      return failure("task-complete", `task ${taskId} is not a committed task in the approved plan`, { operationId: opId, retryable: false });
    }
    const remainingTasks = planRecord.plan.tasks.filter((task) => !runState.completedTasks.includes(task.id));
    if (moreTasks && remainingTasks[0]?.id !== nextTaskId) {
      return failure("task-complete", `nextTaskId must be ${remainingTasks[0]?.id ?? "absent"}`, { operationId: opId, retryable: false });
    }
    if (!moreTasks && remainingTasks.length > 0) {
      return failure("task-complete", `plan still has incomplete tasks: ${remainingTasks.map((task) => task.id).join(", ")}`, { operationId: opId, retryable: false });
    }
    try {
      const gateEvidence = moreTasks ? null : await loadTrustedGateEvidence({
        repoRoot: deps.repoRoot,
        repoSlug: deps.repoSlug,
        driver: deps.driver,
        adapter: deps.adapter,
        workflowId,
        issueNumber: planRecord.plan.source.issueNumber,
        expectedHead
      });
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const finalPackage = moreTasks ? null : await loadOrBuildFinalPackage({
        repoRoot: deps.repoRoot,
        commonDir,
        workflowId,
        runState,
        planRecord,
        expectedHead,
        verificationHash: gateEvidence?.verificationHash ?? "",
        ciHash: gateEvidence?.ciHash ?? "",
        gateTaskId: gateEvidence?.taskId ?? ""
      });
      const completeDir = join15(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", taskId, "complete");
      await mkdir12(completeDir, { recursive: true });
      const record2 = {
        workflowId,
        taskId,
        moreTasks,
        nextTaskId: nextTaskId ?? null,
        finalReview: finalPackage,
        completedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const completePath = join15(completeDir, "complete.json");
      if (existsSync11(completePath)) {
        const existing = JSON.parse(await readFile12(completePath, "utf8"));
        if (existing.workflowId !== workflowId || existing.taskId !== taskId || existing.moreTasks !== moreTasks || (existing.nextTaskId ?? null) !== (nextTaskId ?? null) || (existing.finalReview?.packageHash ?? null) !== (finalPackage?.packageHash ?? null)) {
          return failure("task-complete", "immutable task completion conflicts with retry", { operationId: opId, retryable: false });
        }
      } else {
        await publishImmutableJson(completePath, record2);
      }
      let state = runState;
      let event = priorComplete ?? runState.events.at(-1);
      if (!priorComplete) {
        ({ state, event } = await appendRunEvent(
          deps.repoRoot,
          workflowId,
          runState,
          { kind: RUN_EVENT_KINDS.TASK_COMPLETE, data: { taskId, moreTasks, nextTaskId: nextTaskId ?? null } }
        ));
      }
      let finalReview = finalPackage ? {
        packageHash: finalPackage.packageHash,
        headSha: finalPackage.headSha,
        mergeBaseSha: finalPackage.mergeBaseSha,
        standardsSessionID: null,
        specSessionID: null
      } : null;
      if (!moreTasks && deps.opencodeClient) {
        const models = resolveModelRoles(deps.config?.workflow, { strict: true });
        const packageHash = finalPackage.packageHash;
        const packagePath = join15(opencodeShipStateDir(commonDir), "runs", workflowId, "final-review", "package.json");
        const promptText = [
          `Review workflow ${workflowId} package ${packageHash} at HEAD ${finalPackage.headSha} against merge base ${finalPackage.mergeBaseSha}.`,
          `Canonical package path: ${packagePath}`,
          `Canonical package:
${JSON.stringify(finalPackage, null, 2)}`
        ].join("\n\n");
        const [standards, spec] = await Promise.all([
          dispatchWorker({
            repoRoot: deps.repoRoot,
            workflowId,
            role: ROLES.FINAL_STANDARDS,
            keyInput: { packageHash },
            payload: { promptText },
            client: deps.opencodeClient,
            parentSessionID: auth.sessionID,
            titleMarker: `ship-final-standards-${workflowId}`,
            agent: "ship-final-standards-reviewer",
            model: models.finalReviewer
          }),
          dispatchWorker({
            repoRoot: deps.repoRoot,
            workflowId,
            role: ROLES.FINAL_SPEC,
            keyInput: { packageHash },
            payload: { promptText },
            client: deps.opencodeClient,
            parentSessionID: auth.sessionID,
            titleMarker: `ship-final-spec-${workflowId}`,
            agent: "ship-final-spec-reviewer",
            model: models.finalReviewer
          })
        ]);
        finalReview = {
          packageHash,
          headSha: finalPackage.headSha,
          mergeBaseSha: finalPackage.mergeBaseSha,
          standardsSessionID: standards.sessionID,
          specSessionID: spec.sessionID
        };
      }
      return success2("task-complete", {
        workflowId,
        taskId,
        moreTasks,
        nextTaskId: nextTaskId ?? null,
        finalReview,
        state: state.state,
        sequence: event.sequence
      }, { operationId: opId });
    } catch (err) {
      return failure("task-complete", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
async function loadTrustedGateEvidence({ repoRoot, repoSlug, driver, adapter, workflowId, issueNumber, expectedHead }) {
  const manifests = (await listManifests(repoRoot)).filter((manifest2) => manifest2.issueNumber === issueNumber);
  if (manifests.length !== 1) throw new Error(`expected one delivery manifest for issue #${issueNumber}, found ${manifests.length}`);
  const manifest = manifests[0];
  if (manifest.schemaVersion < 2 || manifest.workflowId !== workflowId) {
    throw new Error("delivery manifest is not linked to the current workflow");
  }
  if (manifest.lastVerifierSha !== expectedHead || !/^[0-9a-f]{64}$/.test(manifest.lastVerificationHash ?? "")) {
    throw new Error("fresh immutable verification receipt is missing");
  }
  const verification = await readGateReceipt(repoRoot, manifest.taskId, "verification", manifest.lastVerificationHash);
  if (!verification || verification.headSha !== expectedHead || verification.exitCode !== 0) {
    throw new Error("verification receipt does not match final HEAD");
  }
  if (!driver) throw new Error("CI driver is unavailable");
  const prHead = await driver.refreshHead({ repo: repoSlug, number: manifest.prNumber });
  if (prHead !== expectedHead) throw new Error("PR HEAD does not match final review HEAD");
  const required2 = adapter?.ci?.requiredChecks ?? [];
  const checks = await driver.readChecks({
    repo: repoSlug,
    number: manifest.prNumber,
    branch: manifest.branch,
    required: required2
  });
  const normalized = required2.map((name) => {
    const observed = checks.find((check2) => check2.name === name);
    return { name, bucket: bucketFor(observed) };
  });
  const unhealthy = normalized.filter((check2) => check2.bucket !== "pass");
  if (unhealthy.length > 0) {
    throw new Error(`required CI is not passing: ${unhealthy.map((check2) => `${check2.name}:${check2.bucket}`).join(", ")}`);
  }
  const { receipt: ci } = await publishGateReceipt(repoRoot, manifest.taskId, "ci", {
    headSha: expectedHead,
    prNumber: manifest.prNumber,
    checks: normalized
  });
  return { verificationHash: verification.receiptHash, ciHash: ci.receiptHash, taskId: manifest.taskId };
}
async function loadOrBuildFinalPackage({ repoRoot, commonDir, workflowId, runState, planRecord, expectedHead, verificationHash, ciHash, gateTaskId }) {
  const reviewDir = join15(opencodeShipStateDir(commonDir), "runs", workflowId, "final-review");
  const packagePath = join15(reviewDir, "package.json");
  if (existsSync11(packagePath)) {
    const existing = JSON.parse(await readFile12(packagePath, "utf8"));
    if (existing.headSha !== expectedHead || existing.verificationHash !== verificationHash || existing.ciHash !== ciHash || existing.gateTaskId !== gateTaskId) {
      throw new Error("final review package already exists with different gate evidence");
    }
    return existing;
  }
  const actualHead = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  if (actualHead !== expectedHead) {
    throw new Error(`HEAD drift before final review (expected ${expectedHead.slice(0, 8)}, got ${actualHead.slice(0, 8)})`);
  }
  const mergeBaseSha = String(planRecord.plan?.source?.baseSha ?? "");
  if (!/^[0-9a-f]{40}$/.test(mergeBaseSha)) throw new Error("approved plan base SHA is invalid");
  const observedMergeBase = (await git(repoRoot, ["merge-base", mergeBaseSha, actualHead])).trim();
  if (observedMergeBase !== mergeBaseSha) {
    throw new Error(`approved base ${mergeBaseSha.slice(0, 8)} is not the merge base of final HEAD`);
  }
  const revision = String(runState.revision).padStart(6, "0");
  const approvalRaw = await readFile12(join15(opencodeShipStateDir(commonDir), "plans", workflowId, "revisions", revision, "approval.json"), "utf8");
  const tasks = [];
  for (const completedTaskId of runState.completedTasks ?? []) {
    const commitRaw = await readFile12(join15(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", completedTaskId, "commit", "commit.json"), "utf8");
    const commit = JSON.parse(commitRaw);
    tasks.push({
      taskId: completedTaskId,
      commitSha: commit.commitSha,
      taskHash: sha2564(commitRaw),
      reviewHash: commit.reviewHash
    });
  }
  const pkg = buildFinalReviewPackage({
    workflowId,
    headSha: actualHead,
    mergeBaseSha,
    planHash: planRecord.hash,
    approvalHash: sha2564(approvalRaw),
    gateTaskId,
    verificationHash,
    ciHash,
    tasks,
    builtAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  await mkdir12(reviewDir, { recursive: true });
  await publishImmutableJson(packagePath, pkg);
  return pkg;
}
function git(cwd, args) {
  return new Promise((resolveP, rejectP) => {
    execFile3("git", ["-C", cwd, ...args], { cwd, shell: false }, (err, stdout, stderr) => {
      if (err) return rejectP(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
      resolveP(String(stdout));
    });
  });
}
function sha2564(value) {
  return createHash12("sha256").update(value, "utf8").digest("hex");
}

// src/tools/ship-task-report.js
import { mkdir as mkdir13, readFile as readFile13 } from "node:fs/promises";
import { existsSync as existsSync12 } from "node:fs";
import { createHash as createHash13 } from "node:crypto";
import { join as join16 } from "node:path";
init_durable_store();
var SAFE_ID_RE9 = /^[A-Za-z0-9._-]{1,128}$/;
function createTaskReportTool(deps) {
  return async function taskReport(input) {
    const opId = input.operationId ?? `task-report-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const taskId = String(input.taskId ?? "");
    const round = Number(input.round ?? 1);
    const summary = String(input.summary ?? "");
    if (!workflowId || !SAFE_ID_RE9.test(workflowId)) {
      return failure("task-report", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!taskId || !SAFE_ID_RE9.test(taskId)) {
      return failure("task-report", "taskId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!Number.isInteger(round) || round <= 0) {
      return failure("task-report", "round must be a positive integer", { operationId: opId, retryable: false });
    }
    if (!summary) return failure("task-report", "summary required", { operationId: opId, retryable: false });
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeChildCall(
      deps.repoRoot,
      workflowId,
      ROLES.BUILDER,
      { taskId, round },
      ctx
    );
    if (!auth.ok) {
      return failure("task-report", `builder authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const lock = await readLock2(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("task-report", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("task-report", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("task-report", "run not started", { operationId: opId, retryable: false });
    }
    if (runState.activeTask !== null && runState.activeTask !== taskId) {
      return failure("task-report", `another task is already active (${runState.activeTask})`, { operationId: opId, retryable: false });
    }
    try {
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const reportDir = join16(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", taskId, "rounds", `${String(round).padStart(4, "0")}`);
      await mkdir13(reportDir, { recursive: true });
      const record2 = {
        workflowId,
        taskId,
        round,
        builderSessionID: auth.sessionID,
        summary,
        changes: Array.isArray(input.changes) ? input.changes : [],
        tests: Array.isArray(input.tests) ? input.tests : [],
        submittedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const reportPath = join16(reportDir, "implementer-report.json");
      let state = runState;
      let event = runState.events.at(-1) ?? { sequence: 0 };
      let persistedRecord = record2;
      if (existsSync12(reportPath)) {
        persistedRecord = JSON.parse(await readFile13(reportPath, "utf8"));
        if (!sameReport(persistedRecord, record2)) {
          return failure("task-report", "immutable report already exists with different content", { operationId: opId, retryable: false });
        }
      } else {
        await publishImmutableJson(reportPath, record2);
      }
      const persistedReportHash = reportHash(persistedRecord);
      if (!runState.events.some((candidate) => candidate.kind === RUN_EVENT_KINDS.TASK_REPORT && candidate.data?.reportHash === persistedReportHash)) {
        ({ state, event } = await appendRunEvent(
          deps.repoRoot,
          workflowId,
          runState,
          {
            kind: RUN_EVENT_KINDS.TASK_REPORT,
            data: { taskId, round, summary, reportHash: persistedReportHash, sessionID: auth.sessionID }
          }
        ));
      }
      const lease = await readControllerLease(deps.repoRoot, workflowId);
      const parentSessionID = lease?.controllerSessionID ?? deps.controllerSessionID ?? input.ctx?.sessionID ?? null;
      const models = resolveModelRoles(deps.config?.workflow, { strict: true });
      const planRecord = await readPlanRevision(deps.repoRoot, workflowId, runState.revision);
      const task = planRecord?.plan?.tasks?.find((candidate) => candidate.id === taskId);
      if (!task) {
        return failure("task-report", `task ${taskId} is missing from the approved plan`, { operationId: opId, retryable: false });
      }
      let reviewerDispatch = null;
      if (deps.opencodeClient) {
        try {
          reviewerDispatch = await dispatchWorker({
            repoRoot: deps.repoRoot,
            workflowId,
            role: ROLES.TASK_REVIEWER,
            keyInput: { taskId, round },
            payload: {
              promptText: [
                `Review workflow ${workflowId} task ${taskId} round ${round}.`,
                `Call ship_task_review with workflowId=${workflowId}, taskId=${taskId}, and round=${round}.`,
                `Approved task brief:
${JSON.stringify(task, null, 2)}`,
                `Implementer report (${reportPath}):
${JSON.stringify(persistedRecord, null, 2)}`
              ].join("\n\n")
            },
            client: deps.opencodeClient,
            parentSessionID,
            titleMarker: `ship-task-reviewer-${workflowId}-${taskId}-${round}`,
            agent: "ship-task-reviewer",
            model: models.builder
          });
        } catch (err) {
          reviewerDispatch = { sessionID: null, dispatchKey: null, error: err?.message ?? String(err) };
        }
      }
      return success2("task-report", {
        workflowId,
        taskId,
        round,
        builderSessionID: auth.sessionID,
        reviewerSessionID: reviewerDispatch?.sessionID ?? null,
        reviewerDispatchKey: reviewerDispatch?.dispatchKey ?? null,
        reviewerDispatchError: reviewerDispatch && "error" in reviewerDispatch ? reviewerDispatch.error : null,
        state: state.state,
        sequence: event.sequence
      }, { operationId: opId });
    } catch (err) {
      return failure("task-report", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
function reportHash(record2) {
  const sorted = Object.keys(record2).sort();
  const ordered = {};
  for (const k of sorted) ordered[k] = record2[k];
  return createHash13("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}
function sameReport(left, right) {
  for (const field of ["workflowId", "taskId", "round", "builderSessionID", "summary"]) {
    if (left?.[field] !== right?.[field]) return false;
  }
  return JSON.stringify(left?.changes ?? []) === JSON.stringify(right?.changes ?? []) && JSON.stringify(left?.tests ?? []) === JSON.stringify(right?.tests ?? []);
}

// src/tools/ship-task-review.js
import { createHash as createHash14 } from "node:crypto";
import { mkdir as mkdir14, readFile as readFile14 } from "node:fs/promises";
import { existsSync as existsSync13 } from "node:fs";
import { join as join17 } from "node:path";
init_durable_store();
var SAFE_ID_RE10 = /^[A-Za-z0-9._-]{1,128}$/;
var VERDICT_VALUES = /* @__PURE__ */ new Set(["pass", "fail", "none"]);
function createTaskReviewTool(deps) {
  return async function taskReview(input) {
    const opId = input.operationId ?? `task-review-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const taskId = String(input.taskId ?? "");
    const round = Number(input.round ?? 1);
    const spec = input.spec;
    const quality = input.quality;
    if (!workflowId || !SAFE_ID_RE10.test(workflowId)) {
      return failure("task-review", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!taskId || !SAFE_ID_RE10.test(taskId)) {
      return failure("task-review", "taskId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!Number.isInteger(round) || round <= 0) {
      return failure("task-review", "round must be a positive integer", { operationId: opId, retryable: false });
    }
    if (!spec || typeof spec !== "object" || !VERDICT_VALUES.has(String(spec.verdict ?? ""))) {
      return failure("task-review", "spec verdict required (pass|fail|none)", { operationId: opId, retryable: false });
    }
    if (!quality || typeof quality !== "object" || !VERDICT_VALUES.has(String(quality.verdict ?? ""))) {
      return failure("task-review", "quality verdict required (pass|fail|none)", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeChildCall(
      deps.repoRoot,
      workflowId,
      ROLES.TASK_REVIEWER,
      { taskId, round },
      ctx
    );
    if (!auth.ok) {
      return failure("task-review", `task-reviewer authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const lock = await readLock2(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("task-review", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("task-review", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("task-review", "run not started", { operationId: opId, retryable: false });
    }
    const reviewHash = verdictHash({ spec, quality, taskId, round });
    const priorEvent = runState.events.find((event) => event.kind === RUN_EVENT_KINDS.TASK_REVIEW && event.data?.reviewHash === reviewHash);
    if (priorEvent) {
      return success2("task-review", {
        workflowId,
        taskId,
        round,
        reviewerSessionID: auth.sessionID,
        reviewHash,
        state: runState.state,
        sequence: priorEvent.sequence
      }, { operationId: opId, idempotent: true });
    }
    if (runState.activeTask !== taskId) {
      return failure("task-review", `no active task ${taskId} (active=${runState.activeTask})`, { operationId: opId, retryable: false });
    }
    try {
      const specPass = String(spec.verdict) === "pass";
      const qualityPass = String(quality.verdict) === "pass";
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const reviewDir = join17(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", taskId, "rounds", `${String(round).padStart(4, "0")}`);
      await mkdir14(reviewDir, { recursive: true });
      const record2 = {
        workflowId,
        taskId,
        round,
        reviewerSessionID: auth.sessionID,
        spec,
        quality,
        state: specPass && qualityPass ? "commit-pending" : "fix-pending",
        reviewedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const reviewPath = join17(reviewDir, "review.json");
      if (existsSync13(reviewPath)) {
        const existing = JSON.parse(await readFile14(reviewPath, "utf8"));
        if (existing.workflowId !== workflowId || existing.taskId !== taskId || existing.round !== round || existing.reviewerSessionID !== auth.sessionID || JSON.stringify(existing.spec) !== JSON.stringify(spec) || JSON.stringify(existing.quality) !== JSON.stringify(quality)) {
          return failure("task-review", "immutable task review conflicts with retry", { operationId: opId, retryable: false });
        }
      } else {
        await publishImmutableJson(reviewPath, record2);
      }
      const verdict = specPass && qualityPass ? "pass" : "fail";
      const { state, event } = await appendRunEvent(
        deps.repoRoot,
        workflowId,
        runState,
        {
          kind: RUN_EVENT_KINDS.TASK_REVIEW,
          data: { taskId, verdict, reviewHash, round, sessionID: auth.sessionID }
        }
      );
      return success2("task-review", {
        workflowId,
        taskId,
        round,
        reviewerSessionID: auth.sessionID,
        reviewHash,
        state: state.state,
        sequence: event.sequence
      }, { operationId: opId });
    } catch (err) {
      return failure("task-review", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
function verdictHash(record2) {
  const sorted = Object.keys(record2).sort();
  const ordered = {};
  for (const k of sorted) ordered[k] = record2[k];
  return createHash14("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

// src/tools/ship-final-review.js
import { mkdir as mkdir15, readFile as readFile15 } from "node:fs/promises";
import { existsSync as existsSync14 } from "node:fs";
import { join as join18 } from "node:path";
init_durable_store();
var SAFE_ID_RE11 = /^[A-Za-z0-9._-]{1,128}$/;
var AXES = /* @__PURE__ */ new Set(["standards", "spec"]);
var VERDICTS = /* @__PURE__ */ new Set(["pass", "fail", "blocked"]);
var ROLE_FOR_AXIS = {
  standards: ROLES.FINAL_STANDARDS,
  spec: ROLES.FINAL_SPEC
};
function createFinalReviewTool(deps) {
  return async function finalReview(input) {
    const opId = input.operationId ?? `final-review-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const axis = String(input.axis ?? "");
    const verdict = String(input.verdict ?? "");
    const headSha = String(input.headSha ?? "");
    const mergeBaseSha = String(input.mergeBaseSha ?? "");
    const packageHash = String(input.packageHash ?? "");
    const findings = Array.isArray(input.findings) ? input.findings : [];
    if (!workflowId || !SAFE_ID_RE11.test(workflowId)) {
      return failure("final-review", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!AXES.has(axis)) {
      return failure("final-review", "axis must be 'standards' or 'spec'", { operationId: opId, retryable: false });
    }
    if (!VERDICTS.has(verdict)) {
      return failure("final-review", "verdict must be one of pass|fail|blocked", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      return failure("final-review", "headSha required (40-char commit SHA)", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{40}$/.test(mergeBaseSha)) {
      return failure("final-review", "mergeBaseSha required (40-char commit SHA)", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{64}$/.test(packageHash)) {
      return failure("final-review", "packageHash required (sha256)", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeChildCall(
      deps.repoRoot,
      workflowId,
      ROLE_FOR_AXIS[axis],
      { packageHash },
      ctx
    );
    if (!auth.ok) {
      return failure("final-review", `final reviewer authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const lock = await readLock2(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("final-review", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("final-review", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("final-review", "run not started", { operationId: opId, retryable: false });
    }
    if (runState.state !== "all-tasks-done" && runState.state !== "ready-pending") {
      return failure("final-review", `final review requires all-tasks-done; run state=${runState.state}`, { operationId: opId, retryable: false });
    }
    try {
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const packagePath = join18(opencodeShipStateDir(commonDir), "runs", workflowId, "final-review", "package.json");
      if (!existsSync14(packagePath)) {
        return failure("final-review", "canonical final review package is missing", { operationId: opId, retryable: false });
      }
      const finalPackage = JSON.parse(await readFile15(packagePath, "utf8"));
      if (hashFinalReviewPackage(finalPackage) !== finalPackage.packageHash) {
        return failure("final-review", "canonical final review package hash is invalid", { operationId: opId, retryable: false });
      }
      if (finalPackage.packageHash !== packageHash || finalPackage.headSha !== headSha || finalPackage.mergeBaseSha !== mergeBaseSha) {
        return failure("final-review", "review input does not match the canonical final review package", { operationId: opId, retryable: false });
      }
      const reviewDir = join18(opencodeShipStateDir(commonDir), "runs", workflowId, "final-review", axis);
      await mkdir15(reviewDir, { recursive: true });
      let record2 = {
        workflowId,
        axis,
        verdict,
        headSha,
        mergeBaseSha,
        packageHash,
        reviewerSessionID: auth.sessionID,
        reviewerModel: String(deps.config?.workflow?.models?.finalReviewer ?? "unknown/unknown"),
        findings,
        reviewedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const reviewPath = join18(reviewDir, "review.json");
      if (existsSync14(reviewPath)) {
        record2 = JSON.parse(await readFile15(reviewPath, "utf8"));
        if (record2.axis !== axis || record2.verdict !== verdict || record2.headSha !== headSha || record2.mergeBaseSha !== mergeBaseSha || record2.packageHash !== packageHash || record2.reviewerSessionID !== auth.sessionID || hashAxisRecord(
          /** @type {any} */
          record2
        ) !== record2.reviewHash) {
          return failure("final-review", "immutable final review record conflicts with retry", { operationId: opId, retryable: false });
        }
      } else {
        record2.reviewHash = hashAxisRecord(
          /** @type {any} */
          record2
        );
        await publishImmutableJson(reviewPath, record2);
      }
      if (runState.finalReview?.[axis]?.reviewHash === record2.reviewHash) {
        return success2("final-review", {
          workflowId,
          axis,
          verdict,
          headSha,
          reviewerSessionID: auth.sessionID,
          state: runState.state,
          sequence: runState.events.at(-1)?.sequence ?? 0,
          finalReview: runState.finalReview
        }, { operationId: opId, idempotent: true });
      }
      const { state, event } = await appendRunEvent(
        deps.repoRoot,
        workflowId,
        runState,
        {
          kind: RUN_EVENT_KINDS.FINAL_REVIEW,
          data: {
            axis,
            verdict,
            headSha,
            mergeBaseSha,
            packageHash,
            sessionID: auth.sessionID,
            review: { verdict, headSha, mergeBaseSha, packageHash, reviewHash: record2.reviewHash }
          }
        }
      );
      return success2("final-review", {
        workflowId,
        axis,
        verdict,
        headSha,
        reviewerSessionID: auth.sessionID,
        state: state.state,
        sequence: event.sequence,
        finalReview: state.finalReview ?? null
      }, { operationId: opId });
    } catch (err) {
      return failure("final-review", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/workflow/resume.js
import { readdir as readdir6, mkdir as mkdir16 } from "node:fs/promises";
import { existsSync as existsSync15 } from "node:fs";
import { join as join19 } from "node:path";
init_durable_store();
function parseTrailer(text, key) {
  if (typeof text !== "string") return null;
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}
async function reconstructCompletedTasksFromGitTrailers(repoRoot, workflowId) {
  const cp = await import("node:child_process");
  return new Promise((resolveRun) => {
    cp.execFile("git", ["log", "-n", "200", "--format=%H%n%B%n--END--"], { cwd: repoRoot }, (err, stdout) => {
      if (err || !stdout) return resolveRun([]);
      const commits = stdout.split("--END--").map((s) => s.trim()).filter(Boolean);
      const completed = [];
      for (const block of commits) {
        const [sha, ...body] = block.split("\n");
        const bodyText = body.join("\n");
        const wf = parseTrailer(bodyText, "Opencode-Ship-Workflow");
        const taskId = parseTrailer(bodyText, "Opencode-Ship-Task");
        if (wf === workflowId && taskId) {
          completed.push([taskId, sha]);
        }
      }
      resolveRun(completed);
    });
  });
}
async function lockRun(repoRoot, workflowId, callback) {
  const common = await resolveGitCommonDir(repoRoot);
  const stateRoot = opencodeShipStateDir(common);
  const lockKey = `run:${workflowId}`;
  return withResourceLock(stateRoot, lockKey, callback);
}
async function resumeRun(repoRoot, workflowId) {
  return lockRun(repoRoot, workflowId, async () => {
    const run = await readRunState(repoRoot, workflowId);
    if (!run) {
      const plan = await readPlanRevision(repoRoot, workflowId, 1);
      if (plan) {
        const completed = await reconstructCompletedTasksFromGitTrailers(repoRoot, workflowId);
        return {
          state: {
            workflowId,
            revision: 1,
            sha256: plan.hash,
            state: "reconstructed",
            activeTask: null,
            round: 0,
            completedTasks: completed,
            events: []
          },
          nextAction: "run-start",
          mirrored: false
        };
      }
      return {
        state: { workflowId, state: "missing", completedTasks: [], events: [] },
        nextAction: "plan-start",
        mirrored: false
      };
    }
    let nextAction = "task-report";
    if (run.state === "running") nextAction = "task-report";
    else if (run.state === "commit-pending") nextAction = "commit";
    else if (run.state === "committed") nextAction = "task-complete";
    else if (run.state === "fix-pending") nextAction = "task-dispatch";
    else if (run.state === "ready") nextAction = "merge";
    else if (run.state === "merged") nextAction = "done";
    else if (run.state === "blocked") nextAction = "blocked";
    return { state: run, nextAction, mirrored: false };
  });
}

// src/tools/ship-resume.js
var SAFE_ID_RE12 = /^[A-Za-z0-9._-]{1,128}$/;
function createResumeTool(deps) {
  return async function resume(input) {
    const opId = input.operationId ?? `resume-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    if (!workflowId || !SAFE_ID_RE12.test(workflowId)) {
      return failure("resume", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    if (!ctx || typeof ctx.sessionID !== "string" || ctx.agent !== "ship-controller") {
      return failure("resume", "ToolContext must identify the ship-controller session", { operationId: opId, retryable: false });
    }
    try {
      const result = await withControllerLease(
        deps.repoRoot,
        workflowId,
        ctx.sessionID,
        () => resumeRun(deps.repoRoot, workflowId)
      );
      return success2("resume", {
        workflowId,
        state: result.state,
        nextAction: result.nextAction,
        mirrored: result.mirrored ?? false
      }, { operationId: opId });
    } catch (err) {
      return failure("resume", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/tools/ship-status.js
import { readFile as readFile16, readdir as readdir7 } from "node:fs/promises";
import { existsSync as existsSync16 } from "node:fs";
import { join as join20 } from "node:path";
function createStatusTool(deps) {
  return async function status(input) {
    const opId = input.operationId ?? `status-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    if (!workflowId) return failure("status", "workflowId required", { operationId: opId, retryable: false });
    try {
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const planRoot = join20(opencodeShipStateDir(commonDir), "plans", workflowId);
      const runRoot = join20(opencodeShipStateDir(commonDir), "runs", workflowId);
      const indexPath = join20(planRoot, "index.json");
      if (!existsSync16(indexPath)) return failure("status", "no workflow record", { operationId: opId, retryable: false });
      const index = JSON.parse(await readFile16(indexPath, "utf8"));
      let run = null;
      const runPath = join20(runRoot, "run.json");
      if (existsSync16(runPath)) run = JSON.parse(await readFile16(runPath, "utf8"));
      let lastEvent = null;
      const eventsDir = join20(runRoot, "events");
      if (existsSync16(eventsDir)) {
        const events = await readdir7(eventsDir);
        const sorted = events.filter((n) => n.endsWith(".json")).sort();
        if (sorted.length > 0) {
          lastEvent = JSON.parse(await readFile16(join20(eventsDir, sorted[sorted.length - 1]), "utf8"));
        }
      }
      return success2("status", { workflowId, index, run, lastEvent }, { operationId: opId });
    } catch (err) {
      return failure("status", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

// src/skills/registry.js
import { spawn as spawn7 } from "node:child_process";
import { readFile as readFile17, writeFile as writeFile8, mkdir as mkdir17 } from "node:fs/promises";
import { resolve as resolve11, dirname as dirname7 } from "node:path";
import { createHash as createHash15 } from "node:crypto";

// src/tools/skill-discovery.js
import { spawn as spawn6 } from "node:child_process";
import { existsSync as existsSync17, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname as dirname6, join as join21, normalize, resolve as resolve10, sep } from "node:path";
var DEFAULT_TRUSTED_OWNERS = Object.freeze([
  "vercel-labs",
  "anthropics",
  "obra",
  "mattpocock",
  "ComposioHQ"
]);
function runCapture(cmd, args, options) {
  const cwd = options?.cwd;
  const timeoutMs = options?.timeoutMs ?? 6e4;
  return new Promise((resolveP, rejectP) => {
    const child = spawn6(cmd, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error(`skill-discovery: timeout running '${cmd} ${args.join(" ")}'`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
  });
}
async function discoverSkills({ repoRoot, query, npmBin = "npx" }) {
  if (!repoRoot || !query) {
    return { ok: false, error: { kind: "missing-args" } };
  }
  const r = await runCapture(npmBin, ["skills", "find", query], { cwd: repoRoot, timeoutMs: 6e4 });
  if (r.code !== 0 && !r.stdout.trim()) {
    return { ok: false, error: { kind: "registry-unavailable", stderr: r.stderr } };
  }
  return { ok: true, candidates: parseFindOutput(r.stdout), raw: r.stdout };
}
function parseFindOutput(text) {
  const lines = text.split(/\r?\n/);
  const candidates = [];
  for (const line of lines) {
    const match = line.match(/^\s*([a-zA-Z0-9_.\-]+)\s+([a-zA-Z0-9_.\-/]+)\s+([0-9]+)\s*$/);
    if (!match) continue;
    candidates.push({
      skill: match[1],
      package: match[2],
      installs: Number.parseInt(match[3], 10)
    });
  }
  return candidates;
}

// src/skills/registry.js
var SKILLS_CLI_TIMEOUT_MS = 60 * 1e3;
var SKILLS_INSTALL_TIMEOUT_MS = 120 * 1e3;
async function listSkills({ repoRoot, query, npmBin = "npx" }) {
  return discoverSkills({ repoRoot, query, npmBin });
}

// src/skills/policy.js
import { readFile as readFile18, writeFile as writeFile9 } from "node:fs/promises";
import { existsSync as existsSync18 } from "node:fs";
import { resolve as resolve12 } from "node:path";
var DEFAULT_TRUSTED_OWNERS2 = Object.freeze([
  "vercel-labs",
  "anthropics",
  "obra",
  "mattpocock",
  "ComposioHQ"
]);
var DEFAULT_MIN_INSTALLS = 1e3;
var MAX_TRUSTED_PER_RUN = 5;
var POLICY_PATH = ".opencode/ship.skills.policy.json";
function policyPath(repoRoot) {
  return resolve12(repoRoot, POLICY_PATH);
}
function defaultPolicy() {
  return {
    trustedOwners: [...DEFAULT_TRUSTED_OWNERS2],
    minInstalls: DEFAULT_MIN_INSTALLS,
    blocklist: [],
    maxTrustedPerRun: MAX_TRUSTED_PER_RUN
  };
}
async function readPolicy(repoRoot) {
  const path = policyPath(repoRoot);
  if (!existsSync18(path)) return defaultPolicy();
  try {
    const raw = await readFile18(path, "utf8");
    const parsed = JSON.parse(raw);
    return mergePolicy(defaultPolicy(), parsed);
  } catch {
    return defaultPolicy();
  }
}
function mergePolicy(base, override) {
  const out = { ...base };
  if (Array.isArray(override?.trustedOwners)) {
    out.trustedOwners = [...new Set(override.trustedOwners)];
  }
  if (Number.isInteger(override?.minInstalls)) {
    out.minInstalls = override.minInstalls;
  }
  if (Array.isArray(override?.blocklist)) {
    out.blocklist = [...new Set(override.blocklist)];
  }
  if (Number.isInteger(override?.maxTrustedPerRun)) {
    out.maxTrustedPerRun = override.maxTrustedPerRun;
  }
  return out;
}
function isAutoInstallable(candidate, policy) {
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, reason: "missing-candidate" };
  }
  if ((policy.blocklist ?? []).includes(candidate.package)) {
    return { ok: false, reason: "blocked" };
  }
  const owner = String(candidate.package).split("/")[0];
  if (!(policy.trustedOwners ?? []).includes(owner)) {
    return { ok: false, reason: "untrusted-owner" };
  }
  if (candidate.installs < (policy.minInstalls ?? DEFAULT_MIN_INSTALLS)) {
    return { ok: false, reason: "below-threshold" };
  }
  return { ok: true };
}

// src/tools/ship-skill-discover.js
function createSkillDiscoverTool(deps) {
  return async function skillDiscover(input) {
    const opId = input.operationId ?? `skill-discover-${Date.now().toString(36)}`;
    const query = String(input.query ?? "");
    if (!query) {
      return failure("skill-discover", "query required", { operationId: opId, retryable: false });
    }
    let policy;
    try {
      policy = await readPolicy(deps.repoRoot);
    } catch (err) {
      return failure("skill-discover", `policy unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    let result;
    try {
      result = await listSkills({ repoRoot: deps.repoRoot, query });
    } catch (err) {
      return failure("skill-discover", `registry unavailable: ${err?.message ?? err}`, { operationId: opId, retryable: true });
    }
    if (!result.ok) {
      return failure("skill-discover", result.error?.kind ?? "registry-unavailable", { operationId: opId, retryable: true });
    }
    const auto = [];
    const needsApproval = [];
    let autoCount = 0;
    for (const candidate of result.candidates ?? []) {
      if (policy.blocklist.includes(candidate.package)) continue;
      const decision = isAutoInstallable(candidate, policy);
      if (decision.ok && autoCount < policy.maxTrustedPerRun) {
        auto.push(candidate);
        autoCount += 1;
      } else {
        needsApproval.push({ ...candidate, reason: decision.reason ?? "needs-approval" });
      }
    }
    return success2("skill-discover", {
      query,
      policy,
      auto,
      needsApproval,
      total: (result.candidates ?? []).length
    }, { operationId: opId });
  };
}

// src/tools/ship-skill-install.js
import { readFile as readFile20, writeFile as writeFile11, mkdir as mkdir19, rm, rename as rename5, stat as stat2 } from "node:fs/promises";
import { existsSync as existsSync21 } from "node:fs";
import { resolve as resolve15, join as join23, dirname as dirname10, sep as sep3, isAbsolute as isAbsolute3 } from "node:path";
import { createHash as createHash17 } from "node:crypto";
import { execFile as execFile5 } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes as randomBytes3 } from "node:crypto";

// src/skills/inventory.js
import { readFile as readFile19, writeFile as writeFile10, mkdir as mkdir18, rename as rename4 } from "node:fs/promises";
import { existsSync as existsSync19 } from "node:fs";
import { resolve as resolve13, dirname as dirname8, isAbsolute, posix as posix2 } from "node:path";
import { createHash as createHash16 } from "node:crypto";
var INVENTORY_PATH = ".opencode/ship.skills.lock.json";
var INVENTORY_SCHEMA = 2;
function inventoryPath(repoRoot) {
  return resolve13(repoRoot, INVENTORY_PATH);
}
async function readInventory(repoRoot) {
  const path = inventoryPath(repoRoot);
  if (!existsSync19(path)) {
    return { schemaVersion: INVENTORY_SCHEMA, events: [] };
  }
  let raw;
  try {
    raw = await readFile19(path, "utf8");
  } catch (err) {
    return { schemaVersion: INVENTORY_SCHEMA, events: [], parseError: `read failed: ${err?.message ?? err}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { schemaVersion: INVENTORY_SCHEMA, events: [], parseError: `malformed JSON: ${err?.message ?? err}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { schemaVersion: INVENTORY_SCHEMA, events: [], parseError: "inventory root is not an object" };
  }
  if (!Array.isArray(parsed.events)) {
    return { schemaVersion: INVENTORY_SCHEMA, events: [], parseError: "inventory.events is not an array" };
  }
  if (parsed.schemaVersion !== INVENTORY_SCHEMA) {
    return {
      schemaVersion: parsed.schemaVersion,
      events: [],
      parseError: `unsupported inventory schemaVersion ${parsed.schemaVersion} (expected ${INVENTORY_SCHEMA})`
    };
  }
  return { schemaVersion: INVENTORY_SCHEMA, events: parsed.events };
}
async function writeInventory(repoRoot, inventory) {
  const path = inventoryPath(repoRoot);
  await mkdir18(dirname8(path), { recursive: true });
  const tmp = `${path}.${Date.now().toString(36)}.tmp`;
  await writeFile10(tmp, JSON.stringify({ schemaVersion: INVENTORY_SCHEMA, events: inventory.events }, null, 2) + "\n", "utf8");
  await rename4(tmp, path);
  return path;
}
function canonicalize3(value) {
  const seen = /* @__PURE__ */ new WeakSet();
  const sort = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(sort);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
    return out;
  };
  return JSON.stringify(sort(value));
}
function hashEvent(event) {
  return createHash16("sha256").update(canonicalize3(event), "utf8").digest("hex");
}
async function appendEvent2(repoRoot, eventInput) {
  const inventory = await readInventory(repoRoot);
  if (inventory.parseError) {
    throw new Error(`inventory is unreadable: ${inventory.parseError}`);
  }
  const existingChain = await verifyInventory(repoRoot);
  if (!existingChain.ok) {
    throw new Error(`inventory chain invalid: ${existingChain.reason}`);
  }
  const previousHash = inventory.events.length > 0 ? inventory.events[inventory.events.length - 1].hash : "0".repeat(64);
  const sequence = inventory.events.length + 1;
  if (eventInput.destination && isAbsolute(eventInput.destination)) {
    throw new Error(`inventory refuses absolute destination: ${eventInput.destination}`);
  }
  const base = {
    sequence,
    type: eventInput.type,
    previousHash,
    recordedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const {
    hash: _hash,
    sequence: _sequence,
    previousHash: _previousHash,
    recordedAt: _recordedAt,
    payload: legacyPayload,
    type: _type,
    ...fields
  } = eventInput;
  const payload = { ...legacyPayload ?? {}, ...fields, ...base };
  const shape = validateEventShape(payload);
  if (!shape.ok) throw new Error(shape.reason);
  delete payload.hash;
  const stamped = { ...payload, hash: hashEvent(payload) };
  inventory.events.push(stamped);
  await writeInventory(repoRoot, inventory);
  return stamped;
}
async function verifyInventory(repoRoot) {
  const inventory = await readInventory(repoRoot);
  if (inventory.parseError) {
    return { ok: false, reason: inventory.parseError };
  }
  if (inventory.events.length === 0) return { ok: true, count: 0 };
  let prev = "0".repeat(64);
  for (const ev of inventory.events) {
    const shape = validateEventShape(ev);
    if (!shape.ok) {
      return { ok: false, reason: shape.reason, sequence: ev.sequence };
    }
    if (ev.sequence !== inventory.events.indexOf(ev) + 1) {
      return { ok: false, reason: "sequence-gap", sequence: ev.sequence };
    }
    if (ev.previousHash !== prev) {
      return { ok: false, reason: "chain-break", sequence: ev.sequence };
    }
    const { hash: _h, ...rest } = ev;
    const recomputed = hashEvent(rest);
    if (recomputed !== ev.hash) {
      return { ok: false, reason: "hash-mismatch", sequence: ev.sequence };
    }
    prev = ev.hash;
  }
  return { ok: true, count: inventory.events.length };
}
function validateEventShape(event) {
  if (event?.type !== "install" && event?.type !== "uninstall") {
    return { ok: false, reason: `unsupported inventory event type: ${JSON.stringify(event?.type)}` };
  }
  if (typeof event.skill !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(event.skill)) {
    return { ok: false, reason: `invalid skill id: ${JSON.stringify(event.skill)}` };
  }
  if (!isSafeRelativePosix(event.destination)) {
    return { ok: false, reason: `unsafe destination: ${JSON.stringify(event.destination)}` };
  }
  if (event.type === "install") {
    if (!Array.isArray(event.files)) return { ok: false, reason: "install event files must be an array" };
    for (const file2 of event.files) {
      if (!file2 || !isSafeRelativePosix(file2.path)) {
        return { ok: false, reason: `unsafe file path: ${JSON.stringify(file2?.path)}` };
      }
      if (typeof file2.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file2.sha256)) {
        return { ok: false, reason: `invalid file sha256: ${JSON.stringify(file2.sha256)}` };
      }
    }
  }
  return { ok: true };
}
function isSafeRelativePosix(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) return false;
  if (posix2.isAbsolute(value) || posix2.normalize(value) !== value) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
async function findActiveInstall(repoRoot, skillName) {
  const inventory = await readInventory(repoRoot);
  const chain = await verifyInventory(repoRoot);
  if (!chain.ok) {
    return { ok: false, reason: chain.reason };
  }
  for (let i = inventory.events.length - 1; i >= 0; i--) {
    const ev = inventory.events[i];
    if (ev.type === "uninstall" && ev.skill === skillName) {
      return { ok: true, install: null, uninstallHash: ev.hash };
    }
    if (ev.type === "install" && ev.skill === skillName) {
      return { ok: true, install: ev, uninstallHash: null };
    }
  }
  return { ok: true, install: null, uninstallHash: null };
}

// src/skills/worktree.js
import { execFile as execFile4 } from "node:child_process";
import { promises as fs, existsSync as existsSync20 } from "node:fs";
import { resolve as resolve14, dirname as dirname9, sep as sep2, isAbsolute as isAbsolute2, join as join22 } from "node:path";
function listRegisteredWorktrees(mainRepo) {
  return new Promise((resolveP, rejectP) => {
    execFile4(
      "git",
      ["-C", mainRepo, "worktree", "list", "--porcelain", "-z"],
      { shell: false, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return rejectP(err);
        const records = parsePorcelain(stdout);
        const mainRecord = records.shift();
        const mainPath = mainRecord?.worktree ? resolve14(mainRecord.worktree) : null;
        const linked = [];
        for (const r of records) {
          if (!r.worktree) continue;
          const p = resolve14(r.worktree);
          if (mainPath && p === mainPath) continue;
          linked.push({ path: p, branch: r.HEAD ?? null });
        }
        resolveP(linked);
      }
    );
  });
}
function parsePorcelain(text) {
  const tokens = text.split("\0");
  const out = [];
  let current = {};
  for (const tok of tokens) {
    if (tok.length === 0) {
      if (Object.keys(current).length > 0) {
        out.push(current);
        current = {};
      }
      continue;
    }
    const idx = tok.indexOf(" ");
    const key = idx === -1 ? tok : tok.slice(0, idx);
    const value = idx === -1 ? "" : tok.slice(idx + 1);
    if (key === "branch") {
      current.HEAD = value.startsWith("refs/heads/") ? value : `refs/heads/${value}`;
    } else {
      current[key] = value;
    }
  }
  if (Object.keys(current).length > 0) out.push(current);
  return out;
}
async function validateLinkedWorktree(mainRepo, worktreePath) {
  const main = resolve14(mainRepo);
  if (!existsSync20(main)) {
    return { ok: false, kind: "missing", message: `main repository ${main} does not exist` };
  }
  if (!worktreePath) {
    return { ok: false, kind: "unlinked", message: "worktreePath is required" };
  }
  const wt = resolve14(worktreePath);
  if (!existsSync20(wt)) {
    return { ok: false, kind: "missing", message: `worktree ${wt} does not exist` };
  }
  if (wt === main) {
    return { ok: false, kind: "main", message: "installs into the main worktree are forbidden" };
  }
  let cursor = wt;
  while (cursor !== dirname9(cursor)) {
    const stat3 = await fs.lstat(cursor).catch(() => null);
    if (stat3?.isSymbolicLink()) {
      return {
        ok: false,
        kind: "ancestor-symlink",
        message: `worktree path contains a symlink at ${cursor}`
      };
    }
    cursor = dirname9(cursor);
  }
  const real = await fs.realpath(wt).catch(() => null);
  if (real && real !== wt) {
    return {
      ok: false,
      kind: "symlink",
      message: `worktree ${wt} resolves through a symlink to ${real}`
    };
  }
  const linked = await listRegisteredWorktrees(main);
  const matched = linked.find((entry) => entry.path === wt);
  if (!matched) {
    return {
      ok: false,
      kind: "unlinked",
      message: `worktree ${wt} is not registered (git worktree list)`
    };
  }
  return { ok: true, path: wt, registered: !!matched };
}
function validateRelativeInstallPath(destRel) {
  if (typeof destRel !== "string" || destRel.length === 0) {
    return { ok: false, kind: "absolute", message: "destination path required" };
  }
  if (isAbsolute2(destRel)) {
    return { ok: false, kind: "absolute", message: `destination must be relative: ${destRel}` };
  }
  if (destRel.includes("\\")) {
    return { ok: false, kind: "parent-relative", message: `destination must use POSIX separators: ${destRel}` };
  }
  const parts = destRel.split("/");
  for (const p of parts) {
    if (p === "" || p === "." || p === "..") {
      return { ok: false, kind: "parent-relative", message: `destination escapes worktree: ${destRel}` };
    }
  }
  return { ok: true };
}
async function validateInstallDestination(worktreeRoot, destRel) {
  const relativeCheck = validateRelativeInstallPath(destRel);
  if (!relativeCheck.ok) return relativeCheck;
  const root = resolve14(worktreeRoot);
  const destination = resolve14(root, ...destRel.split("/"));
  if (destination !== root && !destination.startsWith(root + sep2)) {
    return { ok: false, kind: "escape", message: `destination escapes worktree: ${destRel}` };
  }
  let cursor = root;
  for (const part of destRel.split("/")) {
    cursor = join22(cursor, part);
    const entry = await fs.lstat(cursor).catch(() => null);
    if (!entry) continue;
    if (entry.isSymbolicLink()) {
      return { ok: false, kind: "symlink", message: `destination path contains a symlink at ${cursor}` };
    }
    if (cursor !== destination && !entry.isDirectory()) {
      return { ok: false, kind: "not-directory", message: `destination ancestor is not a directory: ${cursor}` };
    }
  }
  return { ok: true, path: destination };
}

// src/tools/ship-skill-install.js
var SAFE_ID_RE13 = /^[A-Za-z0-9._-]{1,128}$/;
var SAFE_NAME_RE = /^[A-Za-z0-9._/-]{1,160}$/;
var SAFE_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;
var SKILLS_CLI_VERSION = "1.0.4";
function createSkillInstallTool(deps) {
  return async function skillInstall(input) {
    const opId = input.operationId ?? `skill-install-${Date.now().toString(36)}`;
    const packageSpec = String(input.package ?? "");
    const worktreePath = String(input.worktreePath ?? "");
    const skillName = String(input.skillName ?? "");
    const version2 = String(input.version ?? "");
    if (!packageSpec || !SAFE_NAME_RE.test(packageSpec)) {
      return failure("skill-install", "package required (safe npm spec)", { operationId: opId, retryable: false });
    }
    if (!worktreePath) {
      return failure("skill-install", "worktreePath required (must be the active issue worktree)", { operationId: opId, retryable: false });
    }
    if (!skillName || !SAFE_ID_RE13.test(skillName)) {
      return failure("skill-install", "skillName required (safe id)", { operationId: opId, retryable: false });
    }
    if (version2 && !SAFE_VERSION_RE.test(version2)) {
      return failure("skill-install", "version must match a safe semver spec", { operationId: opId, retryable: false });
    }
    const policy = await readPolicy(deps.repoRoot);
    const ownerCandidate = {
      package: packageSpec,
      skill: skillName,
      installs: Number.MAX_SAFE_INTEGER
    };
    const ownerDecision = isAutoInstallable(ownerCandidate, policy);
    if (!ownerDecision.ok) {
      return failure("skill-install", `policy forbids install: ${ownerDecision.reason}`, { operationId: opId, retryable: false });
    }
    const wtCheck = await validateLinkedWorktree(deps.repoRoot, worktreePath);
    if (!wtCheck.ok) {
      return failure("skill-install", `worktree rejected: ${wtCheck.message}`, { operationId: opId, retryable: false });
    }
    const destRel = `.opencode/skills/${skillName}`;
    const pathCheck = validateRelativeInstallPath(destRel);
    if (!pathCheck.ok) {
      return failure("skill-install", `destination rejected: ${pathCheck.message}`, { operationId: opId, retryable: false });
    }
    const destinationCheck = await validateInstallDestination(wtCheck.path, destRel);
    if (!destinationCheck.ok) {
      return failure("skill-install", `destination rejected: ${destinationCheck.message}`, { operationId: opId, retryable: false });
    }
    const destAbs = destinationCheck.path;
    if (existsSync21(destAbs)) {
      return failure("skill-install", "destination already exists; use ship_skill_audit to detect drift", { operationId: opId, retryable: false });
    }
    const managedCatalog = (deps.config?.value?.skills ?? []).map((s) => s?.name).filter(Boolean);
    if (managedCatalog.includes(skillName)) {
      return failure("skill-install", "candidate shadows a managed skill", { operationId: opId, retryable: false });
    }
    const discover = deps.discoverSkills ?? listSkills;
    const discovery = await discover({ repoRoot: deps.repoRoot, query: packageSpec });
    if (!discovery?.ok) {
      return failure("skill-install", "registry metadata unavailable; refusing unverified install", { operationId: opId, retryable: true });
    }
    const candidate = discovery.candidates?.find((entry) => entry.package === packageSpec && entry.skill === skillName);
    if (!candidate) {
      return failure("skill-install", "exact skill package was not found in registry metadata", { operationId: opId, retryable: false });
    }
    const decision = isAutoInstallable(candidate, policy);
    if (!decision.ok) {
      return failure("skill-install", `policy forbids install: ${decision.reason}`, { operationId: opId, retryable: false });
    }
    const stage = await mkdtemp(join23(tmpdir(), `ship-skill-stage-${randomBytes3(4).toString("hex")}-`));
    let installedFiles;
    try {
      const materialise = deps.materialiseFromSkillsCli ?? materialiseFromSkillsCli;
      installedFiles = await materialise({
        packageSpec,
        skillName,
        version: version2,
        stageDir: stage
      });
      if (!installedFiles.ok) {
        return failure("skill-install", installedFiles.message, { operationId: opId, retryable: installedFiles.retryable ?? false });
      }
      const fileRecords = await hashDir(installedFiles.stagedDir);
      if (fileRecords.length === 0) {
        return failure("skill-install", "skills CLI produced an empty staging directory", { operationId: opId, retryable: false });
      }
      await mkdir19(dirname10(destAbs), { recursive: true });
      const destTmp = `${destAbs}.${randomBytes3(4).toString("hex")}.tmp`;
      await copyDir(installedFiles.stagedDir, destTmp);
      const finalDestinationCheck = await validateInstallDestination(wtCheck.path, destRel);
      if (!finalDestinationCheck.ok) {
        await rm(destTmp, { recursive: true, force: true });
        return failure("skill-install", `destination rejected: ${finalDestinationCheck.message}`, { operationId: opId, retryable: false });
      }
      await rename5(destTmp, destAbs);
      const onDisk = await hashDir(destAbs);
      if (!hashesEqual(fileRecords, onDisk)) {
        await rm(destAbs, { recursive: true, force: true });
        return failure("skill-install", "drift detected after copy; rolled back", { operationId: opId, retryable: false });
      }
      const recorded = await appendEvent2(wtCheck.path, {
        type: "install",
        skill: skillName,
        package: packageSpec,
        version: version2 || null,
        source: installedFiles.source,
        destination: destRel,
        files: fileRecords
      });
      return success2("skill-install", {
        skill: skillName,
        package: packageSpec,
        version: version2 || null,
        destination: destRel,
        worktree: wtCheck.path,
        source: installedFiles.source,
        files: fileRecords,
        sequence: recorded.sequence
      }, { operationId: opId });
    } catch (err) {
      if (existsSync21(destAbs)) {
        await rm(destAbs, { recursive: true, force: true }).catch(() => null);
      }
      return failure("skill-install", String(err?.message ?? err), { operationId: opId, retryable: true });
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => null);
    }
  };
}
async function materialiseFromSkillsCli({ packageSpec, skillName, version: version2, stageDir }) {
  const cliPkg = `skills@${SKILLS_CLI_VERSION}`;
  const resolvedPackageSpec = version2 ? `${packageSpec}@${version2}` : packageSpec;
  const args = [
    "exec",
    "--yes",
    `--package=${cliPkg}`,
    "--",
    "skills",
    "add",
    resolvedPackageSpec,
    "--skill",
    skillName,
    "--agent",
    "opencode",
    "--copy",
    "-y"
  ];
  const result = await new Promise((resolveP, rejectP) => {
    execFile5(
      "npm",
      args,
      { cwd: stageDir, shell: false, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err?.code === "number" ? err.code : -1;
          return resolveP({
            ok: false,
            retryable: code === -2 || code === 124,
            message: `skills CLI failed (code ${code}): ${(stderr || stdout || "").toString().trim().split("\n").slice(-5).join(" | ")}`
          });
        }
        resolveP({ ok: true, stdout: stdout?.toString?.() ?? "", stderr: stderr?.toString?.() ?? "" });
      }
    );
  });
  if (!result.ok) return result;
  const stagedDir = join23(stageDir, ".opencode", "skills", skillName);
  if (!existsSync21(stagedDir)) {
    return {
      ok: false,
      retryable: false,
      message: `skills CLI did not produce ${stagedDir}`
    };
  }
  const skillMd = join23(stagedDir, "SKILL.md");
  if (!existsSync21(skillMd)) {
    return {
      ok: false,
      retryable: false,
      message: "skills CLI did not produce a SKILL.md"
    };
  }
  return {
    ok: true,
    stagedDir,
    source: {
      packageSpec: resolvedPackageSpec,
      skillName,
      cliPackage: cliPkg,
      registryId: `${resolvedPackageSpec}/${skillName}`,
      // The CLI does not currently expose a registry snapshot
      // hash; we record the staged directory's hash instead so
      // the audit tool can prove the staged bytes equal the
      // installed bytes.
      registrySnapshotHash: hashBytes(Buffer.from(result.stdout + "\n" + result.stderr, "utf8"))
    }
  };
}
async function hashDir(rootDir) {
  const out = [];
  await walk(rootDir, rootDir, out);
  return out;
}
async function walk(rootDir, currentDir, out) {
  const { readdir: readdir10 } = await import("node:fs/promises");
  const entries = await readdir10(currentDir, { withFileTypes: true });
  for (const e of entries) {
    const abs = join23(currentDir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git") continue;
      await walk(rootDir, abs, out);
      continue;
    }
    if (!e.isFile()) continue;
    const raw = await readFile20(abs);
    const fileStat = await stat2(abs);
    out.push({
      path: abs.slice(rootDir.length + 1).split(sep3).join("/"),
      sha256: createHash17("sha256").update(raw).digest("hex"),
      mode: fileStat.mode & 511,
      size: fileStat.size
    });
  }
}
function hashBytes(bytes) {
  return createHash17("sha256").update(bytes).digest("hex");
}
function hashesEqual(a, b) {
  if (a.length !== b.length) return false;
  const map2 = new Map(a.map((f) => [f.path, f.sha256]));
  for (const f of b) {
    if (map2.get(f.path) !== f.sha256) return false;
  }
  return true;
}
async function copyDir(srcDir, destDir) {
  await mkdir19(destDir, { recursive: true });
  const { readdir: readdir10 } = await import("node:fs/promises");
  const entries = await readdir10(srcDir, { withFileTypes: true });
  for (const e of entries) {
    const src = join23(srcDir, e.name);
    const dest = join23(destDir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git") continue;
      await copyDir(src, dest);
    } else if (e.isFile()) {
      const raw = await readFile20(src);
      await writeFile11(dest, raw, { mode: 420 });
    }
  }
}

// src/tools/ship-skill-audit.js
import { readdir as readdir8, readFile as readFile21 } from "node:fs/promises";
import { existsSync as existsSync22 } from "node:fs";
import { resolve as resolve16, join as join24, isAbsolute as isAbsolute4 } from "node:path";
import { createHash as createHash18 } from "node:crypto";
function createSkillAuditTool(deps) {
  return async function skillAudit(input) {
    const opId = input.operationId ?? `skill-audit-${Date.now().toString(36)}`;
    const repoRoot = resolve16(deps.repoRoot);
    const worktree = await validateLinkedWorktree(repoRoot, String(input.worktreePath ?? ""));
    if (!worktree.ok) {
      return failure("skill-audit", `worktree rejected: ${worktree.message}`, { operationId: opId, retryable: false });
    }
    const inventoryRoot = worktree.path;
    const inventory = await readInventory(inventoryRoot);
    const chain = await verifyInventory(inventoryRoot);
    const active = /* @__PURE__ */ new Map();
    const missing = [];
    const drifted = [];
    const colliding = [];
    if (inventory.parseError) {
      return success2("skill-audit", {
        chain: { ok: false, reason: inventory.parseError },
        missing,
        drifted,
        untracked: [],
        colliding,
        total: 0
      }, { operationId: opId });
    }
    for (const ev of inventory.events) {
      if (ev.type === "install") {
        active.set(ev.skill, ev);
      } else if (ev.type === "uninstall") {
        active.delete(ev.skill);
      }
    }
    for (const ev of active.values()) {
      const installRoot = inventoryRoot;
      const destination = await validateInstallDestination(installRoot, ev.destination);
      if (!destination.ok) {
        drifted.push({ skill: ev.skill, path: ev.destination, reason: destination.message, sequence: ev.sequence });
        continue;
      }
      for (const f of ev.files ?? []) {
        const filePath = join24(installRoot, ev.destination, f.path);
        if (!existsSync22(filePath)) {
          missing.push({ skill: ev.skill, path: f.path, sequence: ev.sequence });
          continue;
        }
        const raw = await readFile21(filePath);
        const sha = createHash18("sha256").update(raw).digest("hex");
        if (sha !== f.sha256) {
          drifted.push({ skill: ev.skill, path: f.path, expected: f.sha256, actual: sha, sequence: ev.sequence });
        }
      }
    }
    const untracked = [];
    const opencodeDir = join24(inventoryRoot, ".opencode", "skills");
    if (existsSync22(opencodeDir)) {
      const entries = await readdir8(opencodeDir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (!active.has(e.name)) {
          untracked.push({ skill: e.name });
        }
      }
    }
    return success2("skill-audit", {
      chain,
      missing,
      drifted,
      untracked,
      colliding,
      total: inventory.events.length,
      active: active.size
    }, { operationId: opId });
  };
}

// src/tools/ship-skill-uninstall.js
import { readFile as readFile22, unlink as unlink5, rm as rm2, readdir as readdir9, lstat } from "node:fs/promises";
import { existsSync as existsSync23 } from "node:fs";
import { resolve as resolve17, join as join25 } from "node:path";
import { createHash as createHash19 } from "node:crypto";
var SAFE_ID_RE14 = /^[A-Za-z0-9._-]{1,128}$/;
function createSkillUninstallTool(deps) {
  return async function skillUninstall(input) {
    const opId = input.operationId ?? `skill-uninstall-${Date.now().toString(36)}`;
    const skillName = String(input.skill ?? "");
    if (!skillName || !SAFE_ID_RE14.test(skillName)) {
      return failure("skill-uninstall", "skill required (safe id)", { operationId: opId, retryable: false });
    }
    const repoRoot = resolve17(deps.repoRoot);
    const worktree = await validateLinkedWorktree(repoRoot, String(input.worktreePath ?? ""));
    if (!worktree.ok) {
      return failure("skill-uninstall", `worktree rejected: ${worktree.message}`, { operationId: opId, retryable: false });
    }
    const inventoryRoot = worktree.path;
    const chain = await verifyInventory(inventoryRoot);
    if (!chain.ok) {
      return failure("skill-uninstall", `inventory chain invalid: ${chain.reason}`, { operationId: opId, retryable: false });
    }
    const found = await findActiveInstall(inventoryRoot, skillName);
    if (!found.ok) {
      return failure("skill-uninstall", `inventory lookup failed: ${found.reason}`, { operationId: opId, retryable: false });
    }
    if (!found.install) {
      return failure("skill-uninstall", "skill not in active inventory", { operationId: opId, retryable: false });
    }
    const installRoot = inventoryRoot;
    const destination = await validateInstallDestination(installRoot, found.install.destination);
    if (!destination.ok) {
      return failure("skill-uninstall", `destination rejected: ${destination.message}`, { operationId: opId, retryable: false });
    }
    const skillDir = destination.path;
    const actualFiles = await listInstalledFiles(skillDir);
    if (!actualFiles.ok) {
      return failure("skill-uninstall", actualFiles.message, { operationId: opId, retryable: false });
    }
    const recordedPaths = new Set((found.install.files ?? []).map((file2) => file2.path));
    const extras = actualFiles.paths.filter((path) => !recordedPaths.has(path));
    if (extras.length > 0) {
      return failure("skill-uninstall", `untracked files present: ${extras.join(", ")}`, { operationId: opId, retryable: false });
    }
    for (const f of found.install.files ?? []) {
      const fileCheck = await validateInstallDestination(installRoot, `${found.install.destination}/${f.path}`);
      if (!fileCheck.ok) {
        return failure("skill-uninstall", `recorded file rejected: ${fileCheck.message}`, { operationId: opId, retryable: false });
      }
      const filePath = fileCheck.path;
      if (!existsSync23(filePath)) {
        return failure("skill-uninstall", `recorded file missing: ${f.path}`, { operationId: opId, retryable: false });
      }
      const raw = await readFile22(filePath);
      const sha = createHash19("sha256").update(raw).digest("hex");
      if (sha !== f.sha256) {
        return failure("skill-uninstall", `recorded file drifted: ${f.path}`, { operationId: opId, retryable: false });
      }
    }
    for (const f of found.install.files ?? []) {
      const filePath = join25(skillDir, ...f.path.split("/"));
      await unlink5(filePath).catch(() => null);
    }
    if (existsSync23(skillDir)) {
      await rm2(skillDir, { recursive: true, force: true });
    }
    const recorded = await appendEvent2(inventoryRoot, {
      type: "uninstall",
      skill: skillName,
      installHash: found.install.hash,
      package: found.install.package,
      destination: found.install.destination
    });
    return success2("skill-uninstall", {
      skill: skillName,
      removed: true,
      installHash: found.install.hash,
      tombstoneSequence: recorded.sequence
    }, { operationId: opId });
  };
}
async function listInstalledFiles(root) {
  if (!existsSync23(root)) return { ok: true, paths: [] };
  const paths = [];
  const walk2 = async (dir, prefix = "") => {
    for (const entry of await readdir9(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join25(dir, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) return { ok: false, message: `symlinked content present: ${relative}` };
      if (info.isDirectory()) {
        const nested = await walk2(absolute, relative);
        if (!nested.ok) return nested;
      } else if (info.isFile()) {
        paths.push(relative);
      } else {
        return { ok: false, message: `unsupported filesystem entry: ${relative}` };
      }
    }
    return { ok: true };
  };
  const result = await walk2(root);
  return result.ok ? { ok: true, paths } : result;
}

// src/recovery.js
function recoverManifestAfterCrash(manifest) {
  return manifest;
}

// src/installer/plugin-owner.js
import { spawnSync as spawnSync4 } from "node:child_process";
async function reconcileOwner(repoRoot, adapter) {
  const r = spawnSync4("git", ["-C", repoRoot, "config", "--get", "user.name"], {
    encoding: "utf8"
  });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return process.env.USER ?? process.env.USERNAME ?? "opencode-ship";
}

// src/installer/config.js
import { readFile as readFile23, writeFile as writeFile12, rename as rename6, mkdir as mkdir20 } from "node:fs/promises";
import { existsSync as existsSync24 } from "node:fs";
import { dirname as dirname11, resolve as resolve18 } from "node:path";

// schema/ship-config.schema.json
var ship_config_schema_default = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/Viktorxyz/opencode-ship/schema/ship-config.schema.json",
  title: "opencode-ship user config",
  type: "object",
  required: ["schemaVersion"],
  additionalProperties: false,
  properties: {
    schemaVersion: { enum: [1, 2] },
    profile: {
      type: "string",
      enum: ["engineering", "core"],
      description: "Active profile. Engineering is the only supported profile in 1.1.0; core is accepted on read for legacy consumer migration."
    },
    owner: {
      type: "string",
      description: "Optional override for the issue/manifest owner field. Defaults to the agent's local user.name."
    },
    project: {
      type: "object",
      additionalProperties: false,
      properties: {
        remote: { type: "string", minLength: 1 },
        repository: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
        defaultBranch: { type: "string", minLength: 1 },
        packageManager: { enum: ["npm", "pnpm", "yarn", "bun"] },
        detectOverrides: { type: "boolean", description: "Permit detection to refresh previously persisted values." }
      }
    },
    delivery: {
      type: "object",
      additionalProperties: false,
      properties: {
        worktree: {
          type: "object",
          additionalProperties: false,
          properties: {
            root: { type: "string", minLength: 1 },
            branchTemplate: { type: "string", minLength: 1 },
            bootstrap: {
              type: "array",
              items: {
                type: "array",
                items: { type: "string", minLength: 1 },
                minItems: 1
              }
            }
          }
        },
        verification: {
          type: "object",
          additionalProperties: false,
          properties: {
            commands: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["id", "argv"],
                additionalProperties: false,
                properties: {
                  id: { type: "string", minLength: 1 },
                  argv: {
                    type: "array",
                    items: { type: "string", minLength: 1 },
                    minItems: 1
                  },
                  timeoutMs: { type: "integer", minimum: 1 }
                }
              }
            },
            requireCleanDiffAfter: { type: "boolean" },
            invalidateOnHeadChange: { type: "boolean" }
          }
        },
        review: {
          type: "object",
          additionalProperties: false,
          properties: {
            agent: { type: "string", minLength: 1 },
            required: { type: "boolean" },
            invalidateOnHeadChange: { type: "boolean" }
          }
        },
        ci: {
          type: "object",
          additionalProperties: false,
          properties: {
            driver: { const: "github-status-checks" },
            requiredChecks: {
              type: "array",
              items: { type: "string", minLength: 1 },
              uniqueItems: true
            },
            wait: { type: "boolean" },
            flakyRetry: { type: "integer", enum: [0, 1] }
          }
        },
        ready: {
          type: "object",
          additionalProperties: false,
          properties: {
            requires: {
              type: "array",
              items: { enum: ["review", "local-verification", "remote-ci"] },
              uniqueItems: true
            },
            stopAfterReady: { type: "boolean" }
          }
        },
        merge: {
          type: "object",
          additionalProperties: false,
          properties: {
            strategy: { const: "squash" },
            policy: { const: "explicit-user-request-only" },
            requireFreshGates: { type: "boolean" }
          }
        },
        cleanup: {
          type: "object",
          additionalProperties: false,
          properties: {
            when: { const: "next-task" },
            requireUnpublishedGuard: { type: "boolean" }
          }
        }
      }
    },
    tasks: {
      type: "object",
      description: "Optional override of the managed-file paths. Use only to relocate a target.",
      additionalProperties: false,
      properties: {
        pluginPath: { type: "string", pattern: "^\\.opencode/.+\\.js$" },
        agentsDir: { type: "string", pattern: "^\\.opencode/agents/?$" },
        skillsDir: { type: "string", pattern: "^\\.opencode/skills/?$" }
      }
    },
    workflow: {
      type: "object",
      description: "Workflow configuration. Models are optional at write time; the setup-ship-workflow skill fills them in. Once all three are present, ship-deliver can start.",
      additionalProperties: false,
      properties: {
        models: {
          type: "object",
          additionalProperties: false,
          description: "Optional model roles. All three roles must be present before ship-deliver can run.",
          properties: {
            planner: {
              type: "string",
              pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
              description: "Provider/model id for the strong planning child session."
            },
            builder: {
              type: "string",
              pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
              description: "Provider/model id for the cheap builder child session."
            },
            finalReviewer: {
              type: "string",
              pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
              description: "Provider/model id for the final Standards + Spec reviewers."
            }
          }
        },
        approval: {
          type: "object",
          additionalProperties: false,
          properties: {
            mirrorToIssue: { const: true },
            maxFailedRounds: { const: 3 }
          }
        }
      }
    },
    skillDiscovery: {
      type: "object",
      additionalProperties: false,
      description: "Trusted-auto skill discovery policy. Default mode is trusted-auto with the canonical owner allowlist and install-count threshold.",
      properties: {
        mode: {
          type: "string",
          enum: ["suggest-only", "trusted-auto", "disabled"]
        },
        trustedOwners: {
          type: "array",
          items: { type: "string", pattern: "^[A-Za-z0-9_.-]+$" }
        },
        minInstalls: { type: "integer", minimum: 0 },
        maxAutoInstall: { type: "integer", minimum: 0, maximum: 20 },
        blocklist: {
          type: "array",
          items: { type: "string", pattern: "^[A-Za-z0-9_./-]+$" }
        },
        requireImmutableRef: { type: "boolean" }
      }
    }
  }
};

// src/installer/validation.js
var FORMAT_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
function isObject3(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function validate(value, schema, pointer, issues) {
  if (!isObject3(schema)) return;
  if (schema.const !== void 0 && value !== schema.const) {
    issues.push(`${pointer}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return;
  }
  if (schema.enum !== void 0 && !schema.enum.includes(value)) {
    issues.push(`${pointer}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validate(value, sub, pointer, issues);
  }
  if (isObject3(schema.if)) {
    const ifIssues = [];
    validate(value, schema.if, pointer, ifIssues);
    if (ifIssues.length === 0) {
      if (isObject3(schema.then)) validate(value, schema.then, pointer, issues);
    } else if (isObject3(schema.else)) {
      validate(value, schema.else, pointer, issues);
    }
  }
  const type = schema.type;
  if (type !== void 0) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (type !== actual) {
      if (!(type === "integer" && typeof value === "number" && Number.isInteger(value))) {
        issues.push(`${pointer}: expected ${type}, got ${actual}`);
        return;
      }
    }
  }
  if (type === "string") {
    if (schema.minLength !== void 0 && value.length < schema.minLength) {
      issues.push(`${pointer}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern !== void 0) {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) issues.push(`${pointer}: does not match pattern ${schema.pattern}`);
    }
    if (schema.format === "date-time" && !FORMAT_DATE_TIME.test(value)) {
      issues.push(`${pointer}: not a date-time string`);
    }
  }
  if (type === "integer" || type === "number") {
    if (schema.minimum !== void 0 && value < schema.minimum) {
      issues.push(`${pointer}: less than minimum ${schema.minimum}`);
    }
    if (schema.maximum !== void 0 && value > schema.maximum) {
      issues.push(`${pointer}: greater than maximum ${schema.maximum}`);
    }
    if (schema.enum !== void 0) {
    }
  }
  if (type === "array") {
    if (schema.minItems !== void 0 && value.length < schema.minItems) {
      issues.push(`${pointer}: fewer items than minItems ${schema.minItems}`);
    }
    if (Array.isArray(schema.items)) {
      value.forEach((entry, i) => validate(entry, schema.items[i] ?? {}, `${pointer}/${i}`, issues));
    } else if (schema.items) {
      if (schema.uniqueItems) {
        const seen = /* @__PURE__ */ new Set();
        value.forEach((entry, i) => {
          const key = JSON.stringify(entry);
          if (seen.has(key)) issues.push(`${pointer}/${i}: duplicate unique item`);
          seen.add(key);
        });
      }
      value.forEach((entry, i) => validate(entry, schema.items, `${pointer}/${i}`, issues));
    }
  }
  if (type === "object" || isObject3(schema.properties) || Array.isArray(schema.required)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) issues.push(`${pointer}: missing required field ${key}`);
      }
    }
    if (schema.additionalProperties === false && isObject3(schema.properties)) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) issues.push(`${pointer}: unknown field ${key}`);
      }
    }
    if (isObject3(schema.properties)) {
      for (const key of Object.keys(schema.properties)) {
        if (key in value) validate(value[key], schema.properties[key], `${pointer}/${key}`, issues);
      }
    }
  }
}
function validateSchema(value, schema) {
  const issues = [];
  validate(value, schema, "#", issues);
  return { ok: issues.length === 0, issues };
}

// src/installer/config.js
function configPath(repoRoot) {
  return resolve18(repoRoot, ".opencode", "ship.config.json");
}
async function loadConfig(repoRoot) {
  const path = configPath(repoRoot);
  if (!existsSync24(path)) return null;
  const raw = await readFile23(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: { kind: "parse", path, message: e.message } };
  }
  const validation = validateSchema(parsed, ship_config_schema_default);
  if (!validation.ok) {
    return { ok: false, error: { kind: "contract", path, issues: validation.issues } };
  }
  return {
    ok: true,
    path,
    raw,
    sha256: bytesHashString(raw),
    canonicalSha256: bytesHashString(stableStringify(parsed)),
    value: parsed
  };
}
function renderDefaultConfig(detection, overrides = {}) {
  const pm = detection?.packageManager ?? "npm";
  const safeBootstrap = Array.isArray(detection?.worktreeBootstrap) && detection.worktreeBootstrap.length ? detection.worktreeBootstrap : [["npm", "install"]];
  const safeVerification = Array.isArray(detection?.verificationPlan) && detection.verificationPlan.length ? detection.verificationPlan.map((step) => ({ id: step.id, argv: step.argv })) : [{ id: "typecheck", argv: ["npm", "run", "typecheck"] }];
  const repo = detection?.repository ?? overrides.repository ?? "owner/repo";
  return {
    schemaVersion: 2,
    profile: "engineering",
    project: {
      remote: detection?.remote ?? "origin",
      repository: repo,
      defaultBranch: detection?.defaultBranch ?? "main",
      packageManager: pm,
      detectOverrides: false
    },
    delivery: {
      worktree: {
        root: detection?.worktreeRoot ?? ".worktrees",
        branchTemplate: "{actor}/{slug}",
        bootstrap: safeBootstrap
      },
      verification: {
        commands: safeVerification,
        requireCleanDiffAfter: true,
        invalidateOnHeadChange: true
      },
      review: { agent: "delivery-reviewer", required: true, invalidateOnHeadChange: true },
      ci: {
        driver: "github-status-checks",
        requiredChecks: ["delivery-verify"],
        wait: true,
        flakyRetry: 1
      },
      ready: { requires: ["review", "local-verification", "remote-ci"], stopAfterReady: true },
      merge: { strategy: "squash", policy: "explicit-user-request-only", requireFreshGates: true },
      cleanup: { when: "next-task", requireUnpublishedGuard: true }
    },
    workflow: {
      models: {},
      approval: { mirrorToIssue: true, maxFailedRounds: 3 }
    }
  };
}

// src/installer/detection/project.js
import { spawnSync as spawnSync5 } from "node:child_process";
import { existsSync as existsSync25, readFileSync as readFileSync2 } from "node:fs";
import { resolve as resolve19, join as join26 } from "node:path";
function runGit2(cwd, args) {
  const r = spawnSync5("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8"
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function detectPackageManager(repoRoot) {
  if (existsSync25(join26(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync25(join26(repoRoot, "yarn.lock"))) return "yarn";
  if (existsSync25(join26(repoRoot, "bun.lockb"))) return "bun";
  if (existsSync25(join26(repoRoot, "package-lock.json"))) return "npm";
  return null;
}
function readPackageJson(repoRoot) {
  const path = join26(repoRoot, "package.json");
  if (!existsSync25(path)) return null;
  try {
    return JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    return null;
  }
}
function planFromScripts(pkg, packageManager) {
  const scripts = pkg?.scripts ?? {};
  const runner = packageManager === "npm" ? "npm" : packageManager || "npm";
  const candidate = (name) => typeof scripts[name] === "string" ? scripts[name].trim() : null;
  if (candidate("verify") || candidate("verify:workspace")) {
    const name = candidate("verify:workspace") ? "verify:workspace" : "verify";
    const cmd = candidate(name);
    return [{ id: "canonical", argv: [runner, "run", name], inferredFrom: "verify", command: cmd }];
  }
  const steps = [];
  if (candidate("typecheck")) steps.push({ id: "typecheck", argv: [runner, "run", "typecheck"], script: "typecheck" });
  if (candidate("lint")) steps.push({ id: "lint", argv: [runner, "run", "lint"], script: "lint" });
  if (candidate("test")) steps.push({ id: "test", argv: [runner, "run", "test"], script: "test" });
  return steps;
}
function bootstrapFor(packageManager) {
  if (packageManager === "pnpm") return [["pnpm", "install", "--frozen-lockfile"]];
  if (packageManager === "yarn") return [["yarn", "install", "--frozen-lockfile"]];
  if (packageManager === "bun") return [["bun", "install", "--frozen-lockfile"]];
  if (packageManager === "npm") return [["npm", "ci"]];
  return [];
}
function parseRepoSlugFromRemote(url2) {
  if (!url2) return null;
  const ssh = url2.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (ssh) return ssh[1].replace(/^\/+|\/+$/g, "");
  const https = url2.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (https) return https[1].replace(/^\/+|\/+$/g, "");
  return null;
}
function detectRemote(repoRoot) {
  const remotes = runGit2(repoRoot, ["remote", "-v"]);
  if (remotes.status !== 0) return { candidates: [], primary: null };
  const lines = remotes.stdout.split("\n").filter(Boolean);
  const map2 = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
    if (!match) continue;
    const name = match[1];
    const url2 = match[2];
    if (!map2.has(name)) map2.set(name, { name, url: url2 });
  }
  const list = Array.from(map2.values());
  const origin = list.find((r) => r.name === "origin") ?? list[0] ?? null;
  return { candidates: list, primary: origin };
}
function detectDefaultBranch(repoRoot, remoteName) {
  const head = runGit2(repoRoot, ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`]);
  if (head.status === 0) {
    const ref = head.stdout.trim();
    const match = ref.match(/^refs\/remotes\/[^/]+\/(.+)$/);
    if (match) return match[1];
  }
  const local = runGit2(repoRoot, ["remote", "show", remoteName]);
  if (local.status === 0) {
    const match = local.stdout.match(/HEAD branch:\s*(\S+)/);
    if (match) return match[1];
  }
  const branch = runGit2(repoRoot, ["branch", "--list"]);
  if (branch.status === 0 && /\*\s*main\b/.test(branch.stdout)) return "main";
  return null;
}
function detectOwner(repoRoot) {
  const user = runGit2(repoRoot, ["config", "--get", "user.name"]);
  if (user.status === 0 && user.stdout.trim()) return user.stdout.trim();
  const fallback = process.env.USER ?? process.env.USERNAME ?? "opencode-ship";
  return fallback;
}
function detectProject(repoRoot = process.cwd()) {
  const errors = [];
  const cwd = resolve19(repoRoot);
  const inside = runGit2(cwd, ["rev-parse", "--show-toplevel"]);
  if (inside.status !== 0) {
    errors.push({ kind: "not-a-git-repo", path: cwd, detail: inside.stderr.trim() });
    return { repoRoot: cwd, errors };
  }
  const repoRootActual = inside.stdout.trim();
  const headBranch = runGit2(repoRootActual, ["symbolic-ref", "--short", "HEAD"]);
  if (headBranch.status !== 0 || headBranch.stdout.trim().length === 0) {
    errors.push({ kind: "detached-head", path: repoRootActual, detail: headBranch.stderr.trim() });
  }
  const remote = detectRemote(repoRootActual);
  let repository = null;
  let defaultBranch = null;
  if (remote.primary) {
    repository = parseRepoSlugFromRemote(remote.primary.url);
    defaultBranch = detectDefaultBranch(repoRootActual, remote.primary.name);
  }
  if (!repository) {
    errors.push({ kind: "no-remote", path: repoRootActual, detail: "no usable remote for github detection" });
  }
  if (!defaultBranch) {
    defaultBranch = "main";
  }
  const packageJson = readPackageJson(repoRootActual);
  const packageManager = detectPackageManager(repoRootActual);
  const verificationPlan = planFromScripts(packageJson, packageManager);
  const worktreeBootstrap = bootstrapFor(packageManager);
  const owner = detectOwner(repoRootActual);
  return {
    repoRoot: repoRootActual,
    repository,
    defaultBranch,
    remote: remote.primary?.name ?? null,
    remoteCandidates: remote.candidates,
    packageManager,
    packageJson,
    verificationPlan,
    worktreeBootstrap,
    worktreeRoot: ".worktrees",
    owner,
    headBranch: headBranch.stdout.trim() || null,
    errors
  };
}

// src/installer/cleanup.js
import { spawnSync as spawnSync6 } from "node:child_process";
import { resolve as pathResolve } from "node:path";
import { existsSync as existsSync26, readFileSync as readFileSync3, writeFileSync as writeFileSync2, mkdirSync as mkdirSync2 } from "node:fs";
function spawn8(repoRoot, args) {
  const r = spawnSync6("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function casDeleteBranch2(repoRoot, branch, expectedSha) {
  if (!isValidExpectedSha(expectedSha)) return -1;
  return spawn8(repoRoot, ["update-ref", "-d", `refs/heads/${branch}`, expectedSha]).status ?? -1;
}
function isValidExpectedSha(value) {
  return typeof value === "string" && /^[0-9a-f]{7,}$/i.test(value);
}
function safeRemoveWorktree2(repoRoot, target) {
  const r = spawn8(repoRoot, ["worktree", "remove", target]);
  return { status: r.status, stderr: r.stderr };
}
function worktreeRootOf(adapter) {
  return adapter?.worktree?.root ?? ".worktrees";
}
async function cleanupPendingPath(repoRoot) {
  const common = await resolveGitCommonDir(repoRoot);
  return pathResolve(opencodeShipStateDir(common), "cleanup-pending.json");
}
async function loadCleanupPending(repoRoot) {
  const path = await cleanupPendingPath(repoRoot);
  if (!existsSync26(path)) return [];
  try {
    const raw = await readFileSync3(path, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
async function saveCleanupPending(repoRoot, entries) {
  const path = await cleanupPendingPath(repoRoot);
  const dir = pathResolve(path, "..");
  if (!existsSync26(dir)) mkdirSync2(dir, { recursive: true });
  writeFileSync2(path, JSON.stringify(dedupePending(entries), null, 2) + "\n", "utf8");
}
function dedupePending(entries) {
  const byTask = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (!e || !e.taskId) continue;
    byTask.set(e.taskId, e);
  }
  return [...byTask.values()];
}
async function appendCleanupPending(repoRoot, entry) {
  const current = await loadCleanupPending(repoRoot);
  const next = [...current, entry];
  await saveCleanupPending(repoRoot, next);
  return next;
}
async function clearCleanupPending(repoRoot, taskId) {
  const current = await loadCleanupPending(repoRoot);
  await saveCleanupPending(repoRoot, current.filter((entry) => entry.taskId !== taskId));
}
function reject(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}
async function tryImmediateCleanup({ repoRoot, taskId, adapter }) {
  if (!repoRoot || !taskId) return reject("missing-args");
  const pending = (await loadCleanupPending(repoRoot)).find((entry) => entry.taskId === taskId);
  const stage = pending?.stage ?? "worktree-remove";
  if (!["worktree-remove", "branch-delete", "manifest-seal"].includes(stage)) {
    return reject("cleanup-stage", { stage });
  }
  const m = await readManifest(repoRoot, taskId);
  if (!m) {
    if (pending && stage === "manifest-seal") {
      await clearCleanupPending(repoRoot, taskId);
      return { ok: true, removedPath: null, sealed: true };
    }
    return reject("missing-manifest");
  }
  if (m.state !== "merged" && m.state !== "cleanup-pending") {
    return reject("manifest-state", { state: m.state });
  }
  if (!m.worktreePath) return reject("missing-worktree-path");
  const wtPath = pathResolve(m.worktreePath);
  const mainCwd = pathResolve(repoRoot);
  if (wtPath === mainCwd) return reject("current-checkout", { worktreePath: wtPath });
  const rootAbs = pathResolve(repoRoot, worktreeRootOf(adapter));
  if (!wtPath.startsWith(rootAbs + "/")) {
    return reject("worktree-out-of-root", { expected: rootAbs, got: wtPath });
  }
  let headSha = isValidExpectedSha(pending?.expectedHeadSha) ? pending.expectedHeadSha : isValidExpectedSha(m.lastPrHeadSha) ? m.lastPrHeadSha : "";
  if (stage === "worktree-remove") {
    const status = spawn8(wtPath, ["status", "--porcelain"]);
    if (status.status === 0) {
      if (status.stdout.trim().length > 0) return reject("dirty-worktree");
      const rebase = spawn8(wtPath, ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]);
      if (rebase.status === 0) return reject("rebase-in-progress");
      const head = spawn8(wtPath, ["rev-parse", "HEAD"]);
      if (head.status !== 0) return reject("no-head");
      headSha = head.stdout.trim();
      if (m.lastPrHeadSha && headSha !== m.lastPrHeadSha) {
        return reject("head-mismatch", { expected: m.lastPrHeadSha, actual: headSha });
      }
      await appendCleanupPending(repoRoot, {
        taskId,
        failedAt: (/* @__PURE__ */ new Date()).toISOString(),
        stage: "worktree-remove",
        expectedHeadSha: headSha,
        reason: "worktree head validated"
      });
      const removed = safeRemoveWorktree2(repoRoot, wtPath);
      if (removed.status !== 0) {
        await appendCleanupPending(repoRoot, {
          taskId,
          failedAt: (/* @__PURE__ */ new Date()).toISOString(),
          stage: "worktree-remove",
          expectedHeadSha: headSha,
          reason: removed.stderr ?? "non-zero exit"
        });
        return reject("remove-failed", { detail: removed.stderr });
      }
    } else if (!headSha) {
      return reject("no-head");
    }
    await appendCleanupPending(repoRoot, {
      taskId,
      failedAt: (/* @__PURE__ */ new Date()).toISOString(),
      stage: "branch-delete",
      expectedHeadSha: headSha,
      reason: "resume cleanup"
    });
  }
  if (stage !== "manifest-seal") {
    if (!isValidExpectedSha(headSha)) return reject("no-head");
    const branchDelete = casDeleteBranch2(repoRoot, m.branch, headSha);
    const branchStillThere = spawn8(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${m.branch}`]);
    if (branchDelete !== 0 && branchStillThere.status === 0) {
      await appendCleanupPending(repoRoot, {
        taskId,
        failedAt: (/* @__PURE__ */ new Date()).toISOString(),
        stage: "branch-delete",
        expectedHeadSha: headSha,
        reason: "git update-ref failed"
      });
      return reject("branch-delete-failed");
    }
    await appendCleanupPending(repoRoot, {
      taskId,
      failedAt: (/* @__PURE__ */ new Date()).toISOString(),
      stage: "manifest-seal",
      reason: "resume cleanup"
    });
  }
  const next = {
    ...m,
    state: "cleaned",
    transitionLog: [
      ...m.transitionLog,
      { from: m.state, to: "cleaned", at: Date.now(), reason: "immediate cleanup" }
    ],
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeManifest(repoRoot, next).catch(() => null);
  await deleteManifest(repoRoot, taskId);
  await clearCleanupPending(repoRoot, taskId);
  return { ok: true, removedPath: wtPath, sealed: true };
}
async function listPending(repoRoot) {
  const all = await listManifests(repoRoot).catch(() => []);
  const manifests = all.filter((m) => m.state === "merged" || m.state === "cleanup-pending");
  const queued = await loadCleanupPending(repoRoot);
  const byTask = new Map(manifests.map((manifest) => [manifest.taskId, manifest]));
  for (const entry of queued) {
    if (!byTask.has(entry.taskId)) byTask.set(entry.taskId, entry);
  }
  return [...byTask.values()];
}

// src/installer/ship-adapter.js
import { resolve as resolve20 } from "node:path";
var REQUIRED_DEFAULTS = {
  review: { agent: "delivery-reviewer", required: true, invalidateOnHeadChange: true },
  ci: { driver: "github-status-checks", requiredChecks: ["delivery-verify"], wait: true, flakyRetry: 1 },
  ready: { requires: ["review", "local-verification", "remote-ci"], stopAfterReady: true },
  merge: { strategy: "squash", policy: "explicit-user-request-only", requireFreshGates: true },
  cleanup: { when: "next-task", requires: ["pr-merged", "worktree-clean", "no-unpublished-commits"] },
  forge: { driver: "github", issueRequired: true, draftAfterFirstCommit: true, issueClosingSyntax: true },
  worktree: { root: ".worktrees", branchTemplate: "{actor}/{slug}", bootstrap: [["npm", "install"]] },
  verification: { commands: [], requireCleanDiffAfter: true, invalidateOnHeadChange: true }
};
function flattenShipConfig(ship) {
  if (!ship || typeof ship !== "object") return null;
  const adapter = { contractVersion: 1 };
  adapter.repository = {
    remote: ship.project?.remote ?? "origin",
    defaultBranch: ship.project?.defaultBranch ? { name: ship.project.defaultBranch } : { discover: true }
  };
  adapter.forge = REQUIRED_DEFAULTS.forge;
  adapter.worktree = {
    ...REQUIRED_DEFAULTS.worktree,
    ...ship.delivery?.worktree ?? {},
    bootstrap: ship.delivery?.worktree?.bootstrap?.length ? ship.delivery.worktree.bootstrap : REQUIRED_DEFAULTS.worktree.bootstrap
  };
  adapter.verification = {
    ...REQUIRED_DEFAULTS.verification,
    ...ship.delivery?.verification ?? {},
    commands: ship.delivery?.verification?.commands?.length ? ship.delivery.verification.commands.map((c) => ({ id: c.id, argv: c.argv, timeoutMs: c.timeoutMs })) : REQUIRED_DEFAULTS.verification.commands
  };
  adapter.review = { ...REQUIRED_DEFAULTS.review, ...ship.delivery?.review ?? {} };
  adapter.ci = { ...REQUIRED_DEFAULTS.ci, ...ship.delivery?.ci ?? {} };
  adapter.ready = { ...REQUIRED_DEFAULTS.ready, ...ship.delivery?.ready ?? {} };
  adapter.merge = { ...REQUIRED_DEFAULTS.merge, ...ship.delivery?.merge ?? {} };
  adapter.cleanup = { ...REQUIRED_DEFAULTS.cleanup, ...ship.delivery?.cleanup ?? {} };
  if (ship.delivery?.cleanup?.requireUnpublishedGuard !== void 0) {
    void ship.delivery.cleanup.requireUnpublishedGuard;
  }
  return adapter;
}
function selectRuntimeAdapter({ config: config2, shipAdapter, legacyAdapter }) {
  if (config2?.ok) return shipAdapter;
  if (legacyAdapter?.ok) return legacyAdapter.adapter;
  return shipAdapter;
}

// src/version.js
import { readFileSync as readFileSync4, existsSync as existsSync27 } from "node:fs";
import { dirname as dirname12, resolve as resolve21 } from "node:path";
import { fileURLToPath } from "node:url";
var PACKAGE_VERSION = "1.1.7";
var TEMPLATE_SET = `v${PACKAGE_VERSION}`;

// src/plugin.js
var toolDefs = [
  ["delivery_inspect", "Inspect a manifest and a project-local doctor report.", "inspect"],
  ["delivery_issue", "Find or create the issue for a delivery task.", "issue"],
  ["delivery_worktree", "Create an isolated worktree for the task.", "worktree"],
  ["delivery_verify", "Run the consumer's canonical verification command.", "verify"],
  ["delivery_review", "Record the reviewer verdict against the PR head SHA.", "review"],
  ["delivery_pr", "Open a draft PR linked to the issue.", "pr"],
  ["delivery_ready", "Mark the PR ready after every required gate has passed.", "ready"],
  ["delivery_merge", "Squash merge the PR after an explicit user request.", "merge"],
  ["delivery_cleanup", "Remove the agent-owned worktree and branch after merge.", "cleanup"],
  ["delivery_github_read", "Typed read of issue, PR, or check data.", "githubRead"],
  ["delivery_issue_comment", "Idempotent typed comment on an issue.", "issueComment"],
  ["delivery_issue_labels", "Idempotent label add/remove on an issue.", "issueLabels"],
  ["delivery_issue_link", "Mark a relationship between two issues.", "issueLink"],
  ["delivery_issue_close", "Close an issue with a recorded user permission subject.", "issueClose"],
  ["delivery_sync", "Fetch and merge base into the feature branch.", "sync"],
  ["delivery_publish", "Push the manifest branch to origin with HEAD verification.", "publish"],
  ["ship_plan_start", "Create a workflow and dispatch the configured planner.", "planStart"],
  ["ship_plan_submit", "Planner-only immutable PlanV2 submission.", "planSubmit"],
  ["ship_plan_approve", "Interactive approval + immutable local seal.", "planApprove"],
  ["ship_run_start", "Start execution of an approved plan.", "runStart"],
  ["ship_task_start", "Dispatch a task to the configured builder agent.", "taskStart"],
  ["ship_task_commit", "Record the immutable commit binding for a reviewed task.", "taskCommit"],
  ["ship_task_complete", "Advance the run to the next task or to ALL_TASKS_DONE.", "taskComplete"],
  ["ship_task_report", "Builder-only immutable task report.", "taskReport"],
  ["ship_task_review", "Task reviewer Spec/Quality verdict.", "taskReview"],
  ["ship_final_review", "Record one final review axis (standards or spec).", "finalReview"],
  ["ship_resume", "Restore, reconcile, and continue idempotently.", "resume"],
  ["ship_status", "Read-only compact workflow state.", "status"],
  ["ship_skill_discover", "Query the trusted skill registry and partition candidates.", "skillDiscover"],
  ["ship_skill_install", "Install a trusted skill into the active issue worktree.", "skillInstall"],
  ["ship_skill_audit", "Audit the installed trusted skills inventory.", "skillAudit"],
  ["ship_skill_uninstall", "Remove a trusted skill whose recorded sha256 still matches.", "skillUninstall"]
];
function wrapEnvelopeV2(id, result) {
  if (result && typeof result === "object" && result.contractVersion === 2) {
    return result;
  }
  if (result && typeof result === "object" && result.contractVersion === 1) {
    const { contractVersion: _cv, ...rest } = result;
    return {
      contractVersion: 2,
      ok: true,
      kind: id,
      operationId: `legacy-${Date.now().toString(36)}`,
      idempotent: false,
      data: rest
    };
  }
  if (result && typeof result === "object" && typeof result.kind === "string") {
    return {
      contractVersion: 2,
      ok: false,
      kind: id,
      operationId: `legacy-${Date.now().toString(36)}`,
      retryable: false,
      message: result.kind,
      details: result
    };
  }
  return {
    contractVersion: 2,
    ok: true,
    kind: id,
    operationId: `legacy-${Date.now().toString(36)}`,
    idempotent: false,
    data: result
  };
}
function makeTool(id, description, factory, runtime) {
  return tool({
    description,
    args: factory.args,
    async execute(args, ctx) {
      const runner = factory.build(runtime, ctx);
      const env = await runner(args);
      const wrapped = wrapEnvelopeV2(id, env);
      return JSON.stringify(wrapped, null, 2);
    }
  });
}
async function resolveRepoSlug(repoRoot, detection, config2) {
  const fromConfig = config2?.value?.project?.repository;
  if (typeof fromConfig === "string" && fromConfig.includes("/")) return fromConfig;
  if (detection?.repository) return detection.repository;
  const gitConfig = await readFile24(resolve22(repoRoot, ".git/config"), "utf8").catch(() => null);
  if (gitConfig) {
    const m = gitConfig.match(/url\s*=\s*.*?github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\b/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}
async function resolveOwner(repoRoot, detection, config2, adapter) {
  const explicit = config2?.value?.owner;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return reconcileOwner(repoRoot, adapter);
}
function shippingLockValue(repoRoot) {
  return readLock2(repoRoot);
}
async function bestEffortCleanupQueue(repoRoot, adapter) {
  const lock = await shippingLockValue(repoRoot);
  const pending = lock?.cleanupPending ?? [];
  const out = { reconciled: 0, retained: 0, failures: [] };
  const tasks = await listPending(repoRoot).catch(() => []);
  for (const manifest of tasks) {
    const r = await tryImmediateCleanup({ repoRoot, taskId: manifest.taskId, adapter });
    if (r.ok) out.reconciled += 1;
    else {
      out.retained += 1;
      const reason = r && typeof r === "object" && "reason" in r ? r.reason : "unknown";
      out.failures.push({ taskId: manifest.taskId, reason: reason ?? "unknown" });
    }
  }
  return { pending, manifestTasks: tasks.map((t) => t.taskId), ...out };
}
async function buildRuntime(worktree, opencodeClient, driverOverride) {
  const repoRootAbs = resolve22(worktree ?? process.cwd());
  const detection = detectProject(repoRootAbs);
  const legacyAdapter = await loadAdapter(repoRootAbs);
  const config2 = await loadConfig(repoRootAbs);
  const configValue = config2?.ok ? config2.value : renderDefaultConfig(detection);
  const shipAdapter = flattenShipConfig(configValue);
  const adapter = selectRuntimeAdapter({ config: config2, shipAdapter, legacyAdapter });
  const repoSlug = await resolveRepoSlug(repoRootAbs, detection, config2);
  const owner = await resolveOwner(repoRootAbs, detection, config2, adapter);
  const driver = driverOverride ?? createGhDriver({ cwd: repoRootAbs });
  const cleanup = await bestEffortCleanupQueue(repoRootAbs, adapter).catch(() => null);
  return {
    cwd: process.cwd(),
    repoRoot: repoRootAbs,
    adapter,
    legacyAdapterPath: legacyAdapter.ok ? legacyAdapter.path : null,
    legacyAdapterLoadError: legacyAdapter.ok ? null : legacyAdapter.error,
    config: config2,
    configPath: config2?.ok ? config2.path : configPath(repoRootAbs),
    configValue,
    repoSlug: repoSlug ?? "owner/repo",
    owner,
    opencodeClient: opencodeClient ?? null,
    driver,
    packageVersion: PACKAGE_VERSION,
    lastTaskId: null,
    cleanupQueueOnStartup: cleanup,
    recover: () => recoverManifestAfterCrash
  };
}
var factories = {
  inspect: {
    args: { taskId: tool.schema.string().describe("Manifest taskId to inspect.") },
    build: (rt) => createInspectTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      packageVersion: rt.packageVersion,
      remote: "origin"
    })
  },
  issue: {
    args: {
      taskId: tool.schema.string(),
      title: tool.schema.string(),
      body: tool.schema.string().optional(),
      baseBranch: tool.schema.string(),
      baseSha: tool.schema.string().optional(),
      branch: tool.schema.string(),
      labels: tool.schema.array(tool.schema.string()).optional()
    },
    build: (rt) => createIssueTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin"
    })
  },
  worktree: {
    args: {
      taskId: tool.schema.string(),
      branch: tool.schema.string(),
      worktreeRelativePath: tool.schema.string()
    },
    build: (rt) => createWorktreeTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin"
    })
  },
  verify: {
    args: {
      taskId: tool.schema.string(),
      commandId: tool.schema.string().optional()
    },
    build: (rt) => createVerifyTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin"
    })
  },
  review: {
    args: {
      taskId: tool.schema.string(),
      status: tool.schema.enum(["pass", "fail", "blocked", "partial"]),
      headSha: tool.schema.string().optional(),
      findings: tool.schema.unknown().optional(),
      envelope: tool.schema.unknown().optional()
    },
    build: (rt) => createReviewTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin"
    })
  },
  pr: {
    args: {
      taskId: tool.schema.string(),
      title: tool.schema.string(),
      body: tool.schema.string()
    },
    build: (rt) => createPrTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin"
    })
  },
  ready: { args: { taskId: tool.schema.string(), workflowId: tool.schema.string().optional() }, build: (rt) => createReadyTool({
    driver: rt.driver,
    repoRoot: rt.repoRoot,
    repoSlug: rt.repoSlug,
    owner: rt.owner,
    adapter: rt.adapter,
    remote: "origin"
  }) },
  merge: {
    args: { taskId: tool.schema.string(), subject: tool.schema.string() },
    build: (rt) => createMergeTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin"
    })
  },
  cleanup: {
    args: { taskId: tool.schema.string() },
    build: (rt) => createCleanupTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin"
    })
  },
  githubRead: {
    args: {
      resource: tool.schema.enum(["issue", "pr", "checks"]),
      number: tool.schema.number().optional(),
      sha: tool.schema.string().optional(),
      operationId: tool.schema.string().optional()
    },
    build: (rt) => createGithubReadTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      operationStore: { readOperation: async () => null }
    })
  },
  issueComment: {
    args: {
      number: tool.schema.number(),
      body: tool.schema.string(),
      operationId: tool.schema.string().optional()
    },
    build: (rt) => createIssueCommentTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner
    })
  },
  issueLabels: {
    args: {
      number: tool.schema.number(),
      add: tool.schema.array(tool.schema.string()).optional(),
      remove: tool.schema.array(tool.schema.string()).optional(),
      operationId: tool.schema.string().optional()
    },
    build: (rt) => createIssueLabelsTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner
    })
  },
  issueLink: {
    args: {
      from: tool.schema.number(),
      to: tool.schema.number(),
      relationship: tool.schema.enum(["blocks", "is-blocked-by", "closes", "is-closed-by", "related"]),
      operationId: tool.schema.string().optional()
    },
    build: (rt) => createIssueLinkTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner
    })
  },
  issueClose: {
    args: {
      number: tool.schema.number(),
      subject: tool.schema.string(),
      operationId: tool.schema.string().optional()
    },
    build: (rt) => createIssueCloseTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner
    })
  },
  sync: {
    args: {
      base: tool.schema.string(),
      branch: tool.schema.string(),
      operationId: tool.schema.string().optional()
    },
    build: (rt) => createSyncTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner
    })
  },
  publish: {
    args: {
      taskId: tool.schema.string(),
      expectedHead: tool.schema.string(),
      operationId: tool.schema.string().optional()
    },
    build: (rt) => createPublishTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner
    })
  },
  planStart: {
    args: {
      issueNumber: tool.schema.number(),
      operationId: tool.schema.string().optional()
    },
    build: (rt, ctx) => createPlanStartTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
      opencodeClient: rt.opencodeClient,
      ctx
    })
  },
  taskStart: {
    args: {
      workflowId: tool.schema.string(),
      taskId: tool.schema.string(),
      operationId: tool.schema.string().optional()
    },
    build: (rt, ctx) => createTaskStartTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
      opencodeClient: rt.opencodeClient,
      ctx
    })
  },
  taskCommit: {
    args: {
      workflowId: tool.schema.string(),
      taskId: tool.schema.string(),
      expectedHead: tool.schema.string(),
      commitSha: tool.schema.string(),
      planHash: tool.schema.string(),
      reviewHash: tool.schema.string(),
      round: tool.schema.number(),
      operationId: tool.schema.string().optional()
    },
    build: (rt, ctx) => createTaskCommitTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
      ctx
    })
  },
  taskComplete: {
    args: {
      workflowId: tool.schema.string(),
      taskId: tool.schema.string(),
      moreTasks: tool.schema.boolean(),
      nextTaskId: tool.schema.string().optional(),
      expectedHead: tool.schema.string().optional(),
      operationId: tool.schema.string().optional()
    },
    build: (rt, ctx) => createTaskCompleteTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
      opencodeClient: rt.opencodeClient,
      driver: rt.driver,
      adapter: rt.adapter,
      repoSlug: rt.repoSlug,
      ctx
    })
  },
  finalReview: {
    args: {
      workflowId: tool.schema.string(),
      axis: tool.schema.enum(["standards", "spec"]),
      verdict: tool.schema.enum(["pass", "fail", "blocked"]),
      headSha: tool.schema.string(),
      mergeBaseSha: tool.schema.string(),
      packageHash: tool.schema.string(),
      findings: tool.schema.array(tool.schema.unknown()).optional(),
      operationId: tool.schema.string().optional()
    },
    build: (rt, ctx) => createFinalReviewTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
      ctx
    })
  },
  skillDiscover: {
    args: {
      query: tool.schema.string(),
      operationId: tool.schema.string().optional()
    },
    build: (rt) => createSkillDiscoverTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue
    })
  },
  skillInstall: {
    args: {
      package: tool.schema.string(),
      skillName: tool.schema.string(),
      worktreePath: tool.schema.string(),
      version: tool.schema.string().optional(),
      operationId: tool.schema.string().optional()
    },
    build: (rt) => createSkillInstallTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue
    })
  },
  skillAudit: {
    args: {
      worktreePath: tool.schema.string(),
      operationId: tool.schema.string().optional()
    },
    build: (rt) => createSkillAuditTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue
    })
  },
  skillUninstall: {
    args: {
      skill: tool.schema.string(),
      worktreePath: tool.schema.string(),
      operationId: tool.schema.string().optional()
    },
    build: (rt) => createSkillUninstallTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue
    })
  },
  planSubmit: {
    args: {
      workflowId: tool.schema.string(),
      revision: tool.schema.number(),
      plan: tool.schema.unknown(),
      sha256: tool.schema.string().optional(),
      operationId: tool.schema.string().optional()
    },
    build: (rt, ctx) => createPlanSubmitTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      ctx
    })
  },
  planApprove: {
    args: {
      workflowId: tool.schema.string(),
      revision: tool.schema.number(),
      sha256: tool.schema.string(),
      subject: tool.schema.string(),
      operationId: tool.schema.string().optional()
    },
    build: (rt, ctx) => createPlanApproveTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      configValue: rt.configValue,
      ctx
    })
  },
  runStart: {
    args: {
      workflowId: tool.schema.string(),
      revision: tool.schema.number().optional(),
      sha256: tool.schema.string().optional(),
      operationId: tool.schema.string().optional()
    },
    build: (rt, ctx) => createRunStartTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      configValue: rt.configValue,
      ctx
    })
  },
  taskReport: {
    args: {
      workflowId: tool.schema.string(),
      taskId: tool.schema.string(),
      round: tool.schema.number(),
      summary: tool.schema.string(),
      changes: tool.schema.array(tool.schema.unknown()).optional(),
      tests: tool.schema.array(tool.schema.unknown()).optional(),
      operationId: tool.schema.string().optional()
    },
    build: (rt, ctx) => createTaskReportTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
      opencodeClient: rt.opencodeClient,
      ctx
    })
  },
  taskReview: {
    args: {
      workflowId: tool.schema.string(),
      taskId: tool.schema.string(),
      round: tool.schema.number(),
      spec: tool.schema.object({
        verdict: tool.schema.enum(["pass", "none", "fail"]),
        notes: tool.schema.string().optional()
      }),
      quality: tool.schema.object({
        verdict: tool.schema.enum(["pass", "none", "fail"]),
        notes: tool.schema.string().optional()
      }),
      operationId: tool.schema.string().optional()
    },
    build: (rt, ctx) => createTaskReviewTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
      ctx
    })
  },
  resume: {
    args: {
      workflowId: tool.schema.string(),
      operationId: tool.schema.string().optional()
    },
    build: (rt, ctx) => createResumeTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      ctx
    })
  },
  status: {
    args: {
      workflowId: tool.schema.string(),
      operationId: tool.schema.string().optional()
    },
    build: (rt) => createStatusTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner
    })
  }
};
var ShipPlugin = async (ctx) => {
  const worktree = ctx && ctx.worktree || process.cwd();
  const runtime = await buildRuntime(worktree, ctx?.client, ctx?.driver);
  const tools = {};
  for (const [id, description, key] of toolDefs) {
    const factory = factories[key];
    tools[id] = makeTool(id, description, factory, runtime);
  }
  return {
    tool: tools,
    "experimental.session.compacting": async (input, output) => {
      const current = Array.isArray(output.context) ? output.context : [];
      output.context = [
        ...current,
        "opencode-ship plugin is loaded; one issue -> one worktree -> one PR -> one merge -> one cleanup."
      ];
    },
    event: async ({ event }) => {
      if (!event) return;
      if (event.type === "session.created" || event.type === "session.idle") {
        await bestEffortCleanupQueue(runtime.repoRoot, runtime.adapter).catch(() => null);
      }
    }
  };
};
var plugin_default = ShipPlugin;
export {
  ShipPlugin,
  plugin_default as default
};
