/** 合集信任结论；untrusted 表示信任签名校验未通过或材料缺失 */
export type CollectionTrust = 'trusted' | 'untrusted'

/** 合集不可信的原因；publicKey 表示公钥文件本身不可用 */
export type TrustFailureReason = 'missing' | 'signature' | 'publicKey'

/** 信任清单中的单个合集；不可信的条目同样列出，只是不给公钥 */
export type TrustCollection = {
  id: string
  /** 合集公钥 PEM；不可信时为 null，避免被当作可信公钥使用 */
  publicKey: string | null
  trust: CollectionTrust
  /** 不可信的原因；可信时为 null */
  reason: TrustFailureReason | null
}

/** 一次核对得到的信任清单快照 */
export type TrustList = {
  /** 内嵌的 dsc 公钥与拉取到的 web_public.pem 是否一致；不一致时清单不被采信 */
  webKeyMatched: boolean
  /** 实际生效的清单来源地址；未拉到时为 null */
  origin: string | null
  /** 清单里的合集，含不可信条目 */
  collections: TrustCollection[]
}
