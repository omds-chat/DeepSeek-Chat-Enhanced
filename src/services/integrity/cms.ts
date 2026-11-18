import { ContentInfo, SignedData, type Certificate } from 'pkijs'

/**
 * 校验 CMS 分离签名。
 * 签名产物由 openssl cms -sign -binary -outform DER -nocerts -noattr 生成，是裸 DER 编码；
 * 不带证书，签名者证书由调用方在校验证书链后传入。
 * 结构不符、签名者不匹配、验签失败都返回 false，不抛出异常。
 */
export const verifyDetachedCms = async (
  signature: Uint8Array<ArrayBuffer>,
  content: Uint8Array<ArrayBuffer>,
  signer: Certificate
): Promise<boolean> => {
  try {
    const cms = ContentInfo.fromBER(signature)
    if (cms.contentType !== ContentInfo.SIGNED_DATA) {
      return false
    }
    const signedData = new SignedData({ schema: cms.content })
    // 分离签名不带证书，这里补上已通过证书链校验的签名者证书
    signedData.certificates = [signer]
    const data = content.slice().buffer as ArrayBuffer
    return await signedData.verify({
      signer: 0,
      data,
      trustedCerts: [signer],
      checkChain: false,
    })
  } catch {
    return false
  }
}
