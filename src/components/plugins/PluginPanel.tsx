import clsx from 'clsx'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useIsMobile } from '../../app/viewport.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
import { useSettings } from '../../services/settings.js'
import { getPluginEngine } from '../dsc-plugin-engine/index.js'
import { isPluginSourceAllowed } from '../dsc-plugin-engine/loader.js'
import { market, type RemovedVerdict } from '../dsc-market/index.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconRefreshOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { InstalledPlugins } from './InstalledPlugins.js'
import { PluginSettingsDetail } from './PluginSettingsDetail.js'
import { judgeInstallFailure } from './installFailure.js'
import { LocalInstall } from './LocalInstall.js'
import { MarketPlugins } from './MarketPlugins.js'
import { PendingConflicts } from './PendingConflicts.js'
import { MobileHeader } from '../session/MobileHeader.js'
import {
  closePluginDetail,
  usePluginPanel,
  type PluginPanelTab,
} from './pluginPanelState.js'
import { usePluginList } from './usePluginList.js'
import styles from './PluginPanel.module.css'

const tabs: { value: PluginPanelTab; label: TranslationKey }[] = [
  { value: 'installed', label: 'pluginTabInstalled' },
  { value: 'market', label: 'pluginTabMarket' },
]

/**
 * 插件页：占据主区域，与对话界面互斥。
 * 顶部是标题与刷新，下面分段标签页，主体滚动，安装栏固定在底部。
 */
