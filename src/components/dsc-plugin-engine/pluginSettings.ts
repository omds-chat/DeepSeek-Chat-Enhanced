import {
  readPluginSettingsOverrides,
  removePluginSettingEntry,
  writePluginSettingEntry,
} from '../dsc-core/index.js'
import { clearPluginSecret, readPluginSecretConfigured, writePluginSecret } from './credentials.js'

/**
 * 插件设置表面(settings:surface)的引擎侧实现。
 * 插件在激活期用 context.settings.register(descriptor) 登记一份字段描述, 宿主据此渲染表单;
 * 插件只交描述、不交控件, 渲染、i18n 与样式全部归宿主。
 * 值分两层: 默认层来自描述的 default, 用户覆盖层落在 dsc-core 的设置命名空间
 * (settings/<pluginId>/<fieldKey>), 与 plugins:storage 的 KV 互相独立, 插件无法绕过校验写自己的设置表。
 */

/** 设置字段的类型枚举; 控件形态由宿主按类型渲染, 插件不交控件 */
export type SettingFieldType = 'switch' | 'select' | 'number' | 'text' | 'secret'

/** 设置字段键规则; 插件 id 同款词表的宽松版(允许单字符) */
export const SETTING_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/** 单字段描述的取值范围与选项 */
export type SettingFieldOptions = {
  readonly value: string
  /** 选项文案; 与字段标签同一规则: labelKey 走宿主字典或 label 直给文案 */
  readonly labelKey?: string
  readonly label?: string
}

/** 单个设置字段的描述 */
export type SettingFieldDescriptor = {
  /** 字段键; 在同一份描述内不得重复, 也是设置存储的键 */
  readonly key: string
  readonly type: SettingFieldType
  /** 字段标签; 走宿主 i18n 字典 */
  readonly labelKey?: string
  /** 字段标签; 插件直给的文案 */
  readonly label?: string
  /** 默认值; secret 字段不得有默认值 */
  readonly default?: string | number | boolean
  /** number 的取值范围 */
  readonly min?: number
  readonly max?: number
  /** number 的步进; 只影响宿主控件的交互, 不参与校验 */
  readonly step?: number
  /** text 的长度上限 */
  readonly maxLength?: number
  /** text 的形态约束; 必须是能通过 new RegExp 编译的正则来源 */
  readonly pattern?: string
  /** select 的选项清单 */
  readonly options?: readonly SettingFieldOptions[]
}

/** 一份设置表面描述 */
export type SettingDescriptor = {
  /** 字段清单; 至少一个字段, 同一插件只保留最后登记的一份 */
  readonly fields: readonly SettingFieldDescriptor[]
}

/** 设置值; 只有标量 */
export type SettingValue = string | number | boolean

/** 描述被拒绝的原因; 结构化交给插件与日志 */
export type SettingDescriptorProblem =
  | 'not-object'
  | 'no-fields'
  | 'too-many-fields'
  | 'descriptor-too-large'
  | 'field-not-object'
  | 'invalid-key'
  | 'duplicate-key'
  | 'unknown-type'
  | 'invalid-label'
  | 'invalid-range'
  | 'invalid-options'
  | 'invalid-pattern'
  | 'invalid-default'
  | 'default-forbidden'

/** 描述非法; register 抛出, code 是机器可判定的问题码 */
export class PluginSettingsError extends Error {
  constructor(readonly code: SettingDescriptorProblem) {
    super(`dsc-plugin-engine: settings descriptor rejected (${code})`)
    this.name = 'PluginSettingsError'
  }
}

/** 值写入被拒绝的原因 */
export type SettingValueProblem =
  | 'unknown-field'
  | 'invalid-type'
  | 'out-of-range'
  | 'not-in-options'
  | 'too-long'
  | 'pattern-mismatch'
  | 'invalid-input'

/** 写入结果; secret 与普通字段同一形态 */
export type SettingWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SettingValueProblem; readonly detail?: string }

/** 单字段视图; values() 逐字段给出 */
export type SettingValueView = {
  readonly key: string
  readonly type: SettingFieldType
  /** 生效值: 用户覆盖值优先, 否则默认值; secret 字段无值 */
  readonly value?: SettingValue
  /** 用户是否覆盖; secret 字段按配置与否回答 */
  readonly overridden: boolean
  /** secret 字段是否已配置; 非 secret 字段不出现 */
  readonly secretConfigured?: boolean
}

