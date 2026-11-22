import { useSyncExternalStore } from 'react'
import {
  getPluginEngine,
  slotRegistryRevision,
  subscribeSlotRegistry,
  type PluginStateView,
  type SlotEntry,
} from '../dsc-plugin-engine/index.js'

/** 登记表为空时的固定返回值; 引用稳定, 免得每次渲染都产生新数组 */
const EMPTY_ENTRIES: readonly SlotEntry[] = []
const EMPTY_PLUGINS: readonly PluginStateView[] = []

/**
 * 读出整份槽位登记表, 并订阅它的变更。
 * 与 useSlotPanels 同法: 插件激活时登记、停用或卸载时撤销, 界面随时增删, 不需要手动刷新;
 * 引擎未就绪时返回空数组, 依赖登记表的区域整块不出现。
 */
export const useSlotRegistry = (): {
  entries: readonly SlotEntry[]
  plugins: readonly PluginStateView[]
} => {
  useSyncExternalStore(subscribeSlotRegistry, slotRegistryRevision)
  const engine = getPluginEngine()
  if (!engine) {
    return { entries: EMPTY_ENTRIES, plugins: EMPTY_PLUGINS }
  }
  return { entries: engine.slots(), plugins: engine.list() }
}
