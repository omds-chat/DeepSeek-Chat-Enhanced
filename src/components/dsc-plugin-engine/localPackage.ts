import { gunzipSync, unzipSync } from 'fflate'
import { verifyDetachedSignature } from '../../services/integrity/ed25519.js'
import type { CoreCapabilityId } from '../dsc-core/index.js'
import {
  MAX_PLUGIN_CODE_BYTES,
  type InstallRejection,
  type LocalizedText,
  type PluginManifest,
} from './types.js'

/** tar 头与数据块大小（字节） */
const TAR_BLOCK = 512
/** 离线包根目录下的产物文件名 */
const META_FILE = 'meta.json'
const PLUGIN_FILE = 'plugin.js'
/** 作者签名与作者公钥；合集签名不随离线包分发，离线包只认作者裸签名 */
const AUTHOR_SIGN_FILE = 'plugin.js.author.sig'
const AUTHOR_PUB_FILE = 'author_pub.pem'
/** npm 包内的产物目录；其余内容一律忽略 */
const NPM_DIST = 'package/dist/'
/** 版本号规则，与运行时 meta schema 一致 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** 解压后的包内文件；键为相对包根的路径 */
export type PackageFiles = Map<string, Uint8Array>

/** 解包结果 */
export type PackageRead =
  | { ok: true; files: PackageFiles }
  | { ok: false; reason: InstallRejection; detail?: string }

/** 离线包解析与校验结果 */
export type PackageInspection = {
  meta: PackageMeta
  /** meta.json 自带 capabilities 时的清单；缺该字段时为 null，交给产物导出的 manifest */
  manifest: PluginManifest | null
  /** 插件代码文本，安装后原样存入安装记录 */
  codeText: string
  /** 作者公钥 PEM；包内没有时缺省 */
  authorPub?: string
  /** 作者签名原始字节；包内没有时缺省 */
  authorSig?: Uint8Array
  /** 签名材料只提供了一半或不可用，安装后按未校验处理 */
  incompleteSignature: boolean
  /** 签名材料齐全但验签不通过；安装后标记为 failed，仍然允许安装 */
  signatureFailed: boolean
}

/** 离线包预检结果 */
export type PackageInspectionResult =
  | { ok: true; inspection: PackageInspection }
  | { ok: false; reason: InstallRejection; detail?: string }

/** meta.json 的可展示子集与安装所需字段 */
export type PackageMeta = {
  name: string
  version: string
  author: string
  license: string
  description: LocalizedText
  /** 申请的能力；缺字段或含非字符串项时为 null */
  capabilities: CoreCapabilityId[] | null
  /** 依赖的 dsc 版本范围，来自 dependencies.dsc */
  engines?: string
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** UTF-8 解码；非法字节序列返回 null，避免存入无法还原的代码文本 */
const decodeText = (bytes: Uint8Array): string | null => {
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

/**
 * 把插件字节解成可以原样还原的 UTF-8 文本。
 * 非法字节序列或解码后再编码与原字节不一致时返回 null,避免存入无法还原的代码文本。
 */
export const decodePluginCode = (bytes: Uint8Array): string | null => {
  const text = decodeText(bytes)
  if (text === null || !sameBytes(encoder.encode(text), bytes)) {
    return null
  }
  return text
}

/** 逐字节比较；用于确认代码文本可以还原成原始字节 */
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }
  return true
}

/** 读取 tar 头里的文本字段，遇到 NUL 或字段末尾停止 */
const readTarText = (block: Uint8Array, offset: number, length: number): string => {
  const limit = Math.min(offset + length, block.length)
  let end = offset
  while (end < limit && block[end] !== 0) {
    end += 1
  }
  return decoder.decode(block.subarray(offset, end))
}

/** 读取 tar 头里的文件大小；八进制文本为主，兼容 GNU base-256 编码 */
const readTarSize = (block: Uint8Array): number => {
  if ((block[124] & 0x80) !== 0) {
    let size = 0
    for (let index = 125; index < 136; index += 1) {
      size = size * 256 + block[index]
    }
    return size
  }
  const text = readTarText(block, 124, 12).trim()
  if (text === '') {
    return 0
  }
  const size = Number.parseInt(text, 8)
  return Number.isFinite(size) && size >= 0 ? size : -1
}

