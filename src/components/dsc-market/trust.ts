import {
  base64ToBytes,
  readPublicKey,
  sha512,
  verifyEd25519,
} from '../../services/integrity/ed25519.js'

/** 合集信任签名校验结论 */
export type SetSignatureVerdict = 'verified' | 'missing' | 'signature'

/** 构建时注入的 dsc 公钥；未注入时为空串 */
export const dscKeyPem = (): string =>
  typeof __WEB_PUBLIC_KEY__ === 'string' ? __WEB_PUBLIC_KEY__ : ''

/** 是否有可用于校验信任链的 dsc 公钥 */
export const hasDscKey = (): boolean => readPublicKey(dscKeyPem()) !== null

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 取出 signer 为 dsc 的签名值；结构不符返回 null */
const readDscSignatures = (text: string): string[] | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.sign)) {
    return null
  }
  const values: string[] = []
  for (const item of parsed.sign) {
    if (!isRecord(item)) {
      return null
    }
    const { value, signer } = item
    if (typeof value !== 'string' || typeof signer !== 'string') {
      return null
    }
    if (signer === 'dsc' && value !== '') {
      values.push(value)
    }
  }
  return values
}

/**
 * 校验合集信任签名：被签名对象是 plugin_secret.pub 的字节，
 * 先做 SHA-512 摘要，再用 dsc 公钥验证 signer 为 dsc 的 Ed25519 签名。
 * 没有 dsc 签名返回 missing，签名不通过返回 signature。
 */
export const verifySetSignature = async (
  pubText: string,
  signText: string,
  keyPem: string
): Promise<SetSignatureVerdict> => {
  const values = readDscSignatures(signText)
  if (!values || values.length === 0) {
    return 'missing'
  }
  const publicKey = readPublicKey(keyPem)
  if (!publicKey) {
    return 'missing'
  }
  const digest = await sha512(new TextEncoder().encode(pubText))
  for (const value of values) {
    const signature = base64ToBytes(value)
    if (!signature) {
      continue
    }
    if (await verifyEd25519(signature, digest, publicKey)) {
      return 'verified'
    }
  }
  return 'signature'
}
