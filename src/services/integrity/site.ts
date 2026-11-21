import type { ManifestReader } from './manifest.js'

/**
 * 整站签名：清单取件、清单验签、逐文件验签与证书链校验。
 * 整站模型对站点内的 .html、.js、.css、.json 文件逐个生成 CMS 分离签名（<文件>.sig），
 * 汇总写成 web_files.json 并对清单自身单独签名，签名证书随站点分发。
 * 验签顺序固定为：取证书、在本地用内置根证书校验链、用证书验清单签名、按清单逐文件验签。
 * 结论只有三态：verified 通过、unverified 未校验（材料缺失或本地不具备校验条件）、failed 失败；
 * 取值与引擎的 SignatureState 一致，不新增第四态。
 */

/** 整站清单文件名，与站点根目录的页面同级 */
export const SITE_MANIFEST_FILE = 'web_files.json'
/** 逐文件签名的后缀；每个被签名文件对应 <文件>.sig */
export const SITE_SIGNATURE_SUFFIX = '.sig'
/** 整站清单结构版本 */
export const SITE_SCHEMA_VERSION = 1
/** 整站签名覆盖的扩展名，与签发侧一致 */
export const SITE_SIGNED_EXTENSIONS: readonly string[] = ['.html', '.js', '.css', '.json']

/** 签名结论；三态与引擎的 SignatureState 同一取值 */
export type SignatureState = 'verified' | 'unverified' | 'failed'

/** 证书链结论；none 表示没有证书或本地不具备校验条件 */
export type SiteChainState = 'ok' | 'chain' | 'none'

/** 一份整站清单 */
export type SiteManifest = {
  /** 被签名的文件，相对站点根目录，按清单顺序去重 */
  files: string[]
  /** 清单的原始字节；CMS 验签的对象 */
  signedBytes: Uint8Array<ArrayBuffer>
}

/** 清单取件结果；manifest 为 null 时 failure 说明原因 */
export type SiteManifestFetch = {
  manifest: SiteManifest | null
  signature: Uint8Array<ArrayBuffer> | null
  /** missing 表示清单字节或清单签名缺失，structure 表示清单结构不符 */
  failure: 'missing' | 'structure' | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 只接受站内相对路径，避免清单把校验指向站外地址或上层目录 */
export const isSitePath = (value: string): boolean =>
  value !== '' &&
  !value.startsWith('/') &&
  !value.includes('..') &&
  !value.includes('\\') &&
  !/^[a-z][a-z0-9+.-]*:/i.test(value)

/** 拼接站内地址；baseUrl 与 path 都按目录处理 */
export const siteUrlOf = (baseUrl: string, path: string): string => {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
  try {
    return new URL(path, base).href
  } catch {
    return base + path
  }
}

/** 解析整站清单；结构不符、路径非法或清单为空都返回 null */
export const parseSiteManifest = (bytes: Uint8Array<ArrayBuffer>): SiteManifest | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== SITE_SCHEMA_VERSION || !Array.isArray(parsed.files)) {
    return null
  }
  const files: string[] = []
  for (const item of parsed.files) {
    if (typeof item !== 'string' || !isSitePath(item)) {
      return null
    }
    if (!files.includes(item)) {
      files.push(item)
    }
  }
  return files.length === 0 ? null : { files, signedBytes: bytes }
}

/**
 * 取整站清单与清单签名。
 * 清单字节与签名分开取：清单能解析就返回，签名缺失只记 failure，由验签函数按未校验处理，
 * 这样模型识别只看清单在不在，不受签名取件结果影响；清单结构不符时 manifest 为 null。
 */
export const fetchSiteManifest = async (
  baseUrl: string,
  read: ManifestReader
): Promise<SiteManifestFetch> => {
  const url = siteUrlOf(baseUrl, SITE_MANIFEST_FILE)
  const [bytes, signature] = await Promise.all([read(url), read(url + SITE_SIGNATURE_SUFFIX)])
  if (bytes === null) {
    return { manifest: null, signature, failure: 'missing' }
  }
  const manifest = parseSiteManifest(bytes)
  if (manifest === null) {
    return { manifest: null, signature, failure: 'structure' }
  }
  return { manifest, signature, failure: signature === null ? 'missing' : null }
}

