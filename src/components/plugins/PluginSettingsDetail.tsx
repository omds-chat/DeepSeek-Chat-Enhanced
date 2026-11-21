import { useMemo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getPluginEngine } from '../dsc-plugin-engine/index.js'
import type { SettingFieldDescriptor } from '../dsc-plugin-engine/index.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { SettingsFieldRow, settingFieldLabel } from './settings/fields.js'
import { useSettingsForm } from './settings/useSettingsForm.js'
import styles from './settings/PluginSettings.module.css'

/**
 * 插件详情页（设置表面）：已安装列表点插件名进入，不做路由，返回即回列表。
 * 表单由宿主按插件登记的字段描述渲染；插件没有登记描述时显示无可配置项。
 * 脏值生命周期：改动即脏、保存才落盘、保存失败保留草稿、离开页面丢弃草稿。
 */
export const PluginSettingsDetail = ({
  pluginId,
  pluginName,
  onBack,
}: {
  pluginId: string
  pluginName: string
  onBack: () => void
}) => {
  const t = useTranslate()
  const facade = useMemo(() => getPluginEngine()?.pluginSettings(pluginId) ?? null, [pluginId])
  const descriptor = facade?.descriptor() ?? null
  const { loading, failed, model } = useSettingsForm(facade, descriptor)

  /** 保存：整批条目逐一交给门面；失败由模型保留草稿并提示 */
  const save = () => {
    if (!model) {
      return
    }
    void model.save().then((ok) => {
      if (ok) {
        showToast({ key: 'pluginSettingsSaved' })
      }
    })
  }

  const fields = descriptor?.fields ?? []
  const snapshot = model?.snapshot()

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <button type="button" className={styles.backButton} onClick={onBack}>
          {t('pluginSettingsBack')}
        </button>
      </div>
      <h1 className={styles.title}>{t('pluginSettingsTitle')}</h1>
      <div className={styles.subtitle}>{pluginName}</div>
      {descriptor === null ? (
        <div className={styles.empty}>{t('pluginSettingsEmpty')}</div>
      ) : loading ? (
        <div className={styles.loading}>{t('pluginSettingsLoading')}</div>
      ) : failed ? (
        <div className={styles.empty}>{t('pluginSettingsLoadFailed')}</div>
      ) : model && snapshot ? (
        <>
          <div className={styles.scroll}>
            {fields.map((field: SettingFieldDescriptor) => {
              const draft = snapshot.fields.find((item) => item.key === field.key)
              const secret = snapshot.secrets.find((item) => item.key === field.key) ?? null
              if (!draft) {
                return null
              }
              return (
                <SettingsFieldRow
                  key={field.key}
                  field={field}
                  draft={draft}
                  secret={secret}
                  label={settingFieldLabel(field, t)}
                  onSwitchChange={(value) => model.change(field.key, value, field)}
                  onTextChange={(value) => model.change(field.key, value, field)}
                  onSelectChange={(value) => model.change(field.key, value, field)}
                  onReset={() => model.resetField(field)}
                  onSecretReset={() => {
                    void facade
                      ?.reset(field.key)
                      .then((result) => {
                        if (result.ok) {
                          model.secretCleared(field.key)
                        }
                      })
                      .catch(() => undefined)
                  }}
                />
              )
            })}
          </div>
          <div className={styles.saveBar}>
            <Button
              variant="primary"
              size="m"
              disabled={!snapshot.canSave}
              onClick={save}
            >
              {t('pluginSettingsSave')}
            </Button>
            {snapshot.saveFailed ? (
              <span className={styles.saveError}>{t('pluginSettingsSaveFailed')}</span>
            ) : (
              <span className={styles.saveHint}>{t('pluginSettingsSaveHint')}</span>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
