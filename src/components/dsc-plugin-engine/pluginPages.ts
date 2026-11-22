import {
  SETTING_KEY_PATTERN,
  checkSettingDescriptor,
  checkLabel,
  type SettingFieldDescriptor,
  type SettingValue,
} from './pluginSettings.js'
import { isTranslationKey } from '../../i18n/index.js'

/**
 * 插件页面(ui:page)的引擎侧实现。
 * 插件在激活期用 context.ui.registerPage(descriptor) 登记一份声明式页面描述, 宿主据此渲染页面;
 * 与 settings:surface 同法, 插件只交描述、不交控件, 渲染、i18n 与样式全部归宿主。
 * 页面数据由注册时的描述作为缺省模型; 插件实现 ui:page-data 挂载点后,
 * 宿主在进入页面与动作返回刷新指示时向插件索取当前模型。
 * 页面动作经 ui:page-action 挂载点同步回调插件; 异步工作由插件自行发起并用 notify 提示。
 */

/** 页面区块的四种类型; 控件形态由宿主按类型渲染, 插件不交控件 */
export type PageBlockType = 'list' | 'form' | 'text' | 'actions'

/** 动作按钮描述; actions 区块与 list 区块的逐条动作共用这一形态 */
export type PageActionDescriptor = {
  /** 动作键; 回调时作为 actionId 交给插件 */
  readonly key: string
  readonly labelKey?: string
  readonly label?: string
}

/** list 区块的单个条目 */
export type PageListItemDescriptor = {
  /** 条目键; 逐条动作回调时作为 itemKey 交给插件 */
  readonly key: string
  readonly titleKey?: string
  readonly title?: string
  readonly description?: string
  readonly badgeKey?: string
  readonly badge?: string
}

/** list 区块; 条目数组, 可带一个逐条动作 */
export type PageListBlock = {
  readonly id: string
  readonly type: 'list'
  readonly items: readonly PageListItemDescriptor[]
  readonly itemAction?: PageActionDescriptor
}

/** form 区块; 复用 settings:surface 的五种字段描述, 值的生命周期归宿主表单模型 */
export type PageFormBlock = {
  readonly id: string
  readonly type: 'form'
  readonly fields: readonly SettingFieldDescriptor[]
}

/** text 区块; 静态说明文字 */
export type PageTextBlock = {
  readonly id: string
  readonly type: 'text'
  readonly text: string
}

/** actions 区块; 按钮组 */
export type PageActionsBlock = {
  readonly id: string
  readonly type: 'actions'
  readonly items: readonly PageActionDescriptor[]
}

export type PageBlock = PageListBlock | PageFormBlock | PageTextBlock | PageActionsBlock

/** registerPage 返回的句柄; 释放函数撤销该页面的登记 */
export type PluginPageHandle = {
  readonly id: string
  dispose(): void
}

/** 一份插件页面描述 */
export type PageDescriptor = {
  /** 页面 id; 同一插件内不得重复, 与插件 id 共同构成页面入口的键 */
  readonly id: string
  readonly titleKey?: string
  readonly title?: string
  readonly blocks: readonly PageBlock[]
}

/** 描述被拒绝的原因; 结构化交给插件与日志 */
export type PageDescriptorProblem =
  | 'not-object'
  | 'invalid-id'
  | 'invalid-label'
  | 'no-blocks'
  | 'too-many-blocks'
  | 'descriptor-too-large'
  | 'block-not-object'
  | 'invalid-block'
  | 'duplicate-block-id'
  | 'unknown-block-type'
  | 'invalid-item'
  | 'invalid-action'
  | 'invalid-text'
  | 'invalid-form-fields'
  | 'duplicate-field-key'

/** 描述非法; registerPage 抛出, code 是机器可判定的问题码 */
export class PluginPageError extends Error {
  constructor(readonly code: PageDescriptorProblem) {
    super(`dsc-plugin-engine: page descriptor rejected (${code})`)
    this.name = 'PluginPageError'
  }
}