type VerifierModule = typeof import('./x509.js') & typeof import('./cms.js')

/** 证书链与 CMS 校验模块按需加载，未启用整站验签时不会进入首屏代码 */
let verifier: Promise<VerifierModule> | null = null

const verifierModule = (): Promise<VerifierModule> => {
  verifier ??= (async () => ({
    ...(await import('./x509.js')),
    ...(await import('./cms.js')),
  }))()
  return verifier
}

/**
 * 证书链校验：用内置根证书校验站点证书。
 * 没有证书、没有根证书或环境没有 WebCrypto 时返回 none，由调用方按未校验处理；
 * 证书无法解析或链不通过返回 chain。
 */
export const verifySiteChain = async (
  certPem: string,
  rootCa: string
): Promise<SiteChainState> => {
  if (certPem.trim() === '' || rootCa.trim() === '') {
    return 'none'
  }
  const { ensurePkijsEngine, parseCertificate, verifyCertificateChain } = await verifierModule()
  if (!ensurePkijsEngine()) {
    return 'none'
  }
  const root = parseCertificate(rootCa)
  const signer = parseCertificate(certPem)
  if (root === null || signer === null) {
    return 'chain'
  }
  const chain = await verifyCertificateChain(root, signer)
  return chain.ok ? 'ok' : 'chain'
}

/**
 * 清单验签：证书先由内置根证书校链，链不通过即失败且不再发起 CMS 验签。
 * 清单或签名缺失、没有证书、环境不具备校验条件都按未校验处理；
 * 证书无法解析、链不通过、CMS 验签不通过都按失败处理。
 */
export const verifySiteManifest = async (
  fetched: SiteManifestFetch,
  certPem: string,
  rootCa: string
): Promise<SignatureState> => {
  if (fetched.manifest === null || fetched.signature === null) {
    return 'unverified'
  }
  if (certPem.trim() === '' || rootCa.trim() === '') {
    return 'unverified'
  }
  const { ensurePkijsEngine, parseCertificate, verifyDetachedCms } = await verifierModule()
  if (!ensurePkijsEngine()) {
    return 'unverified'
  }
  const root = parseCertificate(rootCa)
  const signer = parseCertificate(certPem)
  if (root === null || signer === null) {
    return 'failed'
  }
  const signed = await verifyDetachedCms(fetched.signature, fetched.manifest.signedBytes, signer, root)
  return signed ? 'verified' : 'failed'
}

/** 单个文件的验签输入 */
export type SiteFileCheck = {
  /** 相对站点根目录的路径；必须是清单内的一项 */
  path: string
  /** 已取到的文件字节；验签对象就是它，不重新取件，避免验签内容与实际消费内容不一致 */
  bytes: Uint8Array<ArrayBuffer>
  /** 该文件 <路径>.sig 的字节；缺失传 null */
  signature: Uint8Array<ArrayBuffer> | null
  /** 已通过验签的整站清单 */
  manifest: SiteManifest
  certPem: string
  rootCa: string
}

/**
 * 逐文件验签。
 * 清单有效时，未登记的文件按失败处理（清单即签名覆盖范围），签名文件缺失按未校验处理；
 * 证书不可用、链不通过或 CMS 验签不通过按失败处理，没有证书按未校验处理。
 */
export const verifySiteFile = async (check: SiteFileCheck): Promise<SignatureState> => {
  if (!check.manifest.files.includes(check.path)) {
    return 'failed'
  }
  if (check.signature === null) {
    return 'unverified'
  }
  if (check.certPem.trim() === '' || check.rootCa.trim() === '') {
    return 'unverified'
  }
  const { ensurePkijsEngine, parseCertificate, verifyDetachedCms } = await verifierModule()
  if (!ensurePkijsEngine()) {
    return 'unverified'
  }
  const root = parseCertificate(check.rootCa)
  const signer = parseCertificate(check.certPem)
  if (root === null || signer === null) {
    return 'failed'
  }
  const signed = await verifyDetachedCms(check.signature, check.bytes, signer, root)
  return signed ? 'verified' : 'failed'
}
