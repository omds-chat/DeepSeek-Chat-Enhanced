/**
 * 链接协议判定：只接受 HTTP / HTTPS。
 * 非字符串、相对路径与畸形地址一律返回 false。
 */
export const isWebUrl = (value: string): boolean => {
  if (typeof value !== 'string') {
    return false
  }
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
