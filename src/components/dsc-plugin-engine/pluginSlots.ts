import {
  SETTING_KEY_PATTERN,
  checkSettingDescriptor,
  checkLabel,
  type SettingFieldDescriptor,
  type SettingValue,
} from './pluginSettings.js'
import { isTranslationKey } from '../../i18n/index.js'

/**
 * 插件 UI 槽位(ui:slot)的引擎侧实现。
 * 槽位是宿主界面上的一类登记位置, 位置数量与能力数量解耦: 能力只给一个 ui:slot,
 * 具体位置由封闭的 slot 枚举界定, 清单再以 slots 白名单逐位置授权。
 * 插件在激活期用 context.ui.registerSlot(descriptor) 登记一份声明式描述, 宿主据此渲染;
 * 与 settings:surface 同法, 插件只交描述、不交控件, 渲染、i18n 与样式全部归宿主。
 * 页面数据由登记时的描述作为缺省模型; 插件实现 ui:slot-data 挂载点后,
 * 宿主在进入页面与动作返回刷新指示时向插件索取当前模型, 同步返回 null 表示沿用登记描述。
 * 页面动作经 ui:slot-action 挂载点同步回调插件, 载荷带 slot; 异步工作由插件自行发起并用 notify 提示。
 */

/** 槽位枚举: nav.panel 是侧边栏导航行 + 主区整页 */
export const SLOT_NAV_PANEL = 'nav.panel'
/** 槽位枚举: conversation.tabs 是会话视图标签栏里的一个标签 + 主区整页 */
export const SLOT_CONVERSATION_TABS = 'conversation.tabs'

/** 槽位名; 封闭词表, 未知名在登记期按 unknown-slot 拒绝 */
export type SlotName = typeof SLOT_NAV_PANEL | typeof SLOT_CONVERSATION_TABS

/** 全部槽位; 宿主渲染与清单校验共用同一份枚举 */
export const SLOT_NAMES: readonly SlotName[] = [SLOT_NAV_PANEL, SLOT_CONVERSATION_TABS]

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

/** registerSlot 返回的句柄; 释放函数撤销该登记 */
export type SlotHandle = {
  readonly slot: SlotName
  readonly id: string
  dispose(): void
}

/** 一份槽位描述; slot 决定落点, id 在同一槽位内跨插件唯一 */
export type SlotDescriptor = {
  /** 槽位名; 必须在枚举内且已写入清单 slots 白名单 */
  readonly slot: SlotName
  /** 页面 id; 同一槽位内不得与其他插件重复, 与插件 id 共同构成入口的键 */
  readonly id: string
  readonly titleKey?: string
  readonly title?: string
  /** 图标键; 由宿主图标查表解析, 未命中时宿主用通用插件图标 */
  readonly iconKey?: string
  /** 排序; 升序, 同值按登记顺序, 未给按 0 */
  readonly order?: number
  readonly blocks: readonly PageBlock[]
}

/** 区块层面的公共问题码; 页面模型与槽位描述共用同一套区块校验 */
type BlockProblem =
  | 'no-blocks'
  | 'too-many-blocks'
  | 'block-not-object'
  | 'invalid-block'
  | 'duplicate-block-id'
  | 'unknown-block-type'
  | 'invalid-item'
  | 'invalid-action'
  | 'invalid-text'
  | 'invalid-form-fields'
  | 'duplicate-field-key'

/** 页面描述被拒绝的原因; ui:slot-data 的回流模型按同一口径校验 */
export type PageDescriptorProblem =
  | 'not-object'
  | 'invalid-id'
  | 'invalid-label'
  | BlockProblem
  | 'descriptor-too-large'

/** 页面描述非法; ui:slot-data 回流非法时按此口径记日志 */
export class PluginPageError extends Error {
  constructor(readonly code: PageDescriptorProblem) {
    super('dsc-plugin-engine: page descriptor rejected (' + code + ')')
    this.name = 'PluginPageError'
  }
}

