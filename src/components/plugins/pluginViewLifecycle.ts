import { getPluginEngine, subscribePageRegistry } from '../dsc-plugin-engine/index.js'
import { showToast } from '../base/toastState.js'
import { settleRevokedPage } from './pluginViewState.js'

/**
 * 页面撤销守卫: 订阅页面登记表。
 * 插件停用或卸载会撤销页面登记, 停在它页面上的会话视图随即自动退回会话视图,
 * 并用一次气泡说明; 插件名在登记还在时就记下来, 卸载后仍能给出可读的提示。
 * 只在页面登记变化时检查, 不轮询、不排队, 也不弹模态。
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
  return subscribePageRegistry(() => {
    rememberNames()
    const engine = getPluginEngine()
    settleRevokedPage(engine ? engine.pluginPages() : [], (page) => {
      showToast({
        key: 'pluginViewRevoked',
        params: { plugin: names.get(page.pluginId) ?? page.pluginId },
      })
    })
  })
}
