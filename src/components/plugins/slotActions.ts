import { getPluginEngine } from '../dsc-plugin-engine/index.js'

/**
 * 非页面型槽位的动作分发。
 * 宿主界面只交「哪个插件、哪个槽位、哪个登记项、哪个动作键」, 载荷统一走 ui:slot-action,
 * 并且一定带 slot 字段(插件按它区分工具条、消息动作与菜单项的同一份回调)。
 * 这些槽位没有页面模型, 因此不看返回的 refresh 指示; 异步工作由插件自行发起并通知。
 */

/**
 * 工具条按钮与右键菜单项: actionId 取登记描述里的 actionKey。
 * itemKey 只在右键菜单项上出现, 值是该项所针对的消息 id 或会话 id, 插件据此知道操作对象。
 */
export const dispatchActionRow = (
  row: { readonly pluginId: string; readonly id: string; readonly actionKey: string },
  slot: 'composer.toolbar' | 'menu.item',
  itemKey?: string
): void => {
  getPluginEngine()?.dispatchSlotAction(row.pluginId, {
    slot,
    id: row.id,
    actionId: row.actionKey,
    ...(itemKey === undefined ? {} : { itemKey }),
  })
}

/** 消息操作行: actionId 取条目键, itemKey 带消息 id, 插件据此知道是哪条消息 */
export const dispatchMessageAction = (
  row: { readonly pluginId: string; readonly id: string; readonly actionId: string },
  messageId: string
): void => {
  getPluginEngine()?.dispatchSlotAction(row.pluginId, {
    slot: 'message.actions',
    id: row.id,
    actionId: row.actionId,
    itemKey: messageId,
  })
}
