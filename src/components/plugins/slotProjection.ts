import type {
  MenuTarget,
  NoticeLevel,
  PluginStateView,
  SlotEntry,
} from '../dsc-plugin-engine/index.js'
import type { TranslationKey } from '../../i18n/index.js'
import type { Translate } from './pluginPageText.js'

/**
 * 非页面型槽位的渲染模型。
 * 宿主界面不直接读登记表字段, 而是先经这里派生为可直接渲染的行:
 * 文案在渲染时解析(键优先、直给文案兜底), 条目按登记表给出的顺序保留,
 * 插件名从插件列表补全, 键是「插件 id + 槽位 id + 条目键」以避免跨插件撞名。
 * 全部是纯函数: 不读引擎、不订阅, 夹具可以直接喂登记表进来。
 */

/** 一条通知的渲染行; composer.notice 与 overlay.notice 共用 */
export type NoticeRow = {
  readonly key: string
  readonly pluginId: string
  readonly id: string
  readonly level: NoticeLevel
  readonly text: string
}

/** 一个插件的全部 overlay.notice 条目; 同一插件的多条通知合并成一张卡片 */
export type NoticeGroup = {
  readonly pluginId: string
  readonly pluginName: string
  readonly items: readonly NoticeRow[]
}

/** 工具条按钮与右键菜单项的渲染行 */
export type ActionRow = {
  readonly key: string
  readonly pluginId: string
  readonly id: string
  readonly actionKey: string
  readonly label: string
}

/** 消息操作行的一个按钮; actionId 是登记描述里的条目键 */
export type MessageActionRow = {
  readonly key: string
  readonly pluginId: string
  readonly id: string
  readonly actionId: string
  readonly label: string
}

/** 通知正文: textKey 走宿主字典, text 原样显示, 都没有时为空串(调用方据此不渲染) */
export const noticeText = (
  source: { readonly textKey?: string; readonly text?: string },
  t: Translate
): string =>
  typeof source.textKey === 'string' ? t(source.textKey as TranslationKey) : (source.text ?? '')

/** 插件名查表; 未登记的插件回落为插件 id */
const nameOf = (plugins: readonly PluginStateView[]): Map<string, string> =>
  new Map(plugins.map((plugin) => [plugin.id, plugin.name]))

/** 按槽位过滤登记项, 保持登记表给定的槽位内顺序 */
const entriesOf = (entries: readonly SlotEntry[], slot: SlotEntry['slot']): SlotEntry[] =>
  entries.filter((entry) => entry.slot === slot)

/** settings.page 的登记项; 设置对话框的「插件」分组按此列出 */
export const settingsPages = (
  entries: readonly SlotEntry[],
  plugins: readonly PluginStateView[],
  t: Translate
): { key: string; pluginId: string; id: string; title: string; pluginName: string }[] => {
  const names = nameOf(plugins)
  return entriesOf(entries, 'settings.page').flatMap((entry) => {
    const d = entry.descriptor
    if (d.slot !== 'settings.page') {
      return []
    }
    return [
      {
        key: entry.pluginId + '/' + entry.id,
        pluginId: entry.pluginId,
        id: entry.id,
        title: typeof d.titleKey === 'string' ? t(d.titleKey as TranslationKey) : (d.title ?? d.id),
        pluginName: names.get(entry.pluginId) ?? entry.pluginId,
      },
    ]
  })
}

/** composer.toolbar 的按钮; order 与登记顺序已在登记表内排好 */
export const composerToolbarRows = (
  entries: readonly SlotEntry[],
  t: Translate
): ActionRow[] =>
  entriesOf(entries, 'composer.toolbar').flatMap((entry) => {
    const d = entry.descriptor
    if (d.slot !== 'composer.toolbar') {
      return []
    }
    return [
      {
        key: entry.pluginId + '/' + entry.id,
        pluginId: entry.pluginId,
        id: entry.id,
        actionKey: d.actionKey,
        label:
          typeof d.labelKey === 'string' ? t(d.labelKey as TranslationKey) : (d.label ?? entry.id),
      },
    ]
  })

/** composer.notice 的通知条; 输入框上方的通知条按此逐条渲染 */
export const composerNoticeRows = (
  entries: readonly SlotEntry[],
  t: Translate
): NoticeRow[] =>
  entriesOf(entries, 'composer.notice').flatMap((entry) => {
    const d = entry.descriptor
    if (d.slot !== 'composer.notice') {
      return []
    }
    return [
      {
        key: entry.pluginId + '/' + entry.id,
        pluginId: entry.pluginId,
        id: entry.id,
        level: d.tone,
        text: noticeText(d, t),
      },
    ]
  })

/** overlay.notice 按插件分组; 同一插件的多条通知合到一张卡片里 */
export const overlayNoticeGroups = (
  entries: readonly SlotEntry[],
  plugins: readonly PluginStateView[],
  t: Translate
): NoticeGroup[] => {
  const names = nameOf(plugins)
  const groups = new Map<string, NoticeRow[]>()
  for (const entry of entriesOf(entries, 'overlay.notice')) {
    const d = entry.descriptor
    if (d.slot !== 'overlay.notice') {
      continue
    }
    const rows = groups.get(entry.pluginId) ?? []
    rows.push({
      key: entry.pluginId + '/' + entry.id,
      pluginId: entry.pluginId,
      id: entry.id,
      level: d.level,
      text: noticeText(d, t),
    })
    groups.set(entry.pluginId, rows)
  }
  return [...groups].map(([pluginId, items]) => ({
    pluginId,
    pluginName: names.get(pluginId) ?? pluginId,
    items,
  }))
}

/** message.actions 的按钮; 每条消息底部都渲染同一组按钮 */
export const messageActionRows = (
  entries: readonly SlotEntry[],
  t: Translate
): MessageActionRow[] =>
  entriesOf(entries, 'message.actions').flatMap((entry) => {
    const d = entry.descriptor
    if (d.slot !== 'message.actions') {
      return []
    }
    return d.items.map((item) => ({
      key: entry.pluginId + '/' + entry.id + '/' + item.key,
      pluginId: entry.pluginId,
      id: entry.id,
      actionId: item.key,
      label:
        typeof item.labelKey === 'string'
          ? t(item.labelKey as TranslationKey)
          : (item.label ?? item.key),
    }))
  })

/** menu.item 中属于某个目标面的项; 右键菜单按此追加自定义项 */
export const menuRows = (
  entries: readonly SlotEntry[],
  target: MenuTarget,
  t: Translate
): ActionRow[] =>
  entriesOf(entries, 'menu.item').flatMap((entry) => {
    const d = entry.descriptor
    if (d.slot !== 'menu.item' || d.target !== target) {
      return []
    }
    return [
      {
        key: entry.pluginId + '/' + entry.id,
        pluginId: entry.pluginId,
        id: entry.id,
        actionKey: d.actionKey,
        label:
          typeof d.labelKey === 'string' ? t(d.labelKey as TranslationKey) : (d.label ?? entry.id),
      },
    ]
  })
