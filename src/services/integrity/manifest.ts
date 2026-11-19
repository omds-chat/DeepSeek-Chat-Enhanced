import type { Certificate } from 'pkijs'

/**
 * 三层哈希清单：读取、验签、文件哈希比对与 revision 记忆。
 * 每层各有一份 manifest.json 与 manifest.json.sig，层与层之间互不引用：
 * L1 位于合集根，覆盖 meta.json、datalog.json、tags.json 与 plugins/author_manifest.json；
 * L2 位于 plugins/<作者>/，覆盖 author_pub.pem 与 plugin_manifest.json；
 * L3 位于 plugins/<作者>/<插件>/，覆盖 versions.json 与 <版本>/meta.json。
 * L3 不覆盖 plugin.js，产物由每版本的 plugin.js.sig 独立签名。
 * 签名由 openssl cms -sign -binary -md sha512 -outform DER -nocerts -noattr 产出，
 * 验签证书是合集 EEC，信任锚是构建时注入的根证书。
 */

/** 清单结构版本 */
export const MANIFEST_SCHEMA_VERSION = 1
/** 清单文件名 */
const MANIFEST_FILE = 'manifest.json'
/** 签名后缀；每个被签名文件对应 <文件>.sig */
const SIGNATURE_SUFFIX = '.sig'
/** SHA-512 小写十六进制规则 */
const SHA512_PATTERN = /^[0-9a-f]{128}$/
/** 清单请求的最长等待时间（毫秒） */
const MANIFEST_TIMEOUT = 5000

/** 清单登记的一个文件 */
export type ManifestFile = {
  /** 相对该层目录的路径 */
  path: string
  /** 文件字节的 SHA-512，小写十六进制 */
  sha512: string
}

/** 一份清单 */
export type Manifest = {
  schemaVersion: number
  revision: number
  files: ManifestFile[]
  /** 清单文件的原始字节；CMS 验签的对象，不属于清单格式本身 */
  signedBytes: Uint8Array<ArrayBuffer>
}

/** 清单不可用的原因；missing 表示清单或签名缺失，structure 表示结构不符 */
export type ManifestFailure = 'missing' | 'structure' | 'chain' | 'signature'

/** 清单校验结论 */
export type ManifestVerdict = { ok: true } | { ok: false; reason: ManifestFailure }

/** 各层 revision；缺哪层表示该层没有拿到清单 */
export type ManifestRevisions = { l1?: number; l2?: number; l3?: number }

/** 取字节的函数；失败返回 null，由调用方按缺失处理 */
export type ManifestReader = (url: string) => Promise<Uint8Array<ArrayBuffer> | null>

/** 一次清单拉取的结果；manifest 为 null 时 failure 说明原因 */
export type ManifestFetch = {
  /** 该层目录地址，以斜杠结尾 */
  layerUrl: string
  manifest: Manifest | null
  signature: Uint8Array<ArrayBuffer> | null
  failure: ManifestFailure | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 只接受层内相对路径，避免清单把校验指向站外地址或上层目录 */
const isLocalPath = (value: string): boolean =>
  value !== '' &&
  !value.startsWith('/') &&
  !value.includes('..') &&
  !value.includes('\\') &&
  !/^[a-z][a-z0-9+.-]*:/i.test(value)

/** 拼接层目录地址；baseUrl 与 layerPath 都按目录处理 */
export const layerUrlOf = (baseUrl: string, layerPath: string): string => {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
  const path = layerPath === '' || layerPath.endsWith('/') ? layerPath : layerPath + '/'
  try {
    return new URL(path, base).href
  } catch {
    return base + path
  }
}

/** 层的记忆键；用该层目录的绝对地址，同一层在不同来源下互不干扰 */
export const manifestLayerKey = (baseUrl: string, layerPath: string): string =>
  layerUrlOf(baseUrl, layerPath)

/** 解析清单字节；结构不符时返回 null。signedBytes 保留原始字节，供 CMS 验签使用 */
export const parseManifest = (bytes: Uint8Array<ArrayBuffer>): Manifest | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
    return null
  }
  const files: ManifestFile[] = []
  for (const item of parsed.files) {
    if (!isRecord(item)) {
      return null
    }
    const path = item.path
    const sha512 = item.sha512
    if (typeof path !== 'string' || !isLocalPath(path)) {
      return null
    }
    if (typeof sha512 !== 'string' || !SHA512_PATTERN.test(sha512)) {
      return null
    }
    files.push({ path, sha512 })
  }
  return {
    schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 0,
    revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
    files,
    signedBytes: bytes,
  }
}

/** 结构校验：结构版本、revision 为正整数、路径与哈希合法、文件非空 */
export const isManifestStructureValid = (manifest: Manifest): boolean => {
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return false
  }
  if (!Number.isInteger(manifest.revision) || manifest.revision <= 0) {
    return false
  }
  if (manifest.files.length === 0) {
    return false
  }
  return manifest.files.every(
    (file) => isLocalPath(file.path) && SHA512_PATTERN.test(file.sha512)
  )
}

/** 默认取字节实现：直接 fetch，失败与非 2xx 都返回 null */
const defaultReader: ManifestReader = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT)
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 取某层的 manifest.json 与 manifest.json.sig。
 * 两者都拿到才算取到；清单结构不符时 manifest 为 null 且 failure 为 structure。
 * readBytes 缺省用 fetch，市场侧传入基于 net 能力的实现以遵守能力边界。
 */
