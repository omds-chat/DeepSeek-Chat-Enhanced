import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconCloseOutline16,
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconLoadingOutline16,
  IconPluginOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import { useIsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setAllowLanHttp,
  setLocale,
  setLocation,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import {
  clearAllPluginData,
  clearPluginData,
  listPluginData,
  type PluginDataUsage,
} from '../dsc-core/index.js'
import { formatBytes } from '../../utils/format.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { MobileHeader } from '../session/MobileHeader.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import {
  selectSettingsSection,
  useSettingsDialog,
  type SettingsSection,
} from './settingsDialogState.js'
import { SettingsPluginPages } from '../plugins/SettingsPluginPages.js'
import { settingsPages } from '../plugins/slotProjection.js'
import { useSlotRegistry } from '../plugins/useSlotRegistry.js'
import { selectPanel } from '../plugins/pluginViewState.js'
import styles from './Settings.module.css'

/** 二次确认的保持时间（毫秒），与插件页的更新确认同一节奏 */
const CONFIRM_MS = 3000

/**
 * 设置整页：主区的一块，与会话、插件面板互斥。
 * 桌面为左侧导航轨加自身滚动的内容区，窄屏导航改横向条；
 * 关闭即回到会话（selectPanel(null)），不铺遮罩、不做居中面板。
 */
export const SettingsPage = ({ siderCollapsed }: { siderCollapsed: boolean }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 分组存在 store 里: 打开设置的调用方(侧边栏、401 提示)指定落到哪一组
  const section = useSettingsDialog((state) => state.section)
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  // 插件分组的出现与否跟着登记表走: 插件激活时登记、停用或卸载时撤销
  const { entries, plugins } = useSlotRegistry()
  const pluginSectionVisible = settingsPages(entries, plugins, t).length > 0
  const sections = pluginSectionVisible ? [...baseSections, PLUGIN_SECTION] : baseSections
  const contentRef = useRef<HTMLDivElement>(null)
  // 插件在设置页停留期间被停用或卸载时, 分组整块消失, 选中态回落到通用设置
  useEffect(() => {
    if (section === 'plugins' && !pluginSectionVisible) {
      selectSettingsSection('general')
    }
  }, [section, pluginSectionVisible])
  // 换分组回到内容顶部: 内容区是整页滚动, 留着上一组的滚动位置会落到半截处
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0
    }
  }, [section])
  return (
    <div className={styles.page}>
      {isMobile ? <MobileHeader /> : null}
      {/* 侧栏收起后左上角是悬浮按钮组，页头让开它，标题才不被压住 */}
      <div className={clsx(styles.pageHeader, siderCollapsed && styles.pageHeaderCollapsed)}>
        <h1 className={styles.pageTitle}>{t('settings')}</h1>
        <IconButton
          tone="primary"
          icon={<IconCloseOutline16 />}
          tooltip={t('close')}
          tooltipPlacement="bottom"
          onClick={() => {
            // 导入或清理进行中不离开: 页面卸载会丢掉进行中的状态提示
            if (!historyBusy) {
              // 关闭即丢弃上一次导入留下的结果提示与待确认文件
              historyImport.dismiss()
              selectPanel(null)
            }
          }}
        />
      </div>
      <div className={styles.pageBody}>
        <div
          role="tablist"
          aria-orientation={isMobile ? 'horizontal' : 'vertical'}
          className={styles.navigation}
        >
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => selectSettingsSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div ref={contentRef} role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
              <SourceLanHttpSetting />
            </>
          ) : section === 'plugins' ? (
            <SettingsPluginPages />
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <DeleteAllSessions historyDelete={historyDelete} disabled={historyBusy} />
              <PluginDataSection />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const baseSections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

/** 「插件」分组: 只在有 settings.page 登记项时出现, 空分组不占导航 */
const PLUGIN_SECTION: { value: SettingsSection; label: TranslationKey; icon: ReactNode } = {
  value: 'plugins',
  label: 'settingDialogAsidePluginsOptionLabel',
  icon: <IconPluginOutline16 />,
}

/** 整体清理的确认键；插件 id 由清单校验限定为字母开头，不会与它相同 */
const ALL_PLUGIN_DATA = '*'

/**
 * 插件遗留数据：列出卸载后保留下来的插件数据，逐项与整体清理都走
 * 「替换为确认按钮、3 秒内点击确认、超时回归初始状态」。
 * 列表在进入设置时读取一次，每次清理后重新读取。
 */
const PluginDataSection = () => {
  const t = useTranslate()
  const [entries, setEntries] = useState<PluginDataUsage[]>(() => listPluginData())
  const [confirming, setConfirming] = useState<string | null>(null)
  const confirmTimer = useRef(0)

  useEffect(() => () => window.clearTimeout(confirmTimer.current), [])

  /** 置为待确认状态，3 秒后回归 */
  const arm = (target: string) => {
    setConfirming(target)
    window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setConfirming(null), CONFIRM_MS)
  }

  const refreshEntries = () => {
    window.clearTimeout(confirmTimer.current)
    setConfirming(null)
    setEntries(listPluginData())
  }

  const clearOne = (pluginId: string) => {
    try {
      clearPluginData(pluginId)
      showToast({ key: 'settingsPluginDataCleared', params: { id: pluginId } })
    } catch {
      showToast({ key: 'settingsPluginDataClearFailed', type: 'error' })
    }
    refreshEntries()
  }

  const clearAll = () => {
    try {
      clearAllPluginData()
      showToast({ key: 'settingsPluginDataClearedAll' })
    } catch {
      showToast({ key: 'settingsPluginDataClearFailed', type: 'error' })
    }
    refreshEntries()
  }

  return (
    <div className={styles.pluginData}>
      <div className={styles.pluginDataHead}>
        <div className={styles.label}>{t('settingsPluginDataTitle')}</div>
        <div className={styles.description}>{t('settingsPluginDataDescription')}</div>
      </div>
      {entries.length === 0 ? (
        <div className={styles.pluginDataEmpty}>{t('settingsPluginDataEmpty')}</div>
      ) : (
        <div className={styles.pluginDataList} role="list">
          {entries.map((entry) => {
            const armed = confirming === entry.pluginId
            return (
              <div key={entry.pluginId} className={styles.pluginDataRow} role="listitem">
                <span className={styles.pluginDataId} title={entry.pluginId}>
                  {entry.pluginId}
                </span>
                <span className={styles.pluginDataKeys}>
                  {t('settingsPluginDataKeys', { count: entry.keys })}
                </span>
                <span className={styles.pluginDataSize}>{formatBytes(entry.bytes)}</span>
                <Button
                  variant={armed ? 'danger' : 'dangerOutlined'}
                  size="s"
                  onClick={() => {
                    if (armed) {
                      clearOne(entry.pluginId)
                      return
                    }
                    arm(entry.pluginId)
                  }}
                >
                  {t(armed ? 'settingsPluginDataClearConfirm' : 'settingsPluginDataClear')}
                </Button>
              </div>
            )
          })}
        </div>
      )}
      <div className={styles.pluginDataFooter}>
        <Button
          variant={confirming === ALL_PLUGIN_DATA ? 'danger' : 'dangerOutlined'}
          size="m"
          className={styles.cellButton}
          disabled={entries.length === 0}
          onClick={() => {
            if (confirming === ALL_PLUGIN_DATA) {
              clearAll()
              return
            }
            arm(ALL_PLUGIN_DATA)
          }}
        >
          {t(
            confirming === ALL_PLUGIN_DATA
              ? 'settingsPluginDataClearAllConfirm'
              : 'settingsPluginDataClearAll'
          )}
        </Button>
      </div>
    </div>
  )
}

