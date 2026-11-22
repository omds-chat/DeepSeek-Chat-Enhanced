import clsx from 'clsx'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  getPluginEngine,
  slotRegistryRevision,
  subscribeSlotRegistry,
  type PageDescriptor,
  type SettingFieldDescriptor,
  type SettingValue,
} from '../dsc-plugin-engine/index.js'
import { useIsMobile } from '../../app/viewport.js'
import { Button } from '../base/Button.js'
import { MobileHeader } from '../session/MobileHeader.js'
import { SettingsFieldRow, settingFieldLabel } from './settings/fields.js'
import { SettingsFormModel, type SettingsFormSnapshot } from './settings/useSettingsForm.js'
import { returnToChat, type SlotPageRef } from './pluginViewState.js'
import { actionText, badgeText, titledText, type Translate } from './pluginPageText.js'
import { useSlotPanels } from './useSlotPanels.js'
import detailStyles from './settings/PluginSettings.module.css'
import styles from './PluginPageView.module.css'

/**
 * 插件槽位页面：主区渲染一个已登记的插件页面。
 * 入口是侧边栏导航行(nav.panel)或会话视图标签栏(conversation.tabs); 选中即整块替换主区,
 * 页面顶部是回到会话的面包屑, 不做路由、不做模态遮罩。
 * 页面内容由宿主按描述渲染: text、list、form 与 actions 四种区块,
 * 表单区块复用设置表面的五种控件与脏值生命周期; 动作按钮经引擎同步回调插件,
 * 返回刷新指示时重新向插件索取页面模型(ui:slot-data)。
 */

/** 页面里全部表单区块的字段；键在登记期已保证页面内唯一 */
const formFieldsOf = (model: PageDescriptor): SettingFieldDescriptor[] =>
  model.blocks.flatMap((block) => (block.type === 'form' ? [...block.fields] : []))

/** 用页面描述的字段默认值构造一份脏值表单模型；页面没有表单区块时为 null */
const buildFormModel = (model: PageDescriptor): SettingsFormModel | null => {
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
const collectFormValues = (
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

type PageLoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'ready'; model: PageDescriptor }

/** 订阅表单模型的变更; 与设置详情页同一套脏值生命周期 */
const useFormModelVersion = (model: SettingsFormModel | null): number => {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!model) {
      return
    }
    return model.subscribe(() => setVersion((value) => value + 1))
  }, [model])
  return version
}

export const PluginPageView = ({
  page,
  siderCollapsed,
}: {
  page: SlotPageRef
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const panels = useSlotPanels()
  const pluginName =
    panels.find((item) => item.pluginId === page.pluginId && item.id === page.id)?.pluginName ??
    page.pluginId
  // 页面重新登记时一并重读: 插件可能换了一份描述
  const revision = useSyncExternalStore(subscribeSlotRegistry, slotRegistryRevision)
  const [state, setState] = useState<PageLoadState>({ kind: 'loading' })
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const engine = getPluginEngine()
    const result = engine?.readSlot(page.pluginId, page.slot, page.id)
    if (!result || !result.ok) {
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

  const runAction = (actionId: string, itemKey?: string) => {
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
    const result = engine.dispatchSlotAction(page.pluginId, payload)
    if (result.refresh) {
      setReload((value) => value + 1)
    }
  }

  return (
    <div className={detailStyles.page}>
      {isMobile ? <MobileHeader /> : null}
      {/* 侧边栏收起后左上角是悬浮按钮组，面包屑必须让开，否则会压在按钮下面 */}
      <div className={clsx(detailStyles.header, siderCollapsed && styles.headerCollapsed)}>
        {/* 返回一律回到会话: 纯面板导航, 不恢复进入前的会话, 不触发会话读取 */}
        <button
          type="button"
          className={detailStyles.backButton}
          onClick={() => returnToChat()}
        >
          {t('pluginViewBackToChat')}
        </button>
      </div>
      {state.kind === 'loading' ? (
        <div className={detailStyles.loading}>{t('pluginPagesLoading')}</div>
      ) : state.kind === 'missing' || !model ? (
        <div className={detailStyles.empty}>{t('pluginPagesLoadFailed')}</div>
      ) : (
        <PageBody
          model={model}
          pluginName={pluginName}
          t={t}
          snapshot={snapshot}
          formModel={formModel}
          runAction={runAction}
        />
      )}
    </div>
  )
}

/** 页面主体: 标题、插件名与四个区块的渲染; 与宿主的控件口径一致 */
const PageBody = ({
  model,
  pluginName,
  t,
  snapshot,
  formModel,
  runAction,
}: {
  model: PageDescriptor
  pluginName: string
  t: Translate
  snapshot: SettingsFormSnapshot | null
  formModel: SettingsFormModel | null
  runAction: (actionId: string, itemKey?: string) => void
}) => (
  <>
    <h1 className={detailStyles.title}>{titledText(model, model.id, t)}</h1>
    <div className={detailStyles.subtitle}>{pluginName}</div>
    <div className={detailStyles.scroll}>
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
    </div>
  </>
)