export const PluginPanel = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const tab = usePluginPanel((state) => state.tab)
  const detailPluginId = usePluginPanel((state) => state.detailPluginId)
  const { plugins, ready, refresh } = usePluginList()
  const installedIds = new Set(plugins.map((plugin) => plugin.id))
  const baseId = useId()
  const tabId = (value: PluginPanelTab) => `${baseId}-tab-${value}`
  const panelId = `${baseId}-tabpanel`
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  /** 标签页键盘导航：左右方向键循环切换，Home / End 跳到首尾 */
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((item) => item.value === tab)
    let next = index
    if (event.key === 'ArrowRight') {
      next = (index + 1) % tabs.length
    } else if (event.key === 'ArrowLeft') {
      next = (index - 1 + tabs.length) % tabs.length
    } else if (event.key === 'Home') {
      next = 0
    } else if (event.key === 'End') {
      next = tabs.length - 1
    } else {
      return
    }
    event.preventDefault()
    usePluginPanel.setState({ tab: tabs[next].value })
    tabRefs.current[next]?.focus()
  }

  const detail = detailPluginId !== null ? plugins.find((plugin) => plugin.id === detailPluginId) : undefined

  // 详情视图覆盖标签页内容：沿用同一页骨架，返回即回列表，不引入路由
  if (detailPluginId !== null) {
    return (
      <div className={styles.page}>
        {isMobile ? <MobileHeader /> : null}
        <div className={styles.body}>
          <PluginSettingsDetail
            pluginId={detailPluginId}
            pluginName={detail?.name ?? detailPluginId}
            onBack={closePluginDetail}
          />
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.header}>
        <h1 className={styles.title}>{t('pluginPanelTitle')}</h1>
        <IconButton
          icon={<IconRefreshOutline16 />}
          tooltip={t('pluginRefresh')}
          tooltipPlacement="bottom"
          onClick={refresh}
        />
      </div>
      <div className={styles.tabsBar}>
        <div role="tablist" className={styles.tabs} onKeyDown={onTabKeyDown}>
          {tabs.map((item, index) => (
            <button
              key={item.value}
              ref={(node) => {
                tabRefs.current[index] = node
              }}
              id={tabId(item.value)}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              aria-controls={panelId}
              tabIndex={tab === item.value ? 0 : -1}
              className={clsx(styles.tab, tab === item.value && styles.tabActive)}
              onClick={() => usePluginPanel.setState({ tab: item.value })}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.body} role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
        {tab === 'installed' ? (
          <div className={styles.scroll}>
            <PendingConflicts plugins={plugins} refresh={refresh} />
            <InstalledPlugins plugins={plugins} ready={ready} refresh={refresh} />
          </div>
        ) : (
          <MarketPlugins installedIds={installedIds} onInstalled={refresh} />
        )}
      </div>
      {tab === 'installed' ? <InstallFromUrl onInstalled={refresh} /> : null}
    </div>
  )
}

/**
 * 取已移除插件判定。
 * 市场未就绪或清单全部不可达时返回 null，调用方按未判定处理，不臆断。
 */
const removedVerdictOf = async (url: string): Promise<RemovedVerdict | null> => {
  const client = market()
  if (!client) {
    return null
  }
  try {
    return await client.checkRemoved(url)
  } catch {
    return null
  }
}

/** 从地址安装：只输入产物地址，清单由产物自带的 manifest 导出提供 */
const InstallFromUrl = ({ onInstalled }: { onInstalled: () => void }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [url, setUrl] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [installing, setInstalling] = useState(false)
  /** 安装失败的提示，常驻在安装栏下方；notice 用于已移除插件的温馨提示 */
  const [failure, setFailure] = useState<{ text: string; tone: 'error' | 'notice' } | null>(null)

  const submit = async () => {
    const target = url.trim()
    if (!isPluginSourceAllowed(target)) {
      setInvalid(true)
      return
    }
    const engine = getPluginEngine()
    if (!engine) {
      showToast({ type: 'error', key: 'pluginEngineUnavailable' })
      return
    }
    setInvalid(false)
    setFailure(null)
    setInstalling(true)
    try {
      const result = await engine.installFromUrl(target)
      if (result.ok) {
        // 自动启用被拒时引擎已经提示原因，这里不再用安装完成盖掉它
        if (result.activation?.ok !== false) {
          showToast({ key: 'pluginInstallDone' })
        }
        setUrl('')
      } else {
        // 只有取不到产物时才看链接是否指向已被来源移除的插件，其余失败原因与清单无关
        const verdict = await removedVerdictOf(target)
        const tip = judgeInstallFailure({ result, verdict, locale })
        if (tip.kind === 'undetermined') {
          setFailure({ text: pluginReasonText(result.reason, result.detail), tone: 'error' })
        } else {
          showToast(tip.kind === 'removed' ? tip.message : { ...tip.message, type: 'error' })
          setFailure({
            text: t(tip.message.key, tip.message.params),
            tone: tip.kind === 'removed' ? 'notice' : 'error',
          })
        }
      }
    } catch {
      showToast({
        type: 'error',
        key: 'pluginInstallRejected',
        params: { id: target, reason: pluginReasonText('load-failed') },
      })
    } finally {
      setInstalling(false)
      onInstalled()
    }
  }

  return (
    <div className={styles.installBar}>
      <div className={styles.installHeader}>
        <div className={styles.installTitle}>{t('pluginInstallFromUrl')}</div>
        <LocalInstall onInstalled={onInstalled} />
      </div>
      <div className={styles.installRow}>
        <input
          className={clsx(styles.input, styles.inputUrl, invalid && styles.inputInvalid)}
          value={url}
          placeholder={t('pluginInstallUrlPlaceholder')}
          aria-label={t('pluginInstallUrlLabel')}
          aria-invalid={invalid}
          autoComplete="off"
          spellCheck={false}
          disabled={installing}
          onChange={(event) => {
            setUrl(event.target.value)
            setInvalid(false)
            setFailure(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              void submit()
            }
          }}
        />
        <Button variant="primary" size="m" disabled={installing} onClick={() => void submit()}>
          {installing ? t('pluginInstalling') : t('pluginActionInstall')}
        </Button>
      </div>
      {invalid ? <div className={styles.fieldError}>{t('pluginInstallUrlInvalid')}</div> : null}
      {!installing && failure !== null ? (
        <div
          className={clsx(styles.fieldError, failure.tone === 'notice' && styles.fieldNotice)}
          role={failure.tone === 'notice' ? 'status' : 'alert'}
        >
          {failure.text}
        </div>
      ) : null}
    </div>
  )
}