/** 全零块表示归档结束 */
const isZeroBlock = (block: Uint8Array): boolean => {
  for (const byte of block) {
    if (byte !== 0) {
      return false
    }
  }
  return true
}

/**
 * 最小 tar 读取器：只收普通文件条目。
 * pax 头（x、g）、GNU 长名头（L、K）与目录条目一律跳过，其余类型同样忽略。
 */
export const readTarEntries = (bytes: Uint8Array): PackageFiles | null => {
  const files: PackageFiles = new Map()
  let offset = 0
  while (offset + TAR_BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK)
    if (isZeroBlock(header)) {
      break
    }
    const name = readTarText(header, 0, 100)
    const prefix = readTarText(header, 345, 155)
    const size = readTarSize(header)
    const type = header[156]
    if (size < 0) {
      return null
    }
    const dataStart = offset + TAR_BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > bytes.length) {
      return null
    }
    if (type === 0 || type === 0x30) {
      files.set(prefix === '' ? name : prefix + '/' + name, bytes.subarray(dataStart, dataEnd))
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return files
}

/** 解 zip：只取包根目录下的文件，其余层级忽略 */
const readZip = (bytes: Uint8Array): PackageFiles | null => {
  try {
    const entries = unzipSync(bytes)
    const files: PackageFiles = new Map()
    for (const [path, data] of Object.entries(entries)) {
      if (path.endsWith('/') || path.includes('/')) {
        continue
      }
      files.set(path, data)
    }
    return files
  } catch {
    return null
  }
}

/** 解 npm 包：先 gunzip 再按 tar 读取，只取 package/dist/ 下的文件 */
const readTgz = (bytes: Uint8Array): PackageFiles | null => {
  let raw: Uint8Array
  try {
    raw = gunzipSync(bytes)
  } catch {
    return null
  }
  const entries = readTarEntries(raw)
  if (!entries) {
    return null
  }
  const files: PackageFiles = new Map()
  for (const [path, data] of entries) {
    if (!path.startsWith(NPM_DIST)) {
      continue
    }
    const rest = path.slice(NPM_DIST.length)
    if (rest === '' || rest.includes('/')) {
      continue
    }
    files.set(rest, data)
  }
  return files
}

/**
 * 按扩展名解包。
 * zip 要求产物直接放在包根目录；tgz 要求产物在 package/dist/ 下。
 */
export const readLocalPackage = (fileName: string, bytes: Uint8Array): PackageRead => {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.zip')) {
    const files = readZip(bytes)
    return files ? { ok: true, files } : { ok: false, reason: 'corrupt-package', detail: 'zip' }
  }
  if (lower.endsWith('.tgz')) {
    const files = readTgz(bytes)
    return files ? { ok: true, files } : { ok: false, reason: 'corrupt-package', detail: 'tgz' }
  }
  return { ok: false, reason: 'unsupported-package', detail: fileName }
}

/** 双语文案归一化；字符串视为两种语言同一内容 */
const readText = (value: unknown): LocalizedText => {
  if (typeof value === 'string') {
    return { 'zh-CN': value, 'en-US': value }
  }
  if (isRecord(value)) {
    const zh = typeof value['zh-CN'] === 'string' ? value['zh-CN'] : ''
    const en = typeof value['en-US'] === 'string' ? value['en-US'] : ''
    return { 'zh-CN': zh || en, 'en-US': en || zh }
  }
  return { 'zh-CN': '', 'en-US': '' }
}

/** 读取清单里的能力声明；缺字段或含非字符串项时返回 null */
const readCapabilities = (value: unknown): CoreCapabilityId[] | null => {
  if (!Array.isArray(value)) {
    return null
  }
  const capabilities: CoreCapabilityId[] = []
  for (const item of value) {
    if (!isFilled(item)) {
      return null
    }
    const capability = item.trim() as CoreCapabilityId
    if (!capabilities.includes(capability)) {
      capabilities.push(capability)
    }
  }
  return capabilities
}

/**
 * 解析 meta.json 并做最小校验：name、author 非空，version 为三段数字。
 * 与运行时 meta schema 对齐，字段缺失时按空串处理，不据此拒绝安装。
 */
