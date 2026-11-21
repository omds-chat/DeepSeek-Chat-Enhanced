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

/** 允许走 http 的回环主机 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * http 放行策略。
 * 缺省只放行回环地址; allowLanHttp 打开后, 供应端点校验额外放行
 * 私有网段与其它非回环主机的 http, 只给这一条通道使用。
 */
export type HttpEndpointPolicy = {
  readonly allowLanHttp?: boolean
}

/** 回环主机判定; 主机名由 URL 解析归一为小写 */
const isLocalHost = (hostname: string): boolean => LOCAL_HOSTS.has(hostname)

/**
 * 远端取件地址判定: https 任意主机, 或 http 的回环地址。
 * 插件产物地址、插件市场来源、计数接口与资产读取共用这一条默认口径, 避免各自复制规则后漂移。
 * 供应端点校验需要额外放行局域网 http 时传入 allowLanHttp;
 * 其余通道不传这个参数, 口径保持不变。
 */
export const isHttpsOrLocalUrl = (value: string, policy?: HttpEndpointPolicy): boolean => {
  let target: URL
  try {
    target = new URL(value)
  } catch {
    return false
  }
  if (target.protocol === 'https:') {
    return true
  }
  if (target.protocol !== 'http:') {
    return false
  }
  return isLocalHost(target.hostname) || policy?.allowLanHttp === true
}