/** 页面 id 与区块 id、条目键、动作键共用 settings 字段键的词表 */
export const PAGE_KEY_PATTERN = SETTING_KEY_PATTERN

/** 页面描述的规模上限, 口径与 pluginSettings 对齐 */
export const MAX_PAGE_BLOCKS = 64
export const MAX_PAGE_LIST_ITEMS = 200
export const MAX_PAGE_ACTIONS = 8
export const MAX_PAGE_TEXT_LENGTH = 2000
export const MAX_PAGE_DESCRIPTION_LENGTH = 200
/** 描述序列化后的体积上限 */
const MAX_PAGE_DESCRIPTOR_BYTES = 8 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 动作键与文案校验; actions 区块与逐条动作共用 */
const checkPageAction = (
  raw: unknown,
  hasTranslationKey: (key: string) => boolean
): { ok: true; action: PageActionDescriptor } | { ok: false } => {
  if (!isRecord(raw) || typeof raw.key !== 'string' || !PAGE_KEY_PATTERN.test(raw.key)) {
    return { ok: false }
  }
  if (!checkLabel(raw, hasTranslationKey)) {
    return { ok: false }
  }
  return {
    ok: true,
    action:
      typeof raw.labelKey === 'string'
        ? { key: raw.key, labelKey: raw.labelKey }
        : { key: raw.key, label: (raw.label as string).trim() },
  }
}

/** 单个 list 条目校验; 键、标题、说明与徽标逐项收敛 */
const checkPageListItem = (
  raw: unknown,
  hasTranslationKey: (key: string) => boolean
): { ok: true; item: PageListItemDescriptor } | { ok: false } => {
  if (!isRecord(raw) || typeof raw.key !== 'string' || !PAGE_KEY_PATTERN.test(raw.key)) {
    return { ok: false }
  }
  if (!checkLabel(raw, hasTranslationKey, 'title')) {
    return { ok: false }
  }
  const item: {
    key: string
    titleKey?: string
    title?: string
    description?: string
    badgeKey?: string
    badge?: string
  } =
    typeof raw.titleKey === 'string'
      ? { key: raw.key, titleKey: raw.titleKey }
      : { key: raw.key, title: (raw.title as string).trim() }
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string') {
      return { ok: false }
    }
    const description = raw.description.trim()
    if (description === '' || description.length > MAX_PAGE_DESCRIPTION_LENGTH) {
      return { ok: false }
    }
    item.description = description
  }
  if (raw.badge !== undefined || raw.badgeKey !== undefined) {
    if (!checkLabel(raw, hasTranslationKey, 'badge')) {
      return { ok: false }
    }
    if (typeof raw.badgeKey === 'string') {
      item.badgeKey = raw.badgeKey
    } else {
      item.badge = (raw.badge as string).trim()
    }
  }
  return { ok: true, item }
}

/**
  * 校验一份页面描述; 合法返回收敛后的描述, 非法返回问题码。
  * 校验即拒绝: 重复 id、未知区块类型、非法文案都让整份注册失败, 不做部分收编。
  */