/** 槽位描述被拒绝的原因; 在页面问题码之上加槽位与排序专属的几项 */
export type SlotDescriptorProblem =
  | 'not-object'
  | 'unknown-slot'
  | 'slot-not-granted'
  | 'invalid-id'
  | 'invalid-label'
  | 'invalid-icon-key'
  | 'invalid-order'
  | 'duplicate-id'
  | BlockProblem
  | 'descriptor-too-large'

/** 描述非法; registerSlot 抛出, code 是机器可判定的问题码 */
export class PluginSlotError extends Error {
  constructor(readonly code: SlotDescriptorProblem) {
    super('dsc-plugin-engine: slot descriptor rejected (' + code + ')')
    this.name = 'PluginSlotError'
  }
}

/** 槽位 id 与区块 id、条目键、动作键共用 settings 字段键的词表 */
export const PAGE_KEY_PATTERN = SETTING_KEY_PATTERN

/** 描述的规模上限, 口径与 pluginSettings 对齐 */
export const MAX_PAGE_BLOCKS = 64
export const MAX_PAGE_LIST_ITEMS = 200
export const MAX_PAGE_ACTIONS = 8
export const MAX_PAGE_TEXT_LENGTH = 2000
export const MAX_PAGE_DESCRIPTION_LENGTH = 200
/** 图标键的长度上限; 图标键由宿主图标查表解析, 不是文案 */
export const MAX_ICON_KEY_LENGTH = 64
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
 * 校验区块数组; 页面模型与槽位描述共用, 合法返回收敛后的区块, 非法返回问题码。
 * 校验即拒绝: 重复 id、未知区块类型、非法文案都让整份注册失败, 不做部分收编。
 */
const checkPageBlocks = (
  rawBlocks: unknown,
  hasTranslationKey: (key: string) => boolean
): { ok: true; blocks: PageBlock[] } | { ok: false; problem: BlockProblem } => {
  if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) {
    return { ok: false, problem: 'no-blocks' }
  }
  if (rawBlocks.length > MAX_PAGE_BLOCKS) {
    return { ok: false, problem: 'too-many-blocks' }
  }
  const seen = new Set<string>()
  const fieldKeys = new Set<string>()
  const blocks: PageBlock[] = []
  for (const rawBlock of rawBlocks) {
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
  return { ok: true, blocks }
}

/** 描述序列化后的字节数; 不可序列化返回 null */
const serializedBytes = (value: unknown): number | null => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return null
  }
}

/** 页面描述的不带槽位头形态; ui:slot-data 回流与登记描述共用区块模型 */
export type PageDescriptor = {
  readonly id: string
  readonly titleKey?: string
  readonly title?: string
  readonly blocks: readonly PageBlock[]
}

/**
 * 校验一份页面描述(不带槽位头的三字段形态); ui:slot-data 的回流模型按此收敛,
 * 合法返回收敛后的描述, 非法返回问题码。
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
  const blocks = checkPageBlocks(descriptor.blocks, hasTranslationKey)
  if (!blocks.ok) {
    return { ok: false, problem: blocks.problem }
  }
  const settled: PageDescriptor =
    typeof descriptor.titleKey === 'string'
      ? { id: pageId, titleKey: descriptor.titleKey, blocks: blocks.blocks }
      : { id: pageId, title: (descriptor.title as string).trim(), blocks: blocks.blocks }
  const bytes = serializedBytes(settled)
  if (bytes === null || bytes > MAX_PAGE_DESCRIPTOR_BYTES) {
    return { ok: false, problem: bytes === null ? 'not-object' : 'descriptor-too-large' }
  }
  return { ok: true, descriptor: settled }
}

/**
 * 校验一份槽位描述; 合法返回收敛后的描述, 非法返回问题码。
 * 校验即拒绝: 槽位不在枚举、非法 id、非法标题、非法图标键、非法排序与非法区块都让整份注册失败。
 */
