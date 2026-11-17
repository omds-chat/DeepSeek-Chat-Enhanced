import { readManifest } from './registry.js'
import type { DscPlugin, LoadedPlugin, PluginFactory, PluginManifest } from './types.js'

/** 运行时加载的默认超时（毫秒） */
const DEFAULT_TIMEOUT = 10000

/** 允许走 http 的本机回环主机 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * 插件来源地址判定：https 任意主机，或 http 的本机回环地址。
 * 面板与加载器共用同一判定，避免两处规则漂移。
 */
export const isPluginSourceAllowed = (value: string): boolean => {
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

const isPlugin = (value: unknown): value is DscPlugin =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { activate?: unknown }).activate === 'function'

const isFactory = (value: unknown): value is PluginFactory => typeof value === 'function'

/** 读取产物自带的清单：先看模块顶层的 manifest，再看 default 导出上的 manifest */
const readModuleManifest = (module: unknown): PluginManifest | null => {
  if (typeof module !== 'object' || module === null) {
    return null
  }
  const record = module as { manifest?: unknown; default?: unknown }
  const direct = readManifest(record.manifest)
  if (direct) {
    return direct
  }
  const fallback = record.default
  if (typeof fallback === 'object' && fallback !== null) {
    return readManifest((fallback as { manifest?: unknown }).manifest)
  }
  return null
}

/** 从插件产物里取出插件实例与自带清单；支持实例、工厂与 default 导出 */
export const resolvePluginModule = async (module: unknown): Promise<LoadedPlugin> => {
  const manifest = readModuleManifest(module)
  const exported = isPlugin(module) ? module : (module as { default?: unknown } | null)?.default
  let plugin: DscPlugin
  if (isPlugin(exported)) {
    plugin = exported
  } else if (isFactory(exported)) {
    plugin = await exported()
  } else if (isFactory(module)) {
    plugin = await module()
  } else {
    throw new Error('dsc-plugin-engine: plugin artifact does not export activate')
  }
  return manifest ? { plugin, manifest } : { plugin }
}

/** 运行时加载插件产物；只接受 http(s) 地址 */
export const loadPluginModule = async (
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT
): Promise<unknown> => {
  const target = new URL(url, window.location.href)
  if (!isPluginSourceAllowed(target.href)) {
    throw new Error('dsc-plugin-engine: plugin source must use https or a local http host')
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