export const checkPageDescriptor = (
  descriptor: unknown,
  hasTranslationKey: (key: string) => boolean
): { ok: true; descriptor: PageDescriptor } | { ok: false; problem: PageDescriptorProblem } => {
  if (!isRecord(descriptor)) {
    return { ok: false, problem: 'not-object' }
  }
  const pageId = descriptor.id
  if (typeof pageId !== 'string' || !PAGE_KEY_PATTERN.test(pageId)) {
    return { ok: false, problem: 'invalid-id' }
  }
  if (!checkLabel(descriptor, hasTranslationKey, 'title')) {
    return { ok: false, problem: 'invalid-label' }
  }
  if (!Array.isArray(descriptor.blocks) || descriptor.blocks.length === 0) {
    return { ok: false, problem: 'no-blocks' }
  }
  if (descriptor.blocks.length > MAX_PAGE_BLOCKS) {
    return { ok: false, problem: 'too-many-blocks' }
  }
  const seen = new Set<string>()
  const fieldKeys = new Set<string>()
  const blocks: PageBlock[] = []
  for (const rawBlock of descriptor.blocks) {
    if (!isRecord(rawBlock)) {
      return { ok: false, problem: 'block-not-object' }
    }
    const blockId = rawBlock.id
    if (typeof blockId !== 'string' || !PAGE_KEY_PATTERN.test(blockId)) {
      return { ok: false, problem: 'invalid-block' }
    }
    if (seen.has(blockId)) {
      return { ok: false, problem: 'duplicate-block-id' }
    }
    seen.add(blockId)
    const type = rawBlock.type
    if (type !== 'list' && type !== 'form' && type !== 'text' && type !== 'actions') {
      return { ok: false, problem: 'unknown-block-type' }
    }
    if (type === 'text') {
      if (typeof rawBlock.text !== 'string') {
        return { ok: false, problem: 'invalid-text' }
      }
      const text = rawBlock.text.trim()
      if (text === '' || text.length > MAX_PAGE_TEXT_LENGTH) {
        return { ok: false, problem: 'invalid-text' }
      }
      blocks.push({ id: blockId, type, text })
      continue
    }
    if (type === 'form') {
      const check = checkSettingDescriptor({ fields: rawBlock.fields }, hasTranslationKey)
      if (!check.ok) {
        return { ok: false, problem: 'invalid-form-fields' }
      }
      for (const field of check.descriptor.fields) {
        if (fieldKeys.has(field.key)) {
          return { ok: false, problem: 'duplicate-field-key' }
        }
        fieldKeys.add(field.key)
      }
      blocks.push({ id: blockId, type, fields: check.descriptor.fields })
      continue
    }
    if (type === 'list') {
      if (!Array.isArray(rawBlock.items) || rawBlock.items.length > MAX_PAGE_LIST_ITEMS) {
        return { ok: false, problem: 'invalid-item' }
      }
      const itemKeys = new Set<string>()
      const items: PageListItemDescriptor[] = []
      for (const rawItem of rawBlock.items) {
        const check = checkPageListItem(rawItem, hasTranslationKey)
        if (!check.ok) {
          return { ok: false, problem: 'invalid-item' }
        }
        if (itemKeys.has(check.item.key)) {
          return { ok: false, problem: 'invalid-item' }
        }
        itemKeys.add(check.item.key)
        items.push(check.item)
      }
      let itemAction: PageActionDescriptor | undefined
      if (rawBlock.itemAction !== undefined) {
        const check = checkPageAction(rawBlock.itemAction, hasTranslationKey)
        if (!check.ok) {
          return { ok: false, problem: 'invalid-action' }
        }
        itemAction = check.action
      }
      blocks.push(
        itemAction === undefined
          ? { id: blockId, type, items }
          : { id: blockId, type, items, itemAction }
      )
      continue
    }
    if (!Array.isArray(rawBlock.items) || rawBlock.items.length > MAX_PAGE_ACTIONS) {
      return { ok: false, problem: 'invalid-action' }
    }
    const actions: PageActionDescriptor[] = []
    const actionKeys = new Set<string>()
    for (const rawAction of rawBlock.items) {
      const check = checkPageAction(rawAction, hasTranslationKey)
      if (!check.ok) {
        return { ok: false, problem: 'invalid-action' }
      }
      if (actionKeys.has(check.action.key)) {
        return { ok: false, problem: 'invalid-action' }
      }
      actionKeys.add(check.action.key)
      actions.push(check.action)
    }
    blocks.push({ id: blockId, type, items: actions })
  }
  const settled: PageDescriptor =
    typeof descriptor.titleKey === 'string'
      ? { id: pageId, titleKey: descriptor.titleKey, blocks }
      : { id: pageId, title: (descriptor.title as string).trim(), blocks }
  let bytes: number
  try {
    bytes = new TextEncoder().encode(JSON.stringify(settled)).byteLength
  } catch {
    return { ok: false, problem: 'not-object' }
  }
  if (bytes > MAX_PAGE_DESCRIPTOR_BYTES) {
    return { ok: false, problem: 'descriptor-too-large' }
  }
  return { ok: true, descriptor: settled }
}