export const checkSlotDescriptor = (
  descriptor: unknown,
  hasTranslationKey: (key: string) => boolean
): { ok: true; descriptor: SlotDescriptor } | { ok: false; problem: SlotDescriptorProblem } => {
  if (!isRecord(descriptor)) {
    return { ok: false, problem: 'not-object' }
  }
  const slot = descriptor.slot
  if (typeof slot !== 'string' || !SLOT_NAMES.includes(slot as SlotName)) {
    return { ok: false, problem: 'unknown-slot' }
  }
  const id = descriptor.id
  if (typeof id !== 'string' || !PAGE_KEY_PATTERN.test(id)) {
    return { ok: false, problem: 'invalid-id' }
  }
  if (!checkLabel(descriptor, hasTranslationKey, 'title')) {
    return { ok: false, problem: 'invalid-label' }
  }
  let iconKey: string | undefined
  if (descriptor.iconKey !== undefined) {
    if (typeof descriptor.iconKey !== 'string') {
      return { ok: false, problem: 'invalid-icon-key' }
    }
    const key = descriptor.iconKey.trim()
    if (key === '' || key.length > MAX_ICON_KEY_LENGTH) {
      return { ok: false, problem: 'invalid-icon-key' }
    }
    iconKey = key
  }
  let order: number | undefined
  if (descriptor.order !== undefined) {
    if (typeof descriptor.order !== 'number' || !Number.isFinite(descriptor.order)) {
      return { ok: false, problem: 'invalid-order' }
    }
    order = descriptor.order
  }
  const blocks = checkPageBlocks(descriptor.blocks, hasTranslationKey)
  if (!blocks.ok) {
    return { ok: false, problem: blocks.problem }
  }
  const base: {
    slot: SlotName
    id: string
    iconKey?: string
    order?: number
  } = {
    slot: slot as SlotName,
    id,
    ...(iconKey !== undefined ? { iconKey } : {}),
    ...(order !== undefined ? { order } : {}),
  }
  const settled: SlotDescriptor =
    typeof descriptor.titleKey === 'string'
      ? { ...base, titleKey: descriptor.titleKey, blocks: blocks.blocks }
      : { ...base, title: (descriptor.title as string).trim(), blocks: blocks.blocks }
  const bytes = serializedBytes(settled)
  if (bytes === null || bytes > MAX_PAGE_DESCRIPTOR_BYTES) {
    return { ok: false, problem: bytes === null ? 'not-object' : 'descriptor-too-large' }
  }
  return { ok: true, descriptor: settled }
}

/**
 * 已登记的槽位描述; 键是「槽位 -> 槽位 id -> 插件 id」三级。
 * 槽位 id 在同一槽位内跨插件唯一(先登记者占位), 同插件重复登记同 id 时替换前一份;
 * 停用随引擎清理: 登记返回的句柄带释放函数, 进入插件的 disposer 集合。
 */
type DeclaredSlot = { descriptor: SlotDescriptor; seq: number }
const declared = new Map<SlotName, Map<string, Map<string, DeclaredSlot>>>()
let nextSeq = 0

/**
 * 该插件能否占用槽位内的这个 id。
 * 同槽位同 id 已被其他插件占用时不能登记(跨插件撞名按登记顺序判先后),
 * 未占用或已由本插件占用(替换语义)时放行; 撞名在登记期拒绝, 不做静默覆盖。
 */
export const canClaimSlotId = (slot: SlotName, id: string, pluginId: string): boolean => {
  const owners = declared.get(slot)?.get(id)
  return owners === undefined || owners.has(pluginId)
}

/** 登记一份槽位描述; 调用方先用 canClaimSlotId 判定跨插件撞名 */
export const declareSlot = (pluginId: string, descriptor: SlotDescriptor): void => {
  let byId = declared.get(descriptor.slot)
  if (!byId) {
    byId = new Map<string, Map<string, DeclaredSlot>>()
    declared.set(descriptor.slot, byId)
  }
  let owners = byId.get(descriptor.id)
  if (!owners) {
    owners = new Map<string, DeclaredSlot>()
    byId.set(descriptor.id, owners)
  }
  const existing = owners.get(pluginId)
  const seq = existing ? existing.seq : nextSeq++
  owners.set(pluginId, { descriptor, seq })
  announceSlotChange()
}

