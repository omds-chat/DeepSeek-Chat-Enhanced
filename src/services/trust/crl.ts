import type { CertificateRevocationList } from 'pkijs'

/**
 * 信任清单分发并已在本地校验的吊销列表。
 * 清单只承担登记与分发，吊销结论仍由使用方用内置根证书校验后得出。
 */
let current: CertificateRevocationList | null = null

/** 当前生效的吊销列表；未取得、拉取失败或校验不通过时为 null */
export const getTrustCrl = (): CertificateRevocationList | null => current

/** 替换当前吊销列表；拉取失败或校验不通过时传 null */
export const setTrustCrl = (crl: CertificateRevocationList | null): void => {
  current = crl
}