/**
 * 已登记的页面描述; 键是「插件 id -> 页面 id」两级, 每个插件可登记多份页面。
 * 停用随引擎清理: 登记返回的句柄带释放函数, 进入插件的 disposer 集合。
 */
const declared = new Map<string, Map<string, PageDescriptor>>()

/**
 * 登记表的变更版本与订阅者。
 * 会话视图标签栏与主区都按登记表渲染: 插件激活时登记页面、停用或卸载时撤销,
 * 界面据此重渲染, 并且停在已撤销页面上的视图据此退回会话视图。
 */
let pageRevision = 0
const pageListeners = new Set<() => void>()

/** 登记表当前版本; 供 useSyncExternalStore 作快照 */
export const pageRegistryRevision = (): number => pageRevision

/** 订阅登记表变更; 返回退订函数 */
export const subscribePageRegistry = (listener: () => void): (() => void) => {
  pageListeners.add(listener)
  return () => {
    pageListeners.delete(listener)
  }
}

/** 一处登记实际发生变化后递增版本并通知订阅者; 无变化时不通知, 免得界面空转 */
const announcePageChange = (): void => {
  pageRevision += 1
  for (const listener of [...pageListeners]) {
    try {
      listener()
    } catch {
      // 订阅者自身出错不阻断其他订阅者, 也不回滚已经生效的登记
    }
  }
}

/** 登记一份页面描述; 同插件同 id 再次登记时替换前一份 */
export const declarePage = (pluginId: string, descriptor: PageDescriptor): void => {
  let pages = declared.get(pluginId)
  if (!pages) {
    pages = new Map<string, PageDescriptor>()
    declared.set(pluginId, pages)
  }
  pages.set(descriptor.id, descriptor)
  announcePageChange()
}

/** 撤销单个页面 */
export const forgetPage = (pluginId: string, pageId: string): void => {
  const pages = declared.get(pluginId)
  if (!pages || !pages.delete(pageId)) {
    return
  }
  if (pages.size === 0) {
    declared.delete(pluginId)
  }
  announcePageChange()
}

/** 撤销单个插件的全部页面登记, 并一并清掉动作与数据挂载点; 与卸载清理同法 */
export const forgetPages = (pluginId: string): void => {
  const hadPages = declared.delete(pluginId)
  pageActionHandlers.delete(pluginId)
  pageDataHandlers.delete(pluginId)
  if (hadPages) {
    announcePageChange()
  }
}

/** 全部已登记页面; 宿主据此给每个页面一个入口 */
export type PluginPageEntry = {
  readonly pluginId: string
  readonly pageId: string
  readonly titleKey?: string
  readonly title?: string
}

export const pageEntries = (): PluginPageEntry[] => {
  const entries: PluginPageEntry[] = []
  for (const [pluginId, pages] of declared) {
    for (const descriptor of pages.values()) {
      entries.push(
        typeof descriptor.titleKey === 'string'
          ? { pluginId, pageId: descriptor.id, titleKey: descriptor.titleKey }
          : { pluginId, pageId: descriptor.id, title: descriptor.title },
      )
    }
  }
  return entries
}

/** 页面动作回调的载荷; form 是宿主收集的页面表单草稿值, 页面没有表单区块时不出现 */
export type PageActionPayload = {
  readonly pageId: string
  readonly actionId: string
  readonly itemKey?: string
  readonly form?: Record<string, SettingValue>
}

