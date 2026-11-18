import { ensureTrustList } from '../../services/trust/index.js'
import type { DscPlugin, PluginManifest } from '../dsc-plugin-engine/types.js'
import { createMarketClient, type MarketClient } from './client.js'

/** 内置插件清单；POST 计数请求复用 net:fetch 的申请口径，不额外声明能力 */
export const dscMarketManifest: PluginManifest = {
  id: 'dsc-market',
  name: 'dsc-market',
  version: '1.0.0',
  engines: '^1.0.0',
  capabilities: ['net:fetch', 'plugins:storage'],
}

let client: MarketClient | null = null

/** 查询入口；插件未激活时返回 null */
export const market = (): MarketClient | null => client

/** 内置插件对象；激活后异步解析首个来源，失败只写入插件日志 */
export const dscMarketPlugin: DscPlugin = {
  activate(context) {
    // 信任清单与来源解析并行准备，来源解析时若清单已就绪则优先使用其中的公钥
    ensureTrustList()
    const instance = createMarketClient(context.net, context.storage)
    client = instance
    const first = instance.sources()[0]
    if (!first) {
      return
    }
    void instance.refresh(first.id).then((runtime) => {
      if (!runtime) {
        context.log('market: no source selected')
        return
      }
      context.log(
        'market: ' +
          first.id +
          ' ' +
          runtime.state +
          ', trust ' +
          runtime.trust +
          ', plugins ' +
          String(runtime.plugins.length) +
          ', skipped ' +
          String(runtime.skipped)
      )
    })
  },
  deactivate() {
    client = null
  },
}

export { parseDatalog, parseRuntimeMeta, parseSourceMeta, parseVersions, toPluginId } from './client.js'
export type { MarketClient } from './client.js'
export type {
  CatalogPlugin,
  InstallPlan,
  LocalizedText,
  MarketSource,
  RuntimeMeta,
  SourceMeta,
  SourceRuntime,
  SourceTrust,
  TrustFailure,
} from './types.js'
