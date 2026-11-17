import type { DscPlugin, PluginManifest } from '../dsc-plugin-engine/types.js'
import { createMarketClient, type MarketClient } from './client.js'

/** 内置插件清单 */
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

/** 内置插件对象；激活后异步刷新索引，失败只写入插件日志 */
export const dscMarketPlugin: DscPlugin = {
  activate(context) {
    const instance = createMarketClient(context.net, context.storage)
    client = instance
    void instance.refresh().then((status) => {
      context.log(`market: ${status.state}, entries ${status.total}, skipped ${status.skipped}`)
    })
  },
  deactivate() {
    client = null
  },
}

export type { MarketClient } from './client.js'
export type { MarketEntry, MarketIndex, MarketState, MarketStatus } from './types.js'
