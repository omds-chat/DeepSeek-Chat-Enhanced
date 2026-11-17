import type { DscPlugin, PluginFactory } from './types.js'

/** 运行时加载的默认超时（毫秒） */
const DEFAULT_TIMEOUT = 10000

const isPlugin = (value: unknown): value is DscPlugin =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { activate?: unknown }).activate === 'function'

const isFactory = (value: unknown): value is PluginFactory => typeof value === 'function'

/** 从插件产物里取出插件实例；支持实例、工厂与 default 导出 */
export const resolvePluginInstance = async (module: unknown): Promise<DscPlugin> => {
  const exported = isPlugin(module) ? module : (module as { default?: unknown } | null)?.default
  if (isPlugin(exported)) {
    return exported
  }
  if (isFactory(exported)) {
    return await exported()
  }
  if (isFactory(module)) {
    return await module()
  }
  throw new Error('dsc-plugin-engine: plugin artifact does not export activate')
}

/** 运行时加载插件产物；只接受 http(s) 地址 */
export const loadPluginModule = async (
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT
): Promise<unknown> => {
  const target = new URL(url, window.location.href)
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('dsc-plugin-engine: unsupported plugin protocol')
  }
  // 运行时导入绕过打包器，产物按普通 ESM 加载
  const importModule = new Function('specifier', 'return import(specifier)') as unknown as (
    specifier: string
  ) => Promise<unknown>
  const loading = importModule(target.href)
  void loading.catch(() => undefined)
  let timer = 0
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error('dsc-plugin-engine: plugin load timed out'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([loading, timeout])
  } finally {
    window.clearTimeout(timer)
  }
}
