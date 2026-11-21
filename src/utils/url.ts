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

/** 允许走 http 的本机回环主机 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * 远端取件地址判定: https 任意主机, 或 http 的本机回环地址。
 * 插件产物地址、插件市场来源、计数接口与资产读取共用这一条口径, 避免各自复制规则后漂移。
 */
export const isHttpsOrLocalUrl = (value: string): boolean => {
  let target: URL
  try {
    target = new URL(value)
  } catch {
    return false
  }
  if (target.protocol === 'https:') {
    return true
  }
  return target.protocol === 'http:' && LOCAL_HOSTS.has(target.hostname)
}