/** 描述的规模上限 */
const MAX_FIELDS = 32
const MAX_OPTIONS = 32
const MAX_LABEL_LENGTH = 40
/** 描述序列化后的体积上限 */
const MAX_DESCRIPTOR_BYTES = 8 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 标签校验: labelKey 与 label 二选一; labelKey 必须是宿主字典里的键 */
const checkLabel = (raw: Record<string, unknown>, hasTranslationKey: (key: string) => boolean): boolean => {
  const hasLabelKey = typeof raw.labelKey === 'string'
  const hasLabel = typeof raw.label === 'string'
  if (hasLabelKey === hasLabel) {
    return false
  }
  if (hasLabelKey) {
    return hasTranslationKey(raw.labelKey as string)
  }
  const label = (raw.label as string).trim()
  return label !== '' && label.length <= MAX_LABEL_LENGTH
}

/**
 * 校验一份字段描述; 合法返回收敛后的描述, 非法返回问题码。
 * 校验即拒绝: 重复 key、未知类型、非法 default 都让整份注册失败, 不做部分收编。
 */
export const checkSettingDescriptor = (
  descriptor: unknown,
  hasTranslationKey: (key: string) => boolean
): { ok: true; descriptor: SettingDescriptor } | { ok: false; problem: SettingDescriptorProblem } => {
  if (!isRecord(descriptor) || !Array.isArray(descriptor.fields) || descriptor.fields.length === 0) {
    return { ok: false, problem: 'no-fields' }
  }
  if (descriptor.fields.length > MAX_FIELDS) {
    return { ok: false, problem: 'too-many-fields' }
  }
  const seen = new Set<string>()
  const fields: SettingFieldDescriptor[] = []
  for (const rawField of descriptor.fields) {
    if (!isRecord(rawField)) {
      return { ok: false, problem: 'field-not-object' }
    }
    const key = rawField.key
    if (typeof key !== 'string' || !SETTING_KEY_PATTERN.test(key)) {
      return { ok: false, problem: 'invalid-key' }
    }
    if (seen.has(key)) {
      return { ok: false, problem: 'duplicate-key' }
    }
    seen.add(key)
    const type = rawField.type
    if (
      type !== 'switch' &&
      type !== 'select' &&
      type !== 'number' &&
      type !== 'text' &&
      type !== 'secret'
    ) {
      return { ok: false, problem: 'unknown-type' }
    }
    if (!checkLabel(rawField, hasTranslationKey)) {
      return { ok: false, problem: 'invalid-label' }
    }
    const field: {
      key: string
      type: SettingFieldType
      labelKey?: string
      label?: string
      default?: SettingValue
      min?: number
      max?: number
      step?: number
      maxLength?: number
      pattern?: string
      options?: SettingFieldOptions[]
    } = {
      key,
      type,
      ...(typeof rawField.labelKey === 'string' ? { labelKey: rawField.labelKey } : { label: (rawField.label as string).trim() }),
    }
    if (type === 'select') {
      const options = rawField.options
      if (!Array.isArray(options) || options.length < 2 || options.length > MAX_OPTIONS) {
        return { ok: false, problem: 'invalid-options' }
      }
      const values = new Set<string>()
      const settled: SettingFieldOptions[] = []
      for (const rawOption of options) {
        if (!isRecord(rawOption) || typeof rawOption.value !== 'string') {
          return { ok: false, problem: 'invalid-options' }
        }
        if (rawOption.value === '' || rawOption.value.length > 64 || values.has(rawOption.value)) {
          return { ok: false, problem: 'invalid-options' }
        }
        if (!checkLabel(rawOption, hasTranslationKey)) {
          return { ok: false, problem: 'invalid-options' }
        }
        values.add(rawOption.value)
        settled.push(
          typeof rawOption.labelKey === 'string'
            ? { value: rawOption.value, labelKey: rawOption.labelKey }
            : { value: rawOption.value, label: (rawOption.label as string).trim() }
        )
      }
      field.options = settled
    }
    if (type === 'number') {
      const hasMin = typeof rawField.min === 'number' && Number.isFinite(rawField.min)
      const hasMax = typeof rawField.max === 'number' && Number.isFinite(rawField.max)
      if (hasMin) {
        field.min = rawField.min as number
      }
      if (hasMax) {
        field.max = rawField.max as number
      }
      if (hasMin && hasMax && (field.min as number) > (field.max as number)) {
        return { ok: false, problem: 'invalid-range' }
      }
      if (typeof rawField.step === 'number' && Number.isFinite(rawField.step) && rawField.step > 0) {
        field.step = rawField.step
      }
    }
    if (type === 'text') {
      if (
        rawField.maxLength !== undefined &&
        (typeof rawField.maxLength !== 'number' ||
          !Number.isInteger(rawField.maxLength) ||
          (rawField.maxLength as number) < 1 ||
          (rawField.maxLength as number) > 2000)
      ) {
        return { ok: false, problem: 'invalid-range' }
      }
      if (rawField.maxLength !== undefined) {
        field.maxLength = rawField.maxLength as number
      }
      if (rawField.pattern !== undefined) {
        if (typeof rawField.pattern !== 'string') {
          return { ok: false, problem: 'invalid-pattern' }
        }
        try {
          new RegExp(rawField.pattern)
        } catch {
          return { ok: false, problem: 'invalid-pattern' }
        }
        field.pattern = rawField.pattern
      }
    }
    if (type === 'secret') {
      // 秘密值不设默认: 默认值会以明文出现在描述里, 也让「是否已配置」失去语义
      if (rawField.default !== undefined) {
        return { ok: false, problem: 'default-forbidden' }
      }
    } else {
      const fallback = rawField.default
      if (fallback === undefined) {
        return { ok: false, problem: 'invalid-default' }
      }
      if (!checkSettingValueForField(field, fallback).ok) {
        return { ok: false, problem: 'invalid-default' }
      }
      field.default = fallback as SettingValue
    }
    fields.push(field)
  }
  const settled: SettingDescriptor = { fields }
  let bytes: number
  try {
    bytes = new TextEncoder().encode(JSON.stringify(settled)).byteLength
  } catch {
    return { ok: false, problem: 'not-object' }
  }
  if (bytes > MAX_DESCRIPTOR_BYTES) {
    return { ok: false, problem: 'descriptor-too-large' }
  }
  return { ok: true, descriptor: settled }
}

