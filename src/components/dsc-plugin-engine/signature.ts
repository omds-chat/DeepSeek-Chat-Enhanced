import {
  base64ToBytes,
  bytesToBase64,
  verifyDetachedSignature,
} from '../../services/integrity/ed25519.js'
import type {
  SignatureState,
  SourceTrustFailure,
  SourceTrustState,
  SourceVerdict,
  SourceVerdictReason,
} from './types.js'

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

/** 签名材料的地址；字段与引擎的安装来源一致 */
export type SignatureSource = {
  /** 合集 EEC 证书 PEM；只能来自 online-data 信任清单 */
  eec?: string
  /** plugin.js.sig 地址；缺省为 <url>.sig */
  sigUrl?: string
  /** 作者公钥地址；缺省时不校验作者签名 */
  authorPubUrl?: string
  /** 作者签名地址；缺省为 <url>.author.sig */
  authorSigUrl?: string
}

/**
 * 收集签名材料：合集证书与 CMS 签名、作者公钥与作者签名。
 * 合集证书只用调用方传入的 PEM，即来自 online-data 信任清单的那张，不从来源站点拉取；
 * 没有传入时 CMS 验签直接跳过，由调用方记为无法确认来源。作者材料仍按地址拉取。
 */
export const loadSignatureMaterial = async (
  url: string,
  source?: SignatureSource
): Promise<SignatureMaterial> => {
  const eec = source?.eec ?? ''
  const authorPubText = await fetchArtifactText(source?.authorPubUrl ?? '')
  const authorPub = authorPubText ?? ''
  const [sig, authorSig] = await Promise.all([
    eec === '' ? Promise.resolve(null) : fetchArtifactBytes(source?.sigUrl ?? url + '.sig'),
    authorPub === ''
      ? Promise.resolve(null)
      : fetchArtifactBytes(source?.authorSigUrl ?? url + '.author.sig'),
  ])
  return { eec, sig, authorPub, authorSig }
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

/** 验签明细；null 表示没有该项材料，未做校验 */
export type VerifyOutcome = {
  /** 合集 CMS 验签结论；没有清单证书或 CMS 签名时为 null */
  cms: boolean | null
  /** 作者裸签名结论；没有作者材料时为 null */
  author: boolean | null
  /** 汇总状态；任何一项不通过为 failed，完全没有材料为 unverified */
  state: SignatureState
}

/**
 * 校验一份产物字节。
 * 合集 CMS 签名与作者裸签名各自有材料才校验，全部通过为 verified；
 * 任何一项不通过为 failed；完全没有材料为 unverified。
 */
export const verifyArtifact = async (
  content: Uint8Array<ArrayBuffer>,
  material: SignatureMaterial
): Promise<VerifyOutcome> => {
  const cms =
    material.eec !== '' && material.sig !== null
      ? { eec: material.eec, sig: material.sig }
      : null
  const author =
    material.authorPub !== '' && material.authorSig !== null
      ? { pub: material.authorPub, sig: material.authorSig }
      : null
  if (!cms && !author) {
    return { cms: null, author: null, state: 'unverified' }
  }
  if (cms && !(await verifyCmsSignature(content, cms.sig, cms.eec))) {
    return { cms: false, author: null, state: 'failed' }
  }
  if (author && !(await verifyAuthorSignature(content, author.sig, author.pub))) {
    return { cms: cms ? true : null, author: false, state: 'failed' }
  }
  return { cms: cms ? true : null, author: author ? true : null, state: 'verified' }
}

/** 来源结论的判定输入；信任判定来自插件市场的 online-data 信任清单 */
export type SourceVerdictInput = {
  /** 证书是否来自 online-data 信任清单 */
  anchored: boolean
  /** CMS 验签结论；没有锚定证书时为 null */
  cms: boolean | null
  /** 来源信任判定；缺省按未登记处理 */
  trust?: SourceTrustState
  /** 信任失败原因 */
  trustFailure?: SourceTrustFailure
}

/** 来源结论与原因 */
export type SourceVerdictResult = {
  verdict: SourceVerdict
  reason: SourceVerdictReason
}

/**
 * 来源结论：只有证书锚定在 online-data 信任清单且 CMS 验签通过才算已确认。
 * 证书锚定但验签未通过为 failed；来源在清单里但证书链校验失败或证书已被吊销同样是 failed,
 * 这是确定的负面结论,不按「无法确认」处理；只有清单里没有该来源时才为 unknown。
 */
export const sourceVerdictOf = (input: SourceVerdictInput): SourceVerdictResult => {
  if (input.anchored) {
    return input.cms === true
      ? { verdict: 'confirmed', reason: null }
      : { verdict: 'failed', reason: 'other' }
  }
  if (input.trust === 'untrusted') {
    const reason: SourceVerdictReason =
      input.trustFailure === 'revoked'
        ? 'revoked'
        : input.trustFailure === 'chain'
          ? 'chain'
          : 'other'
    return { verdict: 'failed', reason }
  }
  return { verdict: 'unknown', reason: null }
}
