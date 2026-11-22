import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  getPluginEngine,
  isPageDescriptor,
  slotRegistryRevision,
  subscribeSlotRegistry,
  type PageDescriptor,
  type SettingFieldDescriptor,
  type SettingValue,
} from '../dsc-plugin-engine/index.js'
import { Button } from '../base/Button.js'
import { SettingsFieldRow, settingFieldLabel } from './settings/fields.js'
import { SettingsFormModel, type SettingsFormSnapshot } from './settings/useSettingsForm.js'
import type { SlotPageRef } from './pluginViewState.js'
import { actionText, badgeText, titledText, type Translate } from './pluginPageText.js'
import { useSlotPanels } from './useSlotPanels.js'
import detailStyles from './settings/PluginSettings.module.css'
import styles from './PluginPageView.module.css'

/**
 * 插件页面区块的渲染与数据模型: nav.panel、conversation.tabs 与 settings.page 三个页面型槽位共用。
 * 页面内容全部由宿主按描述渲染(四种区块), 表单区块复用设置表面的五种控件与脏值生命周期;
 * 动作按钮经引擎同步回调插件, 返回刷新指示时重新向插件索取页面模型(ui:slot-data)。
 * 这里只做渲染与模型, 不涉及落点: 主区整页与设置对话框里的一页都调同一份实现。
 */

/** 页面里全部表单区块的字段; 键在登记期已保证页面内唯一 */
export const formFieldsOf = (model: PageDescriptor): SettingFieldDescriptor[] =>
  model.blocks.flatMap((block) => (block.type === 'form' ? [...block.fields] : []))

/** 用页面描述的字段默认值构造一份脏值表单模型; 页面没有表单区块时为 null */
export const buildFormModel = (model: PageDescriptor): SettingsFormModel | null => {
  const fields = formFieldsOf(model)
  if (fields.length === 0) {
    return null
  }
  const values = fields.map((field) =>
    field.type === 'secret'
      ? { key: field.key, type: field.type, overridden: false, secretConfigured: false }
      : {
          key: field.key,
          type: field.type,
          value: field.default as SettingValue,
          overridden: false,
        }
  )
  // 页面表单没有落盘动作: 改动只留在草稿层, 动作按钮触发时随载荷交给插件
  return new SettingsFormModel({ fields }, values, async () => true)
}

/** 从表单快照收集草稿值; secret 字段只在有输入时交给插件 */
export const collectFormValues = (
  snapshot: SettingsFormSnapshot,
  fields: readonly SettingFieldDescriptor[]
): Record<string, SettingValue> => {
  const values: Record<string, SettingValue> = {}
  for (const field of fields) {
    const draft = snapshot.fields.find((item) => item.key === field.key)
    if (!draft) {
      continue
    }
    if (field.type === 'switch') {
      values[field.key] = draft.draft === true
      continue
    }
    if (field.type === 'number') {
      const value = Number(draft.draft)
      values[field.key] = Number.isFinite(value) ? value : String(draft.draft)
      continue
    }
    values[field.key] = String(draft.draft)
  }
  for (const secret of snapshot.secrets) {
    if (secret.draft.trim() !== '') {
      values[secret.key] = secret.draft
    }
  }
  return values
}

/** 订阅表单模型的变更; 与设置详情页同一套脏值生命周期 */
const useFormModelVersion = (model: SettingsFormModel | null): void => {
  const [, setVersion] = useState(0)
  useEffect(() => {
    if (!model) {
      return
    }
    return model.subscribe(() => setVersion((value) => value + 1))
  }, [model])
}

type PageLoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'ready'; model: PageDescriptor }

/** 页面动作的发起函数; 与页面的 slot/id 绑定 */
export type RunPageAction = (actionId: string, itemKey?: string) => void

/** 一份页面模型的状态与动作; 主区整页与设置对话框里的一页都从这里取 */
export type SlotPageModel = {
  readonly state: PageLoadState
  readonly model: PageDescriptor | null
  readonly pluginName: string
  readonly fields: readonly SettingFieldDescriptor[]
  readonly snapshot: SettingsFormSnapshot | null
  readonly formModel: SettingsFormModel | null
  readonly runAction: RunPageAction
}

/**
 * 读一份槽位页面模型并绑定动作回调。
 * 页面重新登记时一并重读(插件可能换了一份描述); 只接受页面型描述,
 * 其余槽位的模型在这里按「不存在」处理, 免得把工具条描述当页面画。
 */
