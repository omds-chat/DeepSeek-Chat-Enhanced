/**
 * 材料请求的公共口径。
 * 在线副本只是备选材料：单个请求有短超时，离线时一个请求都不发，
 * 全部失败时由调用方回退到构建内嵌的那份。
 */

/** 单个材料请求的最长等待时间（毫秒） */
export const REQUEST_TIMEOUT = 1000

/**
 * 浏览器报告的联网状态。
 * 只有明确为 false 时才认定离线；环境没有 navigator 或缺少 onLine 时按在线处理，
 * 在线分支自带超时与回退，判定偏宽松不改变结论。
 */
export const isOnline = (): boolean =>
  typeof navigator === 'undefined' || navigator.onLine !== false

/** 材料选取痕迹；回退到本地或内嵌材料时说明当前用的是哪一份，便于排查 */
export const logMaterial = (scope: string, message: string): void => {
  // eslint-disable-next-line no-console
  console.warn('[' + scope + '] ' + message)
}

/** 带超时的请求；地址为空、离线、超时、网络失败与非 2xx 响应都返回 null */
const requestWith = async <T>(
  url: string,
  read: (response: Response) => Promise<T>
): Promise<T | null> => {
  if (url === '' || !isOnline()) {
    return null
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    return response.ok ? await read(response) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 取文本材料 */
export const requestText = (url: string): Promise<string | null> =>
  requestWith(url, (response) => response.text())

/** 取二进制材料 */
export const requestBytes = (url: string): Promise<Uint8Array<ArrayBuffer> | null> =>
  requestWith(url, async (response) => new Uint8Array(await response.arrayBuffer()))
