import { useEffect, useRef, useState } from 'react'
import type { PluginSettingsFacade, SettingDescriptor, SettingFieldDescriptor, SettingValue, SettingValueView } from '../../dsc-plugin-engine/index.js'
import type { TranslationKey, TranslationParams } from '../../../i18n/index.js'

/**
 * 插件设置表单的脏值生命周期，语义照抄 dsh 的 SettingsFormModel：
 * 改动即脏、保存才落盘、字段级非法阻塞保存、保存失败保留草稿、离开页面丢弃草稿。
 * 模型是纯对象，不依赖 React；夹具直接驱动它覆盖保存流程。
 */

/** 字段级错误；invalid 为 true 时阻塞保存 */
export type SettingsFieldProblem = {
  key: TranslationKey
  params?: TranslationParams
} | null

/** 单字段草稿快照 */
export type SettingsFieldDraft = {
  key: string
  /** switch 是布尔，其余是字符串；number 以文本暂存，select 存选项值，secret 空串表示不修改 */
  draft: string | boolean
  dirty: boolean
  invalid: boolean
  problem: SettingsFieldProblem
  /** 用户是否覆盖了已保存的值；secret 字段为是否已配置 */
  overridden: boolean
}

/** 保存时要交给门面的单字段条目 */
export type SettingsSaveEntry =
  | { key: string; type: 'secret'; secret: string }
  | { key: string; type: Exclude<SettingFieldDescriptor['type'], 'secret'>; value: SettingValue }

/** 单个秘密字段的状态；与普通字段草稿分开存放 */
export type SecretFieldState = {
  key: string
  /** 输入框草稿；空串表示不修改已配置的秘密值 */
  draft: string
  /** 已配置与否；来自门面的只读结论 */
  configured: boolean
}

/** 模型快照；组件按它渲染 */
export type SettingsFormSnapshot = {
  fields: SettingsFieldDraft[]
  secrets: SecretFieldState[]
  /** 有脏改动且没有非法字段时才允许保存 */
  canSave: boolean
  dirtyCount: number
  /** 上一次保存失败；草稿保留，提示常驻直到下次保存 */
  saveFailed: boolean
}

/** 保存函数：把整批条目交给门面，全部成功才算成功 */
export type SettingsSaveEntries = (entries: readonly SettingsSaveEntry[]) => Promise<boolean>

const numberProblem = (field: SettingFieldDescriptor, draft: string): SettingsFieldProblem => {
  const value = Number(draft)
  if (draft.trim() === '' || Number.isNaN(value) || !Number.isFinite(value)) {
    return { key: 'pluginSettingsInvalidNumber' }
  }
  if (
    (field.min !== undefined && value < field.min) ||
    (field.max !== undefined && value > field.max)
  ) {
    return { key: 'pluginSettingsNumberRange', params: { min: String(field.min ?? ''), max: String(field.max ?? '') } }
  }
  return null
}

const textProblem = (field: SettingFieldDescriptor, draft: string): SettingsFieldProblem => {
  if (field.maxLength !== undefined && draft.length > field.maxLength) {
    return { key: 'pluginSettingsTextTooLong', params: { max: field.maxLength } }
  }
  if (field.pattern !== undefined && !new RegExp(field.pattern).test(draft)) {
    return { key: 'pluginSettingsPatternMismatch' }
  }
  return null
}

/** 非法即阻塞：按字段类型给出可读的问题，与引擎侧写入校验同一口径 */
export const fieldProblemOf = (field: SettingFieldDescriptor, draft: string): SettingsFieldProblem => {
  if (field.type === 'number') {
    return numberProblem(field, draft)
  }
  if (field.type === 'text') {
    return textProblem(field, draft)
  }
  return null
}

/** 单字段草稿的初值：生效值，覆盖层缺失时取默认值 */
const initialDraftOf = (field: SettingFieldDescriptor, value: SettingValue | undefined): string | boolean => {
  if (field.type === 'switch') {
    return value === true
  }
  if (field.type === 'number') {
    return String(value ?? '')
  }
  if (field.type === 'select') {
    return typeof value === 'string' ? value : (field.options?.[0]?.value ?? '')
  }
  return typeof value === 'string' ? value : ''
}

/** 表单模型；一次装载对应一份，离开页面即丢弃 */
export class SettingsFormModel {
  private readonly drafts = new Map<string, { draft: string | boolean; dirty: boolean; problem: SettingsFieldProblem }>()
  private readonly secrets = new Map<string, SecretFieldState>()
  private readonly overrides = new Map<string, boolean>()
  private failed = false
  private readonly listeners = new Set<() => void>()

  private readonly descriptorFields = new Map<string, SettingFieldDescriptor>()