/** 按单个字段描述校验一个值; secret 字段不参与值校验 */
const checkSettingValueForField = (
  field: SettingFieldDescriptor,
  value: unknown
): SettingWriteResult => {
  if (field.type === 'switch') {
    return typeof value === 'boolean' ? { ok: true } : { ok: false, code: 'invalid-type' }
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, code: 'invalid-type' }
    }
    if (field.min !== undefined && value < field.min) {
      return { ok: false, code: 'out-of-range', detail: String(field.min) }
    }
    if (field.max !== undefined && value > field.max) {
      return { ok: false, code: 'out-of-range', detail: String(field.max) }
    }
    return { ok: true }
  }
  if (field.type === 'select') {
    if (typeof value !== 'string') {
      return { ok: false, code: 'invalid-type' }
    }
    return (field.options ?? []).some((option) => option.value === value)
      ? { ok: true }
      : { ok: false, code: 'not-in-options' }
  }
  if (typeof value !== 'string') {
    return { ok: false, code: 'invalid-type' }
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return { ok: false, code: 'too-long', detail: String(field.maxLength) }
  }
  if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) {
    return { ok: false, code: 'pattern-mismatch' }
  }
  return { ok: true }
}

/**
 * 已登记的设置描述; 每个插件最多一份, 后登记替换前一份(先撤销前一份的登记)。
 * 停用随引擎清理: 登记返回的释放函数进入插件的 disposer 集合, 与事件处理器同法。
 */
const declared = new Map<string, SettingDescriptor>()

/** 登记一份设置描述; 同插件再次登记时替换前一份 */
export const declareSettings = (pluginId: string, descriptor: SettingDescriptor): void => {
  declared.set(pluginId, descriptor)
}

/** 撤销单个插件的设置描述; 与供应端点声明的撤销同法 */
export const forgetSettings = (pluginId: string): void => {
  declared.delete(pluginId)
}

/** 读单个插件的设置描述; 未登记时为 null */
export const settingsDescriptor = (pluginId: string): SettingDescriptor | null =>
  declared.get(pluginId) ?? null

/**
 * 引擎门面的设置读写入口: engine.pluginSettings(pluginId) 返回这一份。
 * 读侧回答每个字段的生效值与覆盖状态; 写侧先按描述校验再落盘, secret 走凭证库。
 */