/** 撤销单个登记 */
export const forgetSlot = (pluginId: string, slot: SlotName, id: string): void => {
  const owners = declared.get(slot)?.get(id)
  if (!owners || !owners.delete(pluginId)) {
    return
  }
  if (owners.size === 0) {
    declared.get(slot)?.delete(id)
  }
  announceSlotChange()
}

/** 撤销单个插件的全部登记, 并一并清掉动作与数据挂载点; 与卸载清理同法 */
export const forgetSlots = (pluginId: string): void => {
  let changed = false
  for (const [slot, byId] of declared) {
    for (const [id, owners] of byId) {
      if (owners.delete(pluginId)) {
        changed = true
      }
      if (owners.size === 0) {
        byId.delete(id)
      }
    }
    if (byId.size === 0) {
      declared.delete(slot)
    }
  }
  slotActionHandlers.delete(pluginId)
  slotDataHandlers.delete(pluginId)
  if (changed) {
    announceSlotChange()
  }
}

/** 全部已登记槽位; 每个槽位内按 order 升序、同值按登记顺序排列 */
export type SlotEntry = {
  readonly pluginId: string
  readonly slot: SlotName
  readonly id: string
  readonly titleKey?: string
  readonly title?: string
  readonly iconKey?: string
}

export const slotEntries = (): SlotEntry[] => {
  const entries: SlotEntry[] = []
  for (const [slot, byId] of declared) {
    const rows: { pluginId: string; id: string; order: number; seq: number; d: SlotDescriptor }[] = []
    for (const [id, owners] of byId) {
      for (const [pluginId, entry] of owners) {
        rows.push({
          pluginId,
          id,
          order: entry.descriptor.order ?? 0,
          seq: entry.seq,
          d: entry.descriptor,
        })
      }
    }
    rows.sort((a, b) => a.order - b.order || a.seq - b.seq)
    for (const row of rows) {
      const icon = row.d.iconKey === undefined ? {} : { iconKey: row.d.iconKey }
      entries.push(
        typeof row.d.titleKey === 'string'
          ? { pluginId: row.pluginId, slot, id: row.id, titleKey: row.d.titleKey, ...icon }
          : { pluginId: row.pluginId, slot, id: row.id, title: row.d.title, ...icon }
      )
    }
  }
  return entries
}

/**
 * 登记表的变更版本与订阅者。
 * 侧边栏导航行与会话视图标签栏都按登记表渲染: 插件激活时登记、停用或卸载时撤销,
 * 界面据此重渲染, 并且停在已撤销页面上的视图据此退回会话视图。
 */
let slotRevision = 0
const slotListeners = new Set<() => void>()

/** 登记表当前版本; 供 useSyncExternalStore 作快照 */
export const slotRegistryRevision = (): number => slotRevision

/** 订阅登记表变更; 返回退订函数 */
export const subscribeSlotRegistry = (listener: () => void): (() => void) => {
  slotListeners.add(listener)
  return () => {
    slotListeners.delete(listener)
  }
}

/** 一处登记实际发生变化后递增版本并通知订阅者; 无变化时不通知, 免得界面空转 */
const announceSlotChange = (): void => {
  slotRevision += 1
  for (const listener of [...slotListeners]) {
    try {
      listener()
    } catch {
      // 订阅者自身出错不阻断其他订阅者, 也不回滚已经生效的登记
    }
  }
}

/** 槽位动作回调的载荷; form 是宿主收集的页面表单草稿值, 页面没有表单区块时不出现 */
export type SlotActionPayload = {
  readonly slot: SlotName
  readonly id: string
  readonly actionId: string
  readonly itemKey?: string
  readonly form?: Record<string, SettingValue>
}

