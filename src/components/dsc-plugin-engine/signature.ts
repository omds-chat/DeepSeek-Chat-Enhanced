import { verifyBytesSignature } from '../../services/integrity/ed25519.js'

/** 一次产物校验的结论；unreachable 表示字节没拿到，不能据此判定篡改 */
export type ArtifactVerdict = 'verified' | 'failed' | 'unreachable'

/** 拉取插件产物字节；网络失败与非 2xx 响应都返回 null */
export const fetchArtifactBytes = async (url: string): Promise<Uint8Array | null> => {
  try {
    const response = await fetch(url, { cache: 'no-store' })
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null
  } catch {
    return null
  }
}

/**
 * 校验插件产物签名：拉取当前 plugin.js 字节，做 SHA-512 摘要后用 pub 验签。
 * 字节拉取失败返回 unreachable，由调用方按恢复失败处理，不误报篡改。
 */
export const verifyArtifactSignature = async (
  url: string,
  pub: string,
  sign: string
): Promise<ArtifactVerdict> => {
  const bytes = await fetchArtifactBytes(url)
  if (!bytes) {
    return 'unreachable'
  }
  return (await verifyBytesSignature(bytes, sign, pub)) ? 'verified' : 'failed'
}
