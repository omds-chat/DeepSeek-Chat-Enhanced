import type { NetCapability } from '../dsc-plugin-engine/types.js'
import type { SourceMeta } from './types.js'

/** 计数上报器；只负责发出请求，不关心结果 */
export type DownloadReporter = {
  report(meta: SourceMeta, pluginName: string): void
}

/**
 * 创建下载计数上报器。
 * 来源启用计数且配置了地址时，向该地址发一次 POST，body 只含插件名与请求时间。
 * 不携带 IP：接收方从请求来源自行获取，客户端不查询也不上报。
 * 不等待响应，失败静默，不阻塞安装。
 */
export const createDownloadReporter = (net: NetCapability): DownloadReporter => ({
  report: (meta, pluginName) => {
    if (!meta.downloadCountEnabled || meta.downloadCountApi === '') {
      return
    }
    const time = new Date().toISOString()
    // 整体丢到后台：不等待响应，也不把失败抛给安装流程
    void (async () => {
      try {
        await net.postJson(meta.downloadCountApi, { plugin: pluginName, time })
      } catch {
        // 计数失败不影响安装
      }
    })()
  },
})