/** 槽位动作回调的返回; refresh 为 true 时宿主重新向插件索取页面模型 */
export type SlotActionResponse = { readonly refresh?: boolean }

export type SlotActionHandler = (payload: SlotActionPayload) => SlotActionResponse | undefined

/** 槽位数据处理器; 同步返回当前页面模型, 返回 null 表示沿用登记时的描述 */
export type SlotDataHandler = (slot: SlotName, id: string) => SlotDescriptor | null | undefined

/** 动作与数据挂载点各留一个处理器; 同插件再次登记时替换前一份 */
const slotActionHandlers = new Map<string, SlotActionHandler>()
const slotDataHandlers = new Map<string, SlotDataHandler>()

export const declareSlotActionHandler = (pluginId: string, handler: SlotActionHandler): void => {
  slotActionHandlers.set(pluginId, handler)
}

export const forgetSlotActionHandler = (pluginId: string): void => {
  slotActionHandlers.delete(pluginId)
}

export const declareSlotDataHandler = (pluginId: string, handler: SlotDataHandler): void => {
  slotDataHandlers.set(pluginId, handler)
}

export const forgetSlotDataHandler = (pluginId: string): void => {
  slotDataHandlers.delete(pluginId)
}

/** 读槽位页面模型的结论; no-slot 表示页面不存在(未登记或插件已停用) */
export type SlotModelResult =
  | { readonly ok: true; readonly model: SlotDescriptor }
  | { readonly ok: false; readonly code: 'no-slot' }

/**
 * 读当前页面模型。插件实现了 ui:slot-data 时以同步处理器的返回为准:
 * 返回值按登记期同一份校验收敛, 非法、抛错或 slot/id 与所请求页面不一致时回落到登记时的缺省模型;
 * 返回 null 表示沿用登记描述; 未实现挂载点时直接用缺省模型, 页面静态显示。
 */
export const readSlotModel = (
  pluginId: string,
  slot: SlotName,
  id: string,
  log?: (message: string) => void
): SlotModelResult => {
  const fallback = declared.get(slot)?.get(id)?.get(pluginId)?.descriptor
  const handler = slotDataHandlers.get(pluginId)
  if (!fallback && !handler) {
    return { ok: false, code: 'no-slot' }
  }
  if (handler) {
    let raw: unknown
    try {
      raw = handler(slot, id)
    } catch (error) {
      log?.('ui:slot-data: ' + (error instanceof Error ? error.message : String(error)))
      raw = undefined
    }
    if (raw !== null && raw !== undefined) {
      const check = checkSlotDescriptor(raw, isTranslationKey)
      if (check.ok && check.descriptor.slot === slot && check.descriptor.id === id) {
        return { ok: true, model: check.descriptor }
      }
      log?.(
        check.ok
          ? 'ui:slot-data: model key mismatch, expected ' + slot + '/' + id
          : 'ui:slot-data: model rejected (' + check.problem + ')'
      )
    }
  }
  if (fallback) {
    return { ok: true, model: fallback }
  }
  return { ok: false, code: 'no-slot' }
}

/** 动作分发的结论; refresh 为 true 表示插件要求宿主重新索取页面模型 */
export type SlotActionResult = { readonly ok: boolean; readonly refresh: boolean }

/**
 * 分发一次槽位动作。回调同步执行, 不占插件的限流名额;
 * 抛错只写插件日志并按未确认处理, 由插件自行决定重试或提示。
 */
export const dispatchSlotAction = (
  pluginId: string,
  payload: SlotActionPayload,
  log?: (message: string) => void
): SlotActionResult => {
  const handler = slotActionHandlers.get(pluginId)
  if (!handler) {
    return { ok: false, refresh: false }
  }
  let raw: unknown
  try {
    raw = handler(payload)
  } catch (error) {
    log?.('ui:slot-action: ' + (error instanceof Error ? error.message : String(error)))
    return { ok: false, refresh: false }
  }
  const refresh = isRecord(raw) && raw.refresh === true
  return { ok: true, refresh }
}