/** 页面动作回调的返回; refresh 为 true 时宿主重新向插件索取页面模型 */
export type PageActionResponse = { readonly refresh?: boolean }

export type PageActionHandler = (payload: PageActionPayload) => PageActionResponse | undefined

/** 页面数据处理器; 同步返回当前页面模型, 返回空值表示沿用缺省模型 */
export type PageDataHandler = (pageId: string) => PageDescriptor | null | undefined

/** 动作与数据挂载点各留一个处理器; 同插件再次登记时替换前一份 */
const pageActionHandlers = new Map<string, PageActionHandler>()
const pageDataHandlers = new Map<string, PageDataHandler>()

export const declarePageActionHandler = (pluginId: string, handler: PageActionHandler): void => {
  pageActionHandlers.set(pluginId, handler)
}

export const forgetPageActionHandler = (pluginId: string): void => {
  pageActionHandlers.delete(pluginId)
}

export const declarePageDataHandler = (pluginId: string, handler: PageDataHandler): void => {
  pageDataHandlers.set(pluginId, handler)
}

export const forgetPageDataHandler = (pluginId: string): void => {
  pageDataHandlers.delete(pluginId)
}

/** 读页面的结论; no-page 表示页面不存在(未登记或插件已停用) */
export type PluginPageModelResult =
  | { readonly ok: true; readonly model: PageDescriptor }
  | { readonly ok: false; readonly code: 'no-page' }

/**
 * 读当前页面模型。插件实现了 ui:page-data 时以同步处理器的返回为准:
 * 返回值按登记期同一份校验收敛, 非法、抛错或页面 id 不一致时回落到登记时的缺省模型;
 * 未实现挂载点时直接用缺省模型, 页面静态显示。
 */
export const readPageModel = (
  pluginId: string,
  pageId: string,
  log?: (message: string) => void
): PluginPageModelResult => {
  const fallback = declared.get(pluginId)?.get(pageId)
  const handler = pageDataHandlers.get(pluginId)
  if (!fallback && !handler) {
    return { ok: false, code: 'no-page' }
  }
  if (handler) {
    let raw: unknown
    try {
      raw = handler(pageId)
    } catch (error) {
      log?.('ui:page-data: ' + (error instanceof Error ? error.message : String(error)))
      raw = undefined
    }
    if (raw !== null && raw !== undefined) {
      const check = checkPageDescriptor(raw, isTranslationKey)
      if (check.ok && check.descriptor.id === pageId) {
        return { ok: true, model: check.descriptor }
      }
      log?.(
        check.ok
          ? 'ui:page-data: model id mismatch, expected ' + pageId
          : 'ui:page-data: model rejected (' + check.problem + ')'
      )
    }
  }
  if (fallback) {
    return { ok: true, model: fallback }
  }
  return { ok: false, code: 'no-page' }
}

/** 动作分发的结论; refresh 为 true 表示插件要求宿主重新索取页面模型 */
export type PluginPageActionResult = { readonly ok: boolean; readonly refresh: boolean }

/**
 * 分发一次页面动作。回调同步执行, 不占插件的限流名额;
 * 抛错只写插件日志并按未确认处理, 由插件自行决定重试或提示。
 */
export const dispatchPageAction = (
  pluginId: string,
  payload: PageActionPayload,
  log?: (message: string) => void
): PluginPageActionResult => {
  const handler = pageActionHandlers.get(pluginId)
  if (!handler) {
    return { ok: false, refresh: false }
  }
  let raw: unknown
  try {
    raw = handler(payload)
  } catch (error) {
    log?.('ui:page-action: ' + (error instanceof Error ? error.message : String(error)))
    return { ok: false, refresh: false }
  }
  const refresh = isRecord(raw) && raw.refresh === true
  return { ok: true, refresh }
}
