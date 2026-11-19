import { ContentInfo, SignedData, type Certificate } from 'pkijs'
import { ensurePkijsEngine, verifyCertificateChain } from './x509.js'

/**
 * 校验 CMS 分离签名。
 * 签名产物由 openssl cms -sign -binary -outform DER -nocerts -noattr 生成，是裸 DER 编码；
 * 不带证书，签名者证书由调用方传入，根证书必须一并传入。
 * 函数内部先用根证书校验证书链，链不通过直接返回 false，未校验链的证书不会进入验签；
 * 结构不符、签名者不匹配、验签失败同样返回 false，不抛出异常。
 */
export const verifyDetachedCms = async (
  signature: Uint8Array<ArrayBuffer>,
  content: Uint8Array<ArrayBuffer>,
  signer: Certificate,
  root: Certificate
): Promise<boolean> => {
  try {
    if (!ensurePkijsEngine()) {
      return false
    }
    // 证书链是验签的前置条件：链校验不通过的证书一律不参与 CMS 验签
    const chain = await verifyCertificateChain(root, signer)
    if (!chain.ok) {
      return false
    }
    const cms = ContentInfo.fromBER(signature)
    if (cms.contentType !== ContentInfo.SIGNED_DATA) {
      return false
    }
    const signedData = new SignedData({ schema: cms.content })
    // 分离签名不带证书，这里补上已通过证书链校验的签名者证书；checkChain 关闭的前提就是上面这次链校验
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
