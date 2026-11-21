import { isHttpsOrLocalUrl } from '../../utils/url.js'
import { readManifest } from './registry.js'
import type { DscPlugin, LoadedPlugin, PluginFactory, PluginManifest } from './types.js'

/** 运行时加载的默认超时（毫秒） */
const DEFAULT_TIMEOUT = 10000

/**
 * 插件来源地址判定：https 任意主机，或 http 的本机回环地址。
 * 规则收敛在 utils 里，面板、加载器、市场与资产读取共用同一份实现，避免多处复制后漂移。
 */
export const isPluginSourceAllowed = (value: string): boolean => isHttpsOrLocalUrl(value)

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

/**
 * 导入模块并施加超时。
 * 运行时导入绕过打包器，产物按普通 ESM 加载；地址判定由调用方负责。
 */
const importModule = async (specifier: string, timeoutMs: number): Promise<unknown> => {
  const importRuntime = new Function('specifier', 'return import(specifier)') as unknown as (
    specifier: string
  ) => Promise<unknown>
  const loading = importRuntime(specifier)
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

/** 运行时加载插件产物；只接受 http(s) 地址 */
export const loadPluginModule = async (
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT
): Promise<unknown> => {
  const target = new URL(url, window.location.href)
  if (!isPluginSourceAllowed(target.href)) {
    throw new Error('dsc-plugin-engine: plugin source must use https or a local http host')
  }
  return await importModule(target.href, timeoutMs)
}

/**
 * 加载存进安装记录的插件代码：先建 Blob URL 再导入，导入结束后立即释放。
 * 本地插件没有分发地址，启动恢复只能走这条路径；代码是单文件 ESM，不解析相对导入。
 */
export const loadPluginModuleFromCode = async (
  code: string,
  timeoutMs: number = DEFAULT_TIMEOUT
): Promise<unknown> => {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  try {
    return await importModule(url, timeoutMs)
  } finally {
    URL.revokeObjectURL(url)
  }
}
