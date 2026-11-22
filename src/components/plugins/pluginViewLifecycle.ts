import { getPluginEngine, subscribeSlotRegistry } from '../dsc-plugin-engine/index.js'
import { showToast } from '../base/toastState.js'
import { settleRevokedPage, type SlotPageRef } from './pluginViewState.js'

/**
 * 槽位撤销守卫: 订阅槽位登记表。
 * 插件停用或卸载会撤销槽位登记, 停在它页面上的视图随即自动退回会话视图,
 * 并用一次气泡说明; 插件名在登记还在时就记下来, 卸载后仍能给出可读的提示。
 * 只在登记变化时检查, 不轮询、不排队, 也不弹模态。
 */
export const bindPluginViewLifecycle = (): (() => void) => {
  /** 见过的插件名; 卸载会把记录抹掉, 提示里的名字只能来自这里 */
  const names = new Map<string, string>()
  const rememberNames = (): void => {
    const engine = getPluginEngine()
    if (!engine) {
      return
    }
    for (const plugin of engine.list()) {
      names.set(plugin.id, plugin.name)
    }
  }
  rememberNames()
  return subscribeSlotRegistry(() => {
    rememberNames()
    const engine = getPluginEngine()
    const pages: SlotPageRef[] = engine
      ? engine.slots().map((entry) => ({
          slot: entry.slot,
          pluginId: entry.pluginId,
          id: entry.id,
        }))
      : []
    settleRevokedPage(pages, (page) => {
      showToast({
        key: 'pluginViewRevoked',
        params: { plugin: names.get(page.pluginId) ?? page.pluginId },
      })
    })
  })
}