/**
 * 删除全部会话：按钮原位替换为确认态，3 秒内再点一次才执行，
 * 确认态期间单元下方给出后果说明，超时回到初始按钮。
 */
const DeleteAllSessions = ({
  historyDelete,
  disabled,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
  disabled: boolean
}) => {
  const t = useTranslate()
  const armed = historyDelete.armed
  return (
    <SettingCell
      label={t('deleteAllSessions')}
      description={armed ? t('deleteAllSessionsModalTitle') : undefined}
      status={null}
      action={
        <>
          {armed ? (
            <Button
              variant="outlined"
              size="m"
              className={styles.cellButton}
              onClick={historyDelete.cancel}
            >
              {t('cancel')}
            </Button>
          ) : null}
          <Button
            variant={armed ? 'danger' : 'dangerOutlined'}
            size="m"
            className={styles.cellButton}
            disabled={disabled}
            onClick={() => {
              if (armed) {
                void historyDelete.confirm()
                return
              }
              historyDelete.arm()
            }}
          >
            {t(armed ? 'deleteAllSessions' : 'delete')}
          </Button>
        </>
      }
    />
  )
}

const useHistoryDelete = () => {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)
  const confirmTimer = useRef(0)

  useEffect(() => () => window.clearTimeout(confirmTimer.current), [])

  /** 置为待确认状态，3 秒后回归初始按钮 */
  const arm = () => {
    setArmed(true)
    window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setArmed(false), CONFIRM_MS)
  }

  const cancel = () => {
    window.clearTimeout(confirmTimer.current)
    setArmed(false)
  }

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    window.clearTimeout(confirmTimer.current)
    setArmed(false)
    setBusy(true)
    try {
      await clearHistory()
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return { armed, busy, arm, cancel, confirm }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

/**
 * 供应端点的局域网 http 开关：默认关闭，打开后端点基址不再限于 https 与回环地址。
 * 只影响供应端点校验，资产读取与插件来源仍按原口径拒绝局域网 http。
 */
const SourceLanHttpSetting = () => {
  const t = useTranslate()
  const allowLanHttp = useSettings((state) => state.allowLanHttp)
  const label = t('settingsSourceLanHttp')
  return (
    <SettingCell
      label={label}
      description={t('settingsSourceLanHttpDescription')}
      status={null}
      action={
        <button
          type="button"
          role="switch"
          aria-checked={allowLanHttp}
          aria-label={label}
          className={clsx(styles.switch, allowLanHttp && styles.switchOn)}
          onClick={() => setAllowLanHttp(!allowLanHttp)}
        >
          <span className={styles.switchThumb} />
        </button>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/**
 * 选文件后进入确认态：按钮原位换成「确认导入」，3 秒内不点即丢弃所选文件。
 * 确认后才检查文件并执行导入，任何错误都提示导入失败。
 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<{ processed: number; total?: number } | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)
  const confirmTimer = useRef(0)

  useEffect(() => () => window.clearTimeout(confirmTimer.current), [])

  const select = (next: File) => {
    setStatus(null)
    setFile(next)
    window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setFile(null), CONFIRM_MS)
  }

  const cancel = () => {
    window.clearTimeout(confirmTimer.current)
    setFile(null)
  }

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    window.clearTimeout(confirmTimer.current)
    setFile(null)
    setProgress({ processed: 0 })
    setStatus(null)
    try {
      const count = await importHistory(file, (processed, total) =>
        setProgress({ processed, total })
      )
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setProgress(null)
    }
  }

  return {
    file,
    busy: progress !== null,
    progress,
    status,
    select,
    cancel,
    dismiss: () => {
      setFile(null)
      setStatus(null)
    },
    confirm,
  }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const choosing = historyImport.file !== null
  const { progress } = historyImport

  return (
    <SettingCell
      className={progress ? styles.importing : undefined}
      label={t('historyImport')}
      description={
        choosing ? t('historyImportConfirmDescription') : t('historyImportDescription')
      }
      status={historyImport.status}
      action={
        <>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
          {choosing ? (
            <>
              <Button
                variant="outlined"
                size="m"
                className={styles.cellButton}
                onClick={historyImport.cancel}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="dangerOutlined"
                size="m"
                className={styles.cellButton}
                onClick={() => void historyImport.confirm()}
              >
                {t('historyImportConfirm')}
              </Button>
            </>
          ) : (
            <Button
              variant="outlined"
              size="m"
              className={clsx(styles.cellButton, styles.uploadButton)}
              aria-busy={historyImport.busy}
              aria-label={historyImport.busy ? t('historyImport') : undefined}
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              {progress ? (
                <IconLoadingOutline16 />
              ) : (
                <>
                  <IconUploadOutline14 />
                  {t('upload')}
                </>
              )}
            </Button>
          )}
          {progress?.total !== undefined && (
            <div className={styles.importProgress}>
              <div
                className={styles.importTrack}
                role="progressbar"
                aria-label={t('historyImport')}
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.processed}
              >
                <span
                  style={{
                    width: `${progress.total ? (progress.processed / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
              <span>
                {progress.processed} / {progress.total}
              </span>
            </div>
          )}
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