export const parsePackageMeta = (text: string): PackageMeta | null => {
  const parsed = parseJson(text)
  if (!isRecord(parsed)) {
    return null
  }
  const { name, version, author } = parsed
  if (!isFilled(name) || !isFilled(version) || !isFilled(author)) {
    return null
  }
  const trimmedVersion = version.trim()
  if (!VERSION_PATTERN.test(trimmedVersion)) {
    return null
  }
  const meta: PackageMeta = {
    name: name.trim(),
    version: trimmedVersion,
    author: author.trim(),
    license: typeof parsed.license === 'string' ? parsed.license.trim() : '',
    description: readText(parsed.description),
    capabilities: readCapabilities(parsed.capabilities),
  }
  const dependencies = parsed.dependencies
  if (isRecord(dependencies) && isFilled(dependencies.dsc)) {
    meta.engines = dependencies.dsc.trim()
  }
  return meta
}

/**
 * 把插件名转成引擎接受的插件 id；@scope/name 取 name 部分。
 * 规则与插件市场一致，保证同一插件在两条安装路径上得到同一个 id。
 */
export const toPluginId = (name: string): string | null => {
  const slash = name.startsWith('@') ? name.indexOf('/') : -1
  const base = slash >= 0 ? name.slice(slash + 1) : name
  const id = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return /^[a-z][a-z0-9-]*$/.test(id) ? id : null
}

/** 由 meta 构造清单；缺 capabilities 或 name 无法转成 id 时返回 null */
const buildManifest = (meta: PackageMeta): PluginManifest | null => {
  const id = toPluginId(meta.name)
  if (!id || !meta.capabilities) {
    return null
  }
  const manifest: PluginManifest = {
    id,
    name: meta.name,
    version: meta.version,
    capabilities: meta.capabilities,
  }
  if (meta.engines) {
    manifest.engines = meta.engines
  }
  return manifest
}

/**
 * 校验解包结果：必需文件、meta.json、代码文本与作者签名。
 * 包内同时提供 plugin.js.author.sig 与 author_pub.pem 时按约定验签；
 * 验签不通过只记录状态，不拒绝安装，由安装流程提示用户自行判断。
 */
export const inspectPackageFiles = async (files: PackageFiles): Promise<PackageInspectionResult> => {
  const metaBytes = files.get(META_FILE)
  if (!metaBytes) {
    return { ok: false, reason: 'missing-meta' }
  }
  const pluginBytes = files.get(PLUGIN_FILE)
  if (!pluginBytes) {
    return { ok: false, reason: 'missing-plugin' }
  }
  if (pluginBytes.length > MAX_PLUGIN_CODE_BYTES) {
    return { ok: false, reason: 'package-too-large', detail: String(pluginBytes.length) }
  }
  const metaText = decodeText(metaBytes)
  if (metaText === null) {
    return { ok: false, reason: 'invalid-meta', detail: 'meta.json is not valid UTF-8' }
  }
  const meta = parsePackageMeta(metaText)
  if (!meta) {
    return { ok: false, reason: 'invalid-meta' }
  }
  const codeText = decodePluginCode(pluginBytes)
  if (codeText === null) {
    return { ok: false, reason: 'corrupt-package', detail: 'plugin.js is not valid UTF-8' }
  }
  const signBytes = files.get(AUTHOR_SIGN_FILE)
  const pubBytes = files.get(AUTHOR_PUB_FILE)
  const pubText = pubBytes ? decodeText(pubBytes) : null
  const hasSign = signBytes !== undefined && signBytes.length > 0
  const hasPub = pubText !== null && pubText.trim() !== ''
  const inspection: PackageInspection = {
    meta,
    manifest: buildManifest(meta),
    codeText,
    incompleteSignature: hasSign !== hasPub,
    signatureFailed: false,
  }
  if (hasSign && hasPub && signBytes !== undefined && pubText !== null) {
    inspection.authorPub = pubText
    inspection.authorSig = signBytes
    // 验签不通过不拒绝安装，只记录状态
    inspection.signatureFailed = !(await verifyDetachedSignature(pluginBytes, signBytes, pubText))
  }
  return { ok: true, inspection }
}
