import { useMemo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getPluginEngine } from '../dsc-plugin-engine/index.js'
import type { SettingFieldDescriptor } from '../dsc-plugin-engine/index.js'
import { Button } from '../base/Button.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { SettingsFieldRow, settingFieldLabel } from './settings/fields.js'
import { useSettingsForm } from './settings/useSettingsForm.js'
import styles from './settings/PluginSettings.module.css'

/**
 * 插件详情页（设置表面）：已安装列表点插件名进入，不做路由，返回即回列表。
 * 形制照 dsh 的详情章节：面包屑 12.5/18 → 32 上距 → 标题簇（标题 20/28、描述 14/22、标识 12/18）
 * → 分节 32/12（节标题 14/20 500 加计数 12/18）。
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
      {/* 面包屑行沿用页头刻度：返回入口与其它页的标题落在同一条水平线 */}
      <div className={styles.header}>
        <button type="button" className={styles.crumb} onClick={onBack}>
          <span className={styles.crumbIcon} aria-hidden="true">
            <IconChevronRightOutline14 />
          </span>
          {t('pluginSettingsBack')}
        </button>
      </div>
      <div className={styles.scroll}>
        <div className={styles.detailHead}>
          <div className={styles.detailMain}>
            <h1 className={styles.detailTitle}>{t('pluginSettingsTitle')}</h1>
            <p className={styles.detailDesc}>{pluginName}</p>
            <p className={styles.detailName}>{pluginId}</p>
          </div>
        </div>
        {/* 分节：节间距 32、节内间距 12；节标题吃剩余宽，计数贴在其右侧基线上 */}
        <div className={styles.detailSections}>
          <section className={styles.detailSection}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>{t('pluginSettingsFieldsTitle')}</h2>
              <span className={styles.sectionCount}>{fields.length}</span>
            </div>
            {descriptor === null ? (
              <div className={styles.empty}>{t('pluginSettingsEmpty')}</div>
            ) : loading ? (
              <div className={styles.loading}>{t('pluginSettingsLoading')}</div>
            ) : failed ? (
              <div className={styles.empty}>{t('pluginSettingsLoadFailed')}</div>
            ) : model && snapshot ? (
              <div className={styles.fields}>
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
            ) : null}
          </section>
        </div>
      </div>
      {model && snapshot ? (
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
      ) : null}
    </div>
  )
}
