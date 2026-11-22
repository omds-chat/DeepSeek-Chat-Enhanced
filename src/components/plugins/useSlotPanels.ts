import { useSyncExternalStore } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  getPluginEngine,
  slotRegistryRevision,
  subscribeSlotRegistry,
} from '../dsc-plugin-engine/index.js'
import { slotPanelItems, type SlotPanelItem } from './pluginViews.js'

/**
 * 读出全部已登记的槽位, 作为侧边栏导航行与会话视图标签栏的条目。
 * 订阅登记表: 插件激活时登记、停用或卸载时撤销, 列表随时增删, 不需要手动刷新;
 * 引擎未就绪或没有插件登记槽位时返回空数组, 相关区域整块不出现。
 */
export const useSlotPanels = (): SlotPanelItem[] => {
  const t = useTranslate()
  useSyncExternalStore(subscribeSlotRegistry, slotRegistryRevision)
  const engine = getPluginEngine()
  if (!engine) {
    return []
  }
  return slotPanelItems(engine.slots(), engine.list(), t)
}
