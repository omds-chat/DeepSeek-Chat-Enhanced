import { useSyncExternalStore } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  getPluginEngine,
  pageRegistryRevision,
  subscribePageRegistry,
} from '../dsc-plugin-engine/index.js'
import { pluginPageViews, type PluginPageViewItem } from './pluginViews.js'

/**
 * 读出全部已登记的页面, 作为会话视图列表的「插件视图」分组。
 * 订阅登记表: 插件激活时登记页面、停用或卸载时撤销, 列表随时增删, 不需要手动刷新;
 * 引擎未就绪或没有插件登记页面时返回空数组, 分组整块不出现。
 */
export const usePluginPageViews = (): PluginPageViewItem[] => {
  const t = useTranslate()
  useSyncExternalStore(subscribePageRegistry, pageRegistryRevision)
  const engine = getPluginEngine()
  if (!engine) {
    return []
  }
  return pluginPageViews(engine.pluginPages(), engine.list(), t)
}