  constructor(
    descriptor: SettingDescriptor,
    values: readonly SettingValueView[],
    private readonly saveEntries: SettingsSaveEntries
  ) {
    for (const field of descriptor.fields) {
      this.descriptorFields.set(field.key, field)

      if (field.type === 'secret') {
        const view = values.find((item) => item.key === field.key)
        this.secrets.set(field.key, {
          key: field.key,
          draft: '',
          configured: view?.secretConfigured === true,
        })
        continue
      }
      const view = values.find((item) => item.key === field.key)
      this.overrides.set(field.key, view?.overridden === true)
      const draft = initialDraftOf(field, view?.value)
      this.drafts.set(field.key, { draft, dirty: false, problem: fieldProblemOf(field, String(draft)) })
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify = () => {
    for (const listener of this.listeners) {
      listener()
    }
  }

  /** 改动即脏：非法字段同样保留草稿，只是阻塞保存 */
  change = (key: string, draft: string | boolean, field: SettingFieldDescriptor) => {
    const state = this.drafts.get(key)
    if (!state) {
      return
    }
    state.draft = draft
    state.dirty = true
    state.problem = fieldProblemOf(field, String(draft))
    this.notify()
  }

  /** 重置为默认：草稿回到默认值；是否落盘仍由用户保存决定 */
  resetField = (field: SettingFieldDescriptor) => {
    const state = this.drafts.get(field.key)
    if (!state) {
      return
    }
    state.draft = initialDraftOf(field, field.default)
    state.dirty = true
    state.problem = fieldProblemOf(field, String(state.draft))
    this.notify()
  }

  /** 修改秘密值草稿；空串表示不修改 */
  changeSecret = (key: string, draft: string) => {
    const state = this.secrets.get(key)
    if (!state) {
      return
    }
    state.draft = draft
    this.notify()
  }

  /** 清除已配置的秘密值：由组件先调门面 reset，成功后调这里同步状态 */
  secretCleared = (key: string) => {
    const state = this.secrets.get(key)
    if (!state) {
      return
    }
    state.configured = false
    state.draft = ''
    this.notify()
  }

  snapshot = (): SettingsFormSnapshot => {
    const fields: SettingsFieldDraft[] = []
    let dirtyCount = 0
    let blocked = false
    for (const [key, state] of this.drafts) {
      const dirty = state.dirty
      const invalid = state.problem !== null
      if (dirty) {
        dirtyCount += 1
      }
      if (invalid) {
        blocked = true
      }
      fields.push({
        key,
        draft: state.draft,
        dirty,
        invalid,
        problem: state.problem,
        overridden: this.overrides.get(key) === true,
      })
    }
    const secrets: SecretFieldState[] = []
    let secretDirty = false
    for (const state of this.secrets.values()) {
      if (state.draft.trim() !== '') {
        secretDirty = true
      }
      secrets.push({ ...state })
    }
    return {
      fields,
      secrets,
      canSave: !blocked && (dirtyCount > 0 || secretDirty),
      dirtyCount: dirtyCount + (secretDirty ? 1 : 0),
      saveFailed: this.failed,
    }
  }

  /** 保存：只交脏且合法的字段；失败保留草稿并置失败标记，成功后清脏 */
  save = async (): Promise<boolean> => {
    const entries: SettingsSaveEntry[] = []
    for (const [key, state] of this.drafts) {
      if (!state.dirty || state.problem !== null) {
        continue
      }
      const field = this.descriptorFields.get(key)
      if (!field) {
        continue
      }
      if (field.type === 'switch') {
        entries.push({ key, type: 'switch', value: state.draft === true })
      } else if (field.type === 'number') {
        entries.push({ key, type: 'number', value: Number(state.draft) })
      } else if (field.type === 'select' || field.type === 'text') {
        entries.push({ key, type: field.type, value: String(state.draft) })
      }
    }
    for (const state of this.secrets.values()) {
      const secret = state.draft.trim()
      if (secret !== '') {
        entries.push({ key: state.key, type: 'secret', secret })
      }
    }
    if (entries.length === 0) {
      return true
    }
    const ok = await this.saveEntries(entries)
    if (ok) {
      this.failed = false
      for (const entry of entries) {
        if (entry.type === 'secret') {
          const state = this.secrets.get(entry.key)
          if (state) {
            state.configured = true
            state.draft = ''
          }
          continue
        }
        const state = this.drafts.get(entry.key)
        if (state) {
          state.dirty = false
        }
        this.overrides.set(entry.key, true)
      }
    } else {
      this.failed = true
    }
    this.notify()
    return ok
  }

}

/** 表单装载状态 */
type FormState = {
  loading: boolean
  failed: boolean
  model: SettingsFormModel | null
  version: number
}

/** 组件侧的表单 hook：装载值、构造模型、订阅变更；离开页面即丢弃草稿 */
export const useSettingsForm = (
  facade: PluginSettingsFacade | null,
  descriptor: SettingDescriptor | null
): FormState & { model: SettingsFormModel | null } => {
  const [state, setState] = useState<FormState>({ loading: true, failed: false, model: null, version: 0 })
  const facadeRef = useRef(facade)
  facadeRef.current = facade

  useEffect(() => {
    if (!facade || !descriptor) {
      setState({ loading: false, failed: false, model: null, version: 0 })
      return
    }
    let cancelled = false
    setState({ loading: true, failed: false, model: null, version: 0 })
    void facade
      .values()
      .then((values) => {
        if (cancelled) {
          return
        }
        const model = new SettingsFormModel(descriptor, values, async (entries) => {
          const current = facadeRef.current
          if (!current) {
            return false
          }
          for (const entry of entries) {
            const result = await current.set(entry.key, entry.type === 'secret' ? entry.secret : entry.value)
            if (!result.ok) {
              return false
            }
          }
          return true
        })
        setState({ loading: false, failed: false, model, version: 1 })
      })
      .catch(() => {
        if (!cancelled) {
          setState({ loading: false, failed: true, model: null, version: 0 })
        }
      })
    return () => {
      cancelled = true
    }
  }, [facade, descriptor])

  const model = state.model
  const versionRef = useRef(0)
  versionRef.current = state.version

  useEffect(() => {
    if (!model) {
      return
    }
    return model.subscribe(() => {
      setState((previous) => ({ ...previous, version: previous.version + 1 }))
    })
  }, [model])

  return { ...state, model }
}
