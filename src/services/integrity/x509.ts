import { Certificate, CryptoEngine, setEngine } from 'pkijs'
import { pemToDer } from './pem.js'

/** 证书链校验结论；reason 只用于排查，不直接展示给用户 */
export type ChainVerdict = { ok: true } | { ok: false; reason: string }

/** basicConstraints 扩展的 OID */
const BASIC_CONSTRAINTS_OID = '2.5.29.19'
/** keyUsage 扩展的 OID */
const KEY_USAGE_OID = '2.5.29.15'

let engineReady = false

/**
 * 把 pkijs 的密码学运算接到 WebCrypto 上，重复调用只设置一次。
 * 环境没有 WebCrypto 时返回 false，调用方据此静默跳过校验。
 */
export const ensurePkijsEngine = (): boolean => {
  if (engineReady) {
    return true
  }
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return false
  }
  setEngine('webcrypto', new CryptoEngine({ name: 'webcrypto', crypto, subtle: crypto.subtle }))
  engineReady = true
  return true
}

/** 解析 PEM 证书；头尾缺失、DER 非法或 ASN.1 结构不符时返回 null */
export const parseCertificate = (pem: string): Certificate | null => {
  const der = pemToDer(pem, 'CERTIFICATE')
  if (!der) {
    return null
  }
  try {
    return Certificate.fromBER(der)
  } catch {
    return null
  }
}

/** 读取 basicConstraints 的 CA 标志；未声明该扩展时返回 null */
const readCaFlag = (certificate: Certificate): boolean | null => {
  const extension = certificate.extensions?.find((item) => item.extnID === BASIC_CONSTRAINTS_OID)
  if (!extension) {
    return null
  }
  const value = extension.parsedValue as { cA?: unknown } | undefined
  return typeof value?.cA === 'boolean' ? value.cA : null
}

/**
 * keyUsage 是否含 digitalSignature；未声明该扩展时返回 false。
 * keyUsage 是 BIT STRING，digitalSignature 是 bit 0，即首个内容字节的最高位。
 */
const hasDigitalSignature = (certificate: Certificate): boolean => {
  const extension = certificate.extensions?.find((item) => item.extnID === KEY_USAGE_OID)
  const value = extension?.parsedValue as
    | { valueBlock?: { valueHexView?: Uint8Array } }
    | undefined
  const bytes = value?.valueBlock?.valueHexView
  return bytes !== undefined && bytes.length > 0 && (bytes[0] & 0x80) !== 0
}

/** 证书在给定时刻是否处于有效期内 */
const withinValidity = (certificate: Certificate, now: Date): boolean =>
  certificate.notBefore.value.getTime() <= now.getTime() &&
  now.getTime() <= certificate.notAfter.value.getTime()

/**
 * 校验证书链：EEC 由根证书签发。
 * 检查项为签发者与主体匹配、两端都在有效期内、根证书声明 CA:TRUE、EEC 的签名可用根证书公钥验证、
 * EEC 的 keyUsage 含 digitalSignature、EEC 不是 CA。任何一项不满足都返回失败原因，不抛出异常。
 */
export const verifyCertificateChain = async (
  root: Certificate,
  eec: Certificate,
  now: Date = new Date()
): Promise<ChainVerdict> => {
  if (!eec.issuer.isEqual(root.subject)) {
    return { ok: false, reason: 'EEC 的签发者与根证书主体不一致' }
  }
  if (!withinValidity(root, now)) {
    return { ok: false, reason: '根证书不在有效期内' }
  }
  if (!withinValidity(eec, now)) {
    return { ok: false, reason: 'EEC 不在有效期内' }
  }
  if (readCaFlag(root) !== true) {
    return { ok: false, reason: '根证书未声明 basicConstraints CA:TRUE' }
  }
  let signed = false
  try {
    signed = await eec.verify(root)
  } catch {
    signed = false
  }
  if (!signed) {
    return { ok: false, reason: 'EEC 的签名无法用根证书公钥验证' }
  }
  if (!hasDigitalSignature(eec)) {
    return { ok: false, reason: 'EEC 的 keyUsage 不含 digitalSignature' }
  }
  if (readCaFlag(eec) !== false) {
    return { ok: false, reason: 'EEC 必须是终端证书，不能声明 CA:TRUE' }
  }
  return { ok: true }
}