export const useSlotPageModel = (page: SlotPageRef): SlotPageModel => {
  const panels = useSlotPanels()
  const pluginName =
    panels.find((item) => item.pluginId === page.pluginId && item.id === page.id)?.pluginName ??
    page.pluginId
  const revision = useSyncExternalStore(subscribeSlotRegistry, slotRegistryRevision)
  const [state, setState] = useState<PageLoadState>({ kind: 'loading' })
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const engine = getPluginEngine()
    const result = engine?.readSlot(page.pluginId, page.slot, page.id)
    if (!result || !result.ok || !isPageDescriptor(result.model)) {
      setState({ kind: 'missing' })
      return
    }
    setState({ kind: 'ready', model: result.model })
  }, [page.pluginId, page.slot, page.id, reload, revision])

  const model = state.kind === 'ready' ? state.model : null
  // 表单模型随页面模型重建: 刷新指示到达时脏值草稿一并丢弃
  const formModel = useMemo(() => (model ? buildFormModel(model) : null), [model])
  const fields = useMemo(() => (model ? formFieldsOf(model) : []), [model])
  useFormModelVersion(formModel)
  const snapshot = formModel?.snapshot() ?? null

  const runAction: RunPageAction = (actionId, itemKey) => {
    const engine = getPluginEngine()
    if (!engine || !model) {
      return
    }
    const payload: {
      slot: typeof page.slot
      id: string
      actionId: string
      itemKey?: string
      form?: Record<string, SettingValue>
    } = {
      slot: page.slot,
      id: model.id,
      actionId,
    }
    if (itemKey !== undefined) {
      payload.itemKey = itemKey
    }
    if (formModel && fields.length > 0) {
      const form = collectFormValues(formModel.snapshot(), fields)
      if (Object.keys(form).length > 0) {
        payload.form = form
      }
    }
    if (engine.dispatchSlotAction(page.pluginId, payload).refresh) {
      setReload((value) => value + 1)
    }
  }

  return { state, model, pluginName, fields, snapshot, formModel, runAction }
}

/** 四个区块的渲染; 不套外壳, 调用方决定放在主区还是设置对话框里 */
export const PluginPageBlocks = ({
  model,
  snapshot,
  formModel,
  runAction,
}: {
  model: PageDescriptor
  snapshot: SettingsFormSnapshot | null
  formModel: SettingsFormModel | null
  runAction: RunPageAction
}) => {
  const t = useTranslate()
  return (
    <>
      {model.blocks.map((block) => {
        if (block.type === 'text') {
          return (
            <p key={block.id} className={styles.text}>
              {block.text}
            </p>
          )
        }
        if (block.type === 'list') {
          const itemAction = block.itemAction
          return (
            <div key={block.id} className={styles.list}>
              {block.items.map((item) => (
                <div key={item.key} className={styles.listItem}>
                  <div className={styles.listItemHead}>
                    <span className={styles.listItemTitle}>{titledText(item, item.key, t)}</span>
                    {item.badgeKey !== undefined || item.badge !== undefined ? (
                      <span className={detailStyles.badge}>{badgeText(item, t)}</span>
                    ) : null}
                  </div>
                  {item.description ? (
                    <div className={styles.listItemDesc}>{item.description}</div>
                  ) : null}
                  {itemAction ? (
                    <div className={styles.listItemActions}>
                      <Button
                        variant="outlined"
                        size="s"
                        onClick={() => runAction(itemAction.key, item.key)}
                      >
                        {actionText(itemAction, t)}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )
        }
        if (block.type === 'form') {
          return (
            <div key={block.id}>
              {block.fields.map((field) => {
                const draft = snapshot?.fields.find((item) => item.key === field.key)
                const secret = snapshot?.secrets.find((item) => item.key === field.key) ?? null
                if (!draft || !formModel) {
                  return null
                }
                return (
                  <SettingsFieldRow
                    key={field.key}
                    field={field}
                    draft={draft}
                    secret={secret}
                    label={settingFieldLabel(field, t)}
                    onSwitchChange={(value) => formModel.change(field.key, value, field)}
                    onTextChange={(value) => formModel.change(field.key, value, field)}
                    onSelectChange={(value) => formModel.change(field.key, value, field)}
                    onReset={() => formModel.resetField(field)}
                    onSecretReset={() => undefined}
                  />
                )
              })}
            </div>
          )
        }
        return (
          <div key={block.id} className={styles.actionsRow}>
            {block.items.map((action) => (
              <Button
                key={action.key}
                variant="outlined"
                size="m"
                onClick={() => runAction(action.key)}
              >
                {actionText(action, t)}
              </Button>
            ))}
          </div>
        )
      })}
    </>
  )
}

/** 页面主体: 标题、插件名与区块; 主区整页用它, 设置对话框里的插件页也用同一份 */
export const PluginPageBody = ({
  model,
  pluginName,
  snapshot,
  formModel,
  runAction,
}: {
  model: PageDescriptor
  pluginName: string
  snapshot: SettingsFormSnapshot | null
  formModel: SettingsFormModel | null
  runAction: RunPageAction
}) => {
  const t: Translate = useTranslate()
  return (
    <>
      <h1 className={detailStyles.title}>{titledText(model, model.id, t)}</h1>
      <div className={detailStyles.subtitle}>{pluginName}</div>
      <div className={detailStyles.scroll}>
        <PluginPageBlocks
          model={model}
          snapshot={snapshot}
          formModel={formModel}
          runAction={runAction}
        />
      </div>
    </>
  )
}
