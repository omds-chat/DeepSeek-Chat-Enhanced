import clsx from 'clsx'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
import { getPluginEngine } from '../dsc-plugin-engine/index.js'
import { isPluginSourceAllowed } from '../dsc-plugin-engine/loader.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { InstalledPlugins } from './InstalledPlugins.js'
import { LocalInstall } from './LocalInstall.js'
import { MarketPlugins } from './MarketPlugins.js'
import { closePluginPanel, usePluginPanel, type PluginPanelTab } from './pluginPanelState.js'
import { usePluginList } from './usePluginList.js'
import styles from './PluginPanel.module.css'

const tabs: { value: PluginPanelTab; label: TranslationKey }[] = [
  { value: 'installed', label: 'pluginTabInstalled' },
  { value: 'market', label: 'pluginTabMarket' },
]

/** 插件面板：侧边栏底部入口打开，内含「已安装」与「插件市场」两个标签页 */
export const PluginPanel = () => {
  const open = usePluginPanel((state) => state.open)
  return open ? <PluginPanelContent /> : null
}

const PluginPanelContent = () => {
  const t = useTranslate()
  const tab = usePluginPanel((state) => state.tab)
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

  return (
    <Modal
      title={t('pluginPanelTitle')}
      closable
      className={styles.dialog}
      mainClassName={styles.panelMain}
      onClose={closePluginPanel}
    >
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
      <div className={styles.body} role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
        {tab === 'installed' ? (
          <InstalledPlugins plugins={plugins} ready={ready} refresh={refresh} />
        ) : (
          <MarketPlugins installedIds={installedIds} onInstalled={refresh} />
        )}
      </div>
      <InstallFromUrl onInstalled={refresh} />
    </Modal>
  )
}

/** 从地址安装：只输入产物地址，清单由产物自带的 manifest 导出提供 */
const InstallFromUrl = ({ onInstalled }: { onInstalled: () => void }) => {
  const t = useTranslate()
  const [url, setUrl] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [installing, setInstalling] = useState(false)
  /** 安装失败原因，常驻在安装栏下方，直到用户改动地址或重新安装 */
  const [failure, setFailure] = useState<string | null>(null)

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
        showToast({ key: 'pluginInstallDone' })
        setUrl('')
      } else {
        setFailure(pluginReasonText(result.reason, result.detail))
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
        <div className={styles.fieldError} role="alert">
          {failure}
        </div>
      ) : null}
    </div>
  )
}
