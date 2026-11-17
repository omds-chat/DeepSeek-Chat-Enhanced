import { dscMarketManifest, dscMarketPlugin } from '../dsc-market/index.js'
import type { DscPlugin, PluginManifest } from './types.js'

/** 内置插件条目 */
export type BuiltinPlugin = {
  manifest: PluginManifest
  /** 每次装载都取一份新的插件对象，避免多次激活共用状态 */
  factory: () => DscPlugin
}

/** 内置插件清单；启动时按顺序装载 */
export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = [
  { manifest: dscMarketManifest, factory: () => dscMarketPlugin },
]

/** 内置插件 id 集合；net:fetch 只对这些插件可见 */
export const BUILTIN_PLUGIN_IDS: readonly string[] = BUILTIN_PLUGINS.map(
  (item) => item.manifest.id
)