export const fetchManifest = async (
  baseUrl: string,
  layerPath: string,
  readBytes: ManifestReader = defaultReader
): Promise<ManifestFetch> => {
  const layerUrl = layerUrlOf(baseUrl, layerPath)
  const [manifestBytes, signature] = await Promise.all([
    readBytes(layerUrl + MANIFEST_FILE),
    readBytes(layerUrl + MANIFEST_FILE + SIGNATURE_SUFFIX),
  ])
  if (manifestBytes === null || signature === null) {
    return { layerUrl, manifest: null, signature, failure: 'missing' }
  }
  const manifest = parseManifest(manifestBytes)
  if (manifest === null) {
    return { layerUrl, manifest: null, signature, failure: 'structure' }
  }
  return { layerUrl, manifest, signature, failure: null }
}

type VerifierModule =
  typeof import('./x509.js') &
  typeof import('./cms.js')

/** 证书链与 CMS 校验模块按需加载，未启用清单校验时不会进入首屏代码 */
let verifier: Promise<VerifierModule> | null = null

const verifierModule = (): Promise<VerifierModule> => {
  verifier ??= (async () => ({
    ...(await import('./x509.js')),
    ...(await import('./cms.js')),
  }))()
  return verifier
}

/**
 * 校验一份清单：先用根证书验 EEC 证书链，再用 EEC 验 CMS 签名，最后校验结构。
 * 链不通过时不发起 CMS 验签；任何一步失败都返回原因，不抛出异常。
 */
export const verifyManifest = async (
  manifest: Manifest | null,
  signature: Uint8Array<ArrayBuffer> | null,
  eec: string,
  rootCa: string
): Promise<ManifestVerdict> => {
  if (manifest === null) {
    return { ok: false, reason: 'structure' }
  }
  if (signature === null) {
    return { ok: false, reason: 'missing' }
  }
  if (eec.trim() === '' || rootCa.trim() === '') {
    return { ok: false, reason: 'chain' }
  }
  const { ensurePkijsEngine, parseCertificate, verifyCertificateChain, verifyDetachedCms } =
    await verifierModule()
  if (!ensurePkijsEngine()) {
    return { ok: false, reason: 'chain' }
  }
  const root: Certificate | null = parseCertificate(rootCa)
  const signer: Certificate | null = parseCertificate(eec)
  if (root === null || signer === null) {
    return { ok: false, reason: 'chain' }
  }
  const chain = await verifyCertificateChain(root, signer)
  if (!chain.ok) {
    return { ok: false, reason: 'chain' }
  }
  const signed = await verifyDetachedCms(signature, manifest.signedBytes, signer, root)
  if (!signed) {
    return { ok: false, reason: 'signature' }
  }
  if (!isManifestStructureValid(manifest)) {
    return { ok: false, reason: 'structure' }
  }
  return { ok: true }
}

/** SHA-512 小写十六进制；环境没有 WebCrypto 时返回 null */
export const sha512Hex = async (bytes: Uint8Array): Promise<string | null> => {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return null
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-512', new Uint8Array(bytes.slice()))
  )
  let text = ''
  for (const byte of digest) {
    text += byte.toString(16).padStart(2, '0')
  }
  return text
}

/**
 * 比对清单登记的文件哈希。
 * filePath 是相对该层目录的路径；清单没有登记该文件、或哈希不一致都返回 false。
 */
export const hashMatches = async (
  manifest: Manifest,
  filePath: string,
  bytes: Uint8Array
): Promise<boolean> => {
  const entry = manifest.files.find((file) => file.path === filePath)
  if (entry === undefined) {
    return false
  }
  const digest = await sha512Hex(bytes)
  return digest !== null && digest === entry.sha512
}

/** revision 记忆的持久化后端；不提供时只用内存 */
export type RevisionBackend = {
  read(): Record<string, number>
  write(value: Record<string, number>): void
}

/** revision 比较结论；regressed 表示本次 revision 小于已记录值 */
export type RevisionCheck = { regressed: boolean; seen: number | null }

/** 每层路径到见过的最大 revision 的记忆 */
export type RevisionMemory = {
  /** 已记录的最大 revision；没见过返回 null */
  seen(layerKey: string): number | null
  /** 只比较不写入 */
  check(layerKey: string, revision: number): RevisionCheck
  /** 比较并写入较大值；返回比较结论 */
  record(layerKey: string, revision: number): RevisionCheck
  /** 清空记忆 */
  clear(): void
}

/** 内存后端；每次创建记忆时独立一份 */
const memoryBackend = (): RevisionBackend => {
  let state: Record<string, number> = {}
  return {
    read: () => ({ ...state }),
    write: (value) => {
      state = { ...value }
    },
  }
}

const readRevisionMap = (value: unknown): Record<string, number> => {
  const map: Record<string, number> = {}
  if (!isRecord(value)) {
    return map
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number' && Number.isInteger(item) && item > 0) {
      map[key] = item
    }
  }
  return map
}

/**
 * 创建 revision 记忆：每层路径记录见过的最大 revision。
 * 后端不可用或内容不合法时退回空记忆，不抛错。
 */
export const createRevisionMemory = (backend: RevisionBackend = memoryBackend()): RevisionMemory => {
  let state = readRevisionMap(backend.read())
  const check = (layerKey: string, revision: number): RevisionCheck => {
    const seen = Object.hasOwn(state, layerKey) ? state[layerKey] : null
    return { regressed: seen !== null && revision < seen, seen }
  }
  return {
    seen: (layerKey) => (Object.hasOwn(state, layerKey) ? state[layerKey] : null),
    check,
    record: (layerKey, revision) => {
      const result = check(layerKey, revision)
      const previous = result.seen
      if (previous === null || revision > previous) {
        state = { ...state, [layerKey]: revision }
        backend.write({ ...state })
      }
      return result
    },
    clear: () => {
      state = {}
      backend.write({})
    },
  }
}
