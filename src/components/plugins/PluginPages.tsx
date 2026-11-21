import { useEffect, useMemo, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  getPluginEngine,
  type PageDescriptor,
  type PluginPageEntry,
  type SettingFieldDescriptor,
  type SettingValue,
} from '../dsc-plugin-engine/index.js'
import type { PluginStateView } from '../dsc-plugin-engine/types.js'
import { Button } from '../base/Button.js'
import { SettingsFieldRow, settingFieldLabel } from './settings/fields.js'
import { SettingsFormModel, type SettingsFormSnapshot } from './settings/useSettingsForm.js'
import { closePluginPage, openPluginPage, usePluginPanel, type PluginPageRef } from './pluginPanelState.js'
import detailStyles from './settings/PluginSettings.module.css'
import styles from './PluginPages.module.css'

/**
 * 插件页面：插件面板第三个标签页。
 * 列出全部已登记的插件页面（每个页面一个入口，名字用页面标题），
 * 页面内容由宿主按描述渲染：text、list、form 与 actions 四种区块，
 * 表单区块复用设置表面的五种控件与脏值生命周期。
 * 动作按钮经引擎同步回调插件；返回刷新指示时重新向插件索取页面模型。
 * 不做路由、不做模态遮罩：进入页面即替换标签页内容，返回即回页面列表。
 */

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/** 解析标题文案：titleKey 走宿主字典，title 直给 */
const pageTitle = (
  entry: { titleKey?: string; title?: string; pageId?: string },
  t: Translate
): string =>
  typeof entry.titleKey === 'string'
    ? t(entry.titleKey as TranslationKey)
    : (entry.title ?? entry.pageId ?? '')

/** 解析条目徽标文案：badgeKey 走宿主字典，badge 直给 */
const itemBadge = (
  item: { badgeKey?: string; badge?: string },
  t: Translate
): string =>
  typeof item.badgeKey === 'string'
    ? t(item.badgeKey as TranslationKey)
    : (item.badge ?? '')

/** 解析动作按钮文案：labelKey 走宿主字典，label 直给 */
const actionLabel = (
  action: { labelKey?: string; label?: string; key: string },
  t: Translate
): string =>
  typeof action.labelKey === 'string'
    ? t(action.labelKey as TranslationKey)
    : (action.label ?? action.key)

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
        },
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

export const PluginPages = ({ plugins }: { plugins: PluginStateView[] }) => {
  const t = useTranslate()
  const page = usePluginPanel((state) => state.page)
  const engine = getPluginEngine()
  const entries: PluginPageEntry[] = engine ? engine.pluginPages() : []

  if (page !== null) {
    const pluginName = plugins.find((item) => item.id === page.pluginId)?.name ?? page.pluginId
    return <PluginPageView pageRef={page} pluginName={pluginName} onBack={closePluginPage} />
  }
  if (entries.length === 0) {
    return <div className={detailStyles.empty}>{t('pluginPagesEmpty')}</div>
  }
  return (
    <div className={detailStyles.scroll}>
      <div className={styles.entryList}>
        {entries.map((entry) => (
          <div key={entry.pluginId + '/' + entry.pageId} className={styles.entry}>
            <div className={styles.entryHead}>
              <button
                type="button"
                className={detailStyles.nameButton}
                onClick={() => openPluginPage(entry.pluginId, entry.pageId)}
              >
                <span className={styles.entryTitle}>{pageTitle(entry, t)}</span>
              </button>
            </div>
            <span className={styles.entryCaption}>{entry.pluginId}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const PluginPageView = ({
  pageRef,
  pluginName,
  onBack,
}: {
  pageRef: PluginPageRef
  pluginName: string
  onBack: () => void
}) => {
  const t = useTranslate()
  const [state, setState] = useState<PageLoadState>({ kind: 'loading' })
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const engine = getPluginEngine()
    const result = engine?.readPage(pageRef.pluginId, pageRef.pageId)
    if (!result || !result.ok) {
      setState({ kind: 'missing' })
      return
    }
    setState({ kind: 'ready', model: result.model })
  }, [pageRef.pluginId, pageRef.pageId, reload])

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
      pageId: string
      actionId: string
      itemKey?: string
      form?: Record<string, SettingValue>
    } = {
      pageId: model.id,
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
    const result = engine.dispatchPageAction(pageRef.pluginId, payload)
    if (result.refresh) {
      setReload((value) => value + 1)
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className={detailStyles.page}>
        <div className={detailStyles.header}>
          <button type="button" className={detailStyles.backButton} onClick={onBack}>
            {t('pluginPagesBack')}
          </button>
        </div>
        <div className={detailStyles.loading}>{t('pluginPagesLoading')}</div>
      </div>
    )
  }
  if (state.kind === 'missing' || !model) {
    return (
      <div className={detailStyles.page}>
        <div className={detailStyles.header}>
          <button type="button" className={detailStyles.backButton} onClick={onBack}>
            {t('pluginPagesBack')}
          </button>
        </div>
        <div className={detailStyles.empty}>{t('pluginPagesLoadFailed')}</div>
      </div>
    )
  }
  return (
    <div className={detailStyles.page}>
      <div className={detailStyles.header}>
        <button type="button" className={detailStyles.backButton} onClick={onBack}>
          {t('pluginPagesBack')}
        </button>
      </div>
      <h1 className={detailStyles.title}>{pageTitle(model, t)}</h1>
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
                      <span className={styles.listItemTitle}>{pageTitle(item, t)}</span>
                      {item.badgeKey !== undefined || item.badge !== undefined ? (
                        <span className={detailStyles.badge}>{itemBadge(item, t)}</span>
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
                          {actionLabel(itemAction, t)}
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
                  {actionLabel(action, t)}
                </Button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
