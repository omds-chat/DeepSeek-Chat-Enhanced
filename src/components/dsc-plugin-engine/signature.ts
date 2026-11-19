import {
  base64ToBytes,
  bytesToBase64,
  verifyDetachedSignature,
} from '../../services/integrity/ed25519.js'
import { sha512Hex } from '../../services/integrity/manifest.js'
import { getTrustCrl } from '../../services/trust/crl.js'
import { isOnline, logMaterial, requestBytes, requestText } from '../../services/trust/net.js'
import type {
  SignatureState,
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

/** 材料来源只提示一次，避免每次启动恢复都刷一条控制台提示 */
let materialNoted = false

/** 记录一次材料回退：说明当前用的是安装记录里已存的那份或构建内嵌的材料 */
const noteMaterial = (message: string): void => {
  if (materialNoted) {
    return
  }
  materialNoted = true
  logMaterial('plugin-engine', message)
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
  /** 合集 EEC 证书 PEM；信任清单已登记时优先使用，省一次请求 */
  eec?: string
  /**
   * 来源自带的合集证书地址，按顺序尝试：
   * 规范路径 certs/<合集 id>-eec.crt 优先，旧的 eec.pem 兜底；清单未登记时取它
   */
  eecUrls?: string[]
  /** plugin.js.sig 地址；缺省为 <url>.sig */
  sigUrl?: string
  /** 作者公钥地址；缺省时不校验作者签名 */
  authorPubUrl?: string
  /** 作者签名地址；缺省为 <url>.author.sig */
  authorSigUrl?: string
  /** L2 清单登记的 author_pub.pem 哈希；给出时公钥字节必须与它一致才会用于验签 */
  authorPubSha512?: string
}

/**
 * 作者公钥字节是否与 L2 清单登记的哈希一致。
 * 没有登记哈希时按一致处理，作者签名仍按原有规则校验。
 */
export const authorPubMatches = async (
  bytes: Uint8Array,
  expectedSha512: string
): Promise<boolean> => {
  if (expectedSha512 === '') {
    return true
  }
  const digest = await sha512Hex(bytes)
  return digest !== null && digest === expectedSha512
}

/**
 * 收集签名材料：合集证书与 CMS 签名、作者公钥与作者签名。
 * 合集证书优先用信任清单已登记或安装记录里已存的那张，没有时在线依次尝试来源自带的
 * certs/<合集 id>-eec.crt 与旧的 eec.pem；离线不发请求，只用已存的证书。证书都必须在本机用构建内嵌的根证书通过证书链校验才会用于验签，
 * 校验在 verifyArtifact 里完成。都没有时 CMS 验签直接跳过，由调用方按拿不到证书处理。
 */
export const loadSignatureMaterial = async (
  url: string,
  source?: SignatureSource
): Promise<SignatureMaterial> => {
  const eec = await resolveEec(source)
  const authorPub = await resolveAuthorPub(source)
  const [sig, authorSig] = await Promise.all([
    eec === '' ? Promise.resolve(null) : requestBytes(source?.sigUrl ?? url + '.sig'),
    authorPub === ''
      ? Promise.resolve(null)
      : requestBytes(source?.authorSigUrl ?? url + '.author.sig'),
  ])
  return { eec, sig, authorPub, authorSig }
}

/**
 * 取作者公钥。
 * L2 清单登记了哈希时，字节必须与哈希一致才会用于作者签名验签；
 * 不一致时返回空串，作者签名按未校验处理，产物本身的 CMS 验签不受影响。
 */
const resolveAuthorPub = async (source?: SignatureSource): Promise<string> => {
  const bytes = await requestBytes(source?.authorPubUrl ?? '')
  if (bytes === null) {
    return ''
  }
  if (!(await authorPubMatches(bytes, source?.authorPubSha512 ?? ''))) {
    return ''
  }
  return new TextDecoder().decode(bytes)
}

/**
 * 取验签用的合集证书。
 * 已登记的那份（信任清单登记或安装记录里存的）优先，省一次来源站点的请求；
 * 没有登记时在线按顺序尝试来源自带的地址：规范路径 certs/<合集 id>-eec.crt 优先，
 * 取不到再试旧的 eec.pem，两条都失败才算拿不到证书；离线不发请求。
 * 证书一律由 verifyArtifact 用构建内嵌的根证书校链，链不通过不会用于 CMS 验签。
 */
const resolveEec = async (source?: SignatureSource): Promise<string> => {
  const stored = source?.eec ?? ''
  const eecUrls = source?.eecUrls ?? []
  if (!isOnline()) {
    // 离线时拉不到任何在线副本，只能用安装记录里已存的那份
    if (stored !== '') {
      noteMaterial('当前离线，来源证书使用安装记录或信任清单里已存的那份')
    } else if (eecUrls.length > 0) {
      noteMaterial('当前离线，取不到来源站点的合集证书，也没有已存的来源证书，跳过 CMS 验签')
    }
    return stored
  }
  if (stored !== '') {
    return stored
  }
  for (const eecUrl of eecUrls) {
    const text = (await requestText(eecUrl)) ?? ''
    if (text !== '') {
      return text
    }
  }
  if (eecUrls.length > 0) {
    noteMaterial('没有取到来源站点的合集证书，certs 布局与 eec.pem 兜底都失败，跳过 CMS 验签')
  }
  return ''
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

/** 构建时注入的根证书 PEM；未注入时为空串 */
export const embeddedRootCa = (): string =>
  typeof __ROOT_CA_PEM__ === 'string' ? __ROOT_CA_PEM__ : ''

/**
 * 证书链校验结论。
 * ok 表示证书由内置根 CA 签发且在有效期内；chain 表示链校验不通过；
 * revoked 表示证书已被吊销；none 表示没有证书，或本机不具备校验条件。
 */
export type ChainState = 'ok' | 'chain' | 'revoked' | 'none'

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
 * 签名者证书必须能由内置根 CA 验证通过，链校验在 verifyDetachedCms 内部完成；
 * 证书不可用、链不通过、签名结构不符或验签失败都返回 false，不抛出异常。
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
  const rootPem = embeddedRootCa()
  const root = rootPem.trim() === '' ? null : parseCertificate(rootPem)
  const signer = parseCertificate(eecPem)
  if (!root || !signer) {
    return false
  }
  // pkijs 的分离验签要求内容为裸 ArrayBuffer 视图，这里把入参还原成该形态
  return await verifyDetachedCms(
    signature as Uint8Array<ArrayBuffer>,
    content as Uint8Array<ArrayBuffer>,
    signer,
    root
  )
}

/**
 * 用内置根 CA 校验证书链，取得吊销列表时一并检查吊销。
 * 未注入根证书或环境没有 WebCrypto 时返回 none，由调用方按无法确认处理；
 * 吊销列表由 online-data 分发，但吊销结论仍在本机用同一张根证书校验。
 */
export const verifyEecChain = async (eecPem: string): Promise<ChainState> => {
  const { ensurePkijsEngine, isRevoked, parseCertificate, verifyCertificateChain, verifyCrl } =
    await verifierModule()
  if (!ensurePkijsEngine()) {
    return 'none'
  }
  const rootPem = embeddedRootCa()
  const root = rootPem.trim() === '' ? null : parseCertificate(rootPem)
  if (!root) {
    return 'none'
  }
  const eec = parseCertificate(eecPem)
  if (!eec) {
    return 'chain'
  }
  const chain = await verifyCertificateChain(root, eec)
  if (!chain.ok) {
    return 'chain'
  }
  const crl = getTrustCrl()
  if (crl === null) {
    return 'ok'
  }
  const crlVerdict = await verifyCrl(crl, root)
  if (!crlVerdict.ok) {
    // 吊销列表本身不可用时吊销状态按未知处理，不据此把来源判为失败
    return 'ok'
  }
  return isRevoked(eec, crl) ? 'revoked' : 'ok'
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
  /** 合集 CMS 验签结论；没有证书、链校验不通过或没有 CMS 签名时为 null */
  cms: boolean | null
  /** 作者裸签名结论；没有作者材料时为 null */
  author: boolean | null
  /** 证书链结论；没有证书或本机不具备校验条件时为 none */
  chain: ChainState
  /** 汇总状态；任何一项不通过为 failed，完全没有材料为 unverified */
  state: SignatureState
}

/**
 * 校验一份产物字节。
 * 合集证书先用内置根 CA 校验证书链，链不通过时结论为 failed 且不再发起 CMS 验签；
 * 链通过后才做 CMS 验签。合集 CMS 签名与作者裸签名各自有材料才校验，
 * 全部通过为 verified；任何一项不通过为 failed；完全没有材料为 unverified。
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
    return { cms: null, author: null, chain: 'none', state: 'unverified' }
  }
  const chain: ChainState = cms === null ? 'none' : await verifyEecChain(cms.eec)
  if (cms !== null && chain !== 'ok') {
    // 链校验不通过时不进入 CMS 验签，作者签名属另一条信任路径，仍按材料校验
    const authorPassed =
      author === null ? null : await verifyAuthorSignature(content, author.sig, author.pub)
    return { cms: null, author: authorPassed, chain, state: 'failed' }
  }
  if (cms && !(await verifyCmsSignature(content, cms.sig, cms.eec))) {
    return { cms: false, author: null, chain, state: 'failed' }
  }
  if (author && !(await verifyAuthorSignature(content, author.sig, author.pub))) {
    return { cms: cms ? true : null, author: false, chain, state: 'failed' }
  }
  return { cms: cms ? true : null, author: author ? true : null, chain, state: 'verified' }
}

/** 来源结论的判定输入；只看本机的证书链与 CMS 验签结论 */
export type SourceVerdictInput = {
  /** 是否有来源信息；宿主内联安装或本地包没有来源，结论为 unknown */
  hasSource: boolean
  /** 证书链结论；none 表示没有拿到证书 */
  chain: ChainState
  /** CMS 验签结论；没有通过链校验的证书时为 null */
  cms: boolean | null
}

/** 来源结论与原因 */
export type SourceVerdictResult = {
  verdict: SourceVerdict
  reason: SourceVerdictReason
}

/**
 * 来源结论：证书链在本机校验通过且 CMS 验签通过才算已确认。
 * 链不通过（过期、非本根签发、被吊销）为 failed 并按 chain 或 revoked 区分原因；
 * 拿不到证书或验签不通过为 failed 并记为 other；完全没有来源信息才为 unknown。
 * 信任清单的结论不参与判定，只用于界面展示来源是否被官方认可。
 */
export const sourceVerdictOf = (input: SourceVerdictInput): SourceVerdictResult => {
  if (!input.hasSource) {
    return { verdict: 'unknown', reason: null }
  }
  if (input.chain === 'chain') {
    return { verdict: 'failed', reason: 'chain' }
  }
  if (input.chain === 'revoked') {
    return { verdict: 'failed', reason: 'revoked' }
  }
  if (input.chain === 'ok' && input.cms === true) {
    return { verdict: 'confirmed', reason: null }
  }
  return { verdict: 'failed', reason: 'other' }
}
