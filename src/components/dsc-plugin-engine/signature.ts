import {
  base64ToBytes,
  bytesToBase64,
  verifyDetachedSignature,
} from '../../services/integrity/ed25519.js'
import type { SignatureState } from './types.js'

/** 拉取资源字节；网络失败与非 2xx 响应都返回 null */
export const fetchArtifactBytes = async (url: string): Promise<Uint8Array<ArrayBuffer> | null> => {
  if (url === '') {
    return null
  }
  try {
    const response = await fetch(url, { cache: 'no-store' })
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null
  } catch {
    return null
  }
}

/** 拉取文本资源（合集证书与作者公钥 PEM）；网络失败与非 2xx 响应都返回 null */
export const fetchArtifactText = async (url: string): Promise<string | null> => {
  if (url === '') {
    return null
  }
  try {
    const response = await fetch(url, { cache: 'no-store' })
    return response.ok ? await response.text() : null
  } catch {
    return null
  }
}

/** 一份产物的签名材料；缺哪一项就跳过对应的校验 */
export type SignatureMaterial = {
  /** 合集 EEC 证书 PEM，用于 CMS 分离验签 */
  eec: string
  /** plugin.js.sig 的 DER 字节 */
  sig: Uint8Array | null
  /** 作者公钥 PEM，用于作者裸签名验签 */
  authorPub: string
  /** 作者签名原始字节 */
  authorSig: Uint8Array | null
}

/** 签名材料的可持久化形式；字段名与安装记录一致 */
export type StoredSignature = {
  eec?: string
  sig?: string
  authorPub?: string
  authorSig?: string
}

/** 是否具备可校验的签名材料；两种签名都不完整时为 false */
export const hasSignatureMaterial = (material: SignatureMaterial): boolean =>
  (material.eec !== '' && material.sig !== null) ||
  (material.authorPub !== '' && material.authorSig !== null)

/** 签名材料转成可写入 IndexedDB 的文本字段；缺失的部分不写 */
export const encodeSignature = (material: SignatureMaterial): StoredSignature => {
  const stored: StoredSignature = {}
  if (material.eec !== '') {
    stored.eec = material.eec
  }
  if (material.sig !== null) {
    stored.sig = bytesToBase64(material.sig)
  }
  if (material.authorPub !== '') {
    stored.authorPub = material.authorPub
  }
  if (material.authorSig !== null) {
    stored.authorSig = bytesToBase64(material.authorSig)
  }
  return stored
}

/** 存储字段还原成签名材料；非法 base64 视为该材料缺失 */
export const decodeSignature = (stored: StoredSignature): SignatureMaterial => ({
  eec: stored.eec ?? '',
  sig: stored.sig === undefined ? null : base64ToBytes(stored.sig),
  authorPub: stored.authorPub ?? '',
  authorSig: stored.authorSig === undefined ? null : base64ToBytes(stored.authorSig),
})

type X509Module = typeof import('../../services/integrity/x509.js')
type CmsModule = typeof import('../../services/integrity/cms.js')

/** 证书链与 CMS 校验模块按需加载，未启用签名校验时不会进入首屏代码 */
let verifier: Promise<X509Module & CmsModule> | null = null

const verifierModule = (): Promise<X509Module & CmsModule> => {
  verifier ??= (async () => ({
    ...(await import('../../services/integrity/x509.js')),
    ...(await import('../../services/integrity/cms.js')),
  }))()
  return verifier
}

/**
 * CMS 分离验签：用合集 EEC 证书验证 plugin.js.sig。
 * 证书不可用、签名结构不符或验签失败都返回 false，不抛出异常。
 */
export const verifyCmsSignature = async (
  content: Uint8Array,
  signature: Uint8Array,
  eecPem: string
): Promise<boolean> => {
  const { ensurePkijsEngine, parseCertificate, verifyDetachedCms } = await verifierModule()
  if (!ensurePkijsEngine()) {
    return false
  }
  const signer = parseCertificate(eecPem)
  if (!signer) {
    return false
  }
  // pkijs 的分离验签要求内容为裸 ArrayBuffer 视图，这里把入参还原成该形态
  return await verifyDetachedCms(
    signature as Uint8Array<ArrayBuffer>,
    content as Uint8Array<ArrayBuffer>,
    signer
  )
}

/**
 * 作者裸签名验签：Ed25519 直接对插件字节签名，不做摘要预处理。
 * 公钥不可用或验签失败都返回 false，不抛出异常。
 */
export const verifyAuthorSignature = async (
  content: Uint8Array,
  signature: Uint8Array,
  authorPubPem: string
): Promise<boolean> => await verifyDetachedSignature(content, signature, authorPubPem)

/**
 * 校验一份产物字节。
 * 合集 CMS 签名与作者裸签名各自有材料才校验，全部通过为 verified；
 * 任何一项不通过为 failed；完全没有材料为 unverified。
 */
export const verifyArtifact = async (
  content: Uint8Array<ArrayBuffer>,
  material: SignatureMaterial
): Promise<SignatureState> => {
  const cms =
    material.eec !== '' && material.sig !== null
      ? { eec: material.eec, sig: material.sig }
      : null
  const author =
    material.authorPub !== '' && material.authorSig !== null
      ? { pub: material.authorPub, sig: material.authorSig }
      : null
  if (!cms && !author) {
    return 'unverified'
  }
  if (cms && !(await verifyCmsSignature(content, cms.sig, cms.eec))) {
    return 'failed'
  }
  if (author && !(await verifyAuthorSignature(content, author.sig, author.pub))) {
    return 'failed'
  }
  return 'verified'
}