export type PluginSettingsFacade = {
  /** 当前登记的描述; 未登记(未激活或无可配置项)时为 null */
  descriptor(): SettingDescriptor | null
  /** 逐字段的生效值视图; secret 字段只回答是否已配置 */
  values(): Promise<SettingValueView[]>
  /** 写入一个字段的用户覆盖值; secret 字段的值是明文, 只写不读 */
  set(key: string, value: SettingValue | string): Promise<SettingWriteResult>
  /** 重置一个字段: 删除用户覆盖值, secret 字段同时清除已配置的秘密值 */
  reset(key: string): Promise<SettingWriteResult>
  /** 重置全部字段 */
  resetAll(): Promise<void>
}

/** 引擎门面的设置读写入口; 插件侧拿不到这份门面, 只有 context.settings.values() 的只读面 */
export const pluginSettingsFacade = (pluginId: string): PluginSettingsFacade => ({
  descriptor: () => settingsDescriptor(pluginId),
  values: async () => {
    const descriptor = settingsDescriptor(pluginId)
    if (!descriptor) {
      return []
    }
    let overrides: Record<string, unknown> = {}
    try {
      overrides = readPluginSettingsOverrides(pluginId)
    } catch {
      overrides = {}
    }
    const views: SettingValueView[] = []
    for (const field of descriptor.fields) {
      if (field.type === 'secret') {
        const configured = await readPluginSecretConfigured(pluginId, field.key)
        views.push({ key: field.key, type: field.type, overridden: false, secretConfigured: configured })
        continue
      }
      const overridden = Object.hasOwn(overrides, field.key)
      const value = overridden ? (overrides[field.key] as SettingValue) : (field.default as SettingValue)
      views.push({ key: field.key, type: field.type, value, overridden })
    }
    return views
  },
  set: async (key, value) => {
    const descriptor = settingsDescriptor(pluginId)
    const field = descriptor?.fields.find((item) => item.key === key)
    if (!field) {
      return { ok: false, code: 'unknown-field' }
    }
    if (field.type === 'secret') {
      if (typeof value !== 'string' || value.trim() === '') {
        return { ok: false, code: 'invalid-input' }
      }
      const result = await writePluginSecret(pluginId, key, value)
      return result.ok ? { ok: true } : { ok: false, code: 'invalid-input' }
    }
    const check = checkSettingValueForField(field, value)
    if (!check.ok) {
      return check
    }
    try {
      writePluginSettingEntry(pluginId, key, value)
      return { ok: true }
    } catch {
      return { ok: false, code: 'invalid-input' }
    }
  },
  reset: async (key) => {
    const descriptor = settingsDescriptor(pluginId)
    const field = descriptor?.fields.find((item) => item.key === key)
    if (!field) {
      return { ok: false, code: 'unknown-field' }
    }
    if (field.type === 'secret') {
      await clearPluginSecret(pluginId, key)
      return { ok: true }
    }
    try {
      removePluginSettingEntry(pluginId, key)
      return { ok: true }
    } catch {
      return { ok: false, code: 'invalid-input' }
    }
  },
  resetAll: async () => {
    const descriptor = settingsDescriptor(pluginId)
    if (!descriptor) {
      return
    }
    for (const field of descriptor.fields) {
      if (field.type === 'secret') {
        await clearPluginSecret(pluginId, field.key)
        continue
      }
      try {
        removePluginSettingEntry(pluginId, field.key)
      } catch {
        return
      }
    }
  },
})

/** 供插件只读自身的设置值; secret 字段不返回任何值 */
export const pluginSettingValuesForPlugin = (pluginId: string): Record<string, SettingValue> => {
  const descriptor = settingsDescriptor(pluginId)
  if (!descriptor) {
    return {}
  }
  let overrides: Record<string, unknown> = {}
  try {
    overrides = readPluginSettingsOverrides(pluginId)
  } catch {
    overrides = {}
  }
  const values: Record<string, SettingValue> = {}
  for (const field of descriptor.fields) {
    // secret 字段对插件完全不可见: 不给值, 也不给配置与否
    if (field.type === 'secret') {
      continue
    }
    const overridden = Object.hasOwn(overrides, field.key)
    values[field.key] = overridden
      ? (overrides[field.key] as SettingValue)
      : (field.default as SettingValue)
  }
  return values
}
