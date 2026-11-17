import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { getPluginEngine } from '../dsc-plugin-engine/index.js'
import { isPluginSourceAllowed } from '../dsc-plugin-engine/loader.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { InstalledPlugins } from './InstalledPlugins.js'
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

  return (
    <Modal
      title={t('pluginPanelTitle')}
      closable
      className={styles.dialog}
      mainClassName={styles.panelMain}
      onClose={closePluginPanel}
    >
      <div role="tablist" className={styles.tabs}>
        {tabs.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={tab === item.value}
            className={clsx(styles.tab, tab === item.value && styles.tabActive)}
            onClick={() => usePluginPanel.setState({ tab: item.value })}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <div className={styles.body} role="tabpanel">
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
    setInstalling(true)
    try {
      const result = await engine.installFromUrl(target)
      if (result.ok) {
        showToast({ key: 'pluginInstallDone' })
        setUrl('')
      }
    } catch {
      showToast({
        type: 'error',
        key: 'pluginInstallRejected',
        params: { id: target, reason: 'load-failed' },
      })
    } finally {
      setInstalling(false)
      onInstalled()
    }
  }

  return (
    <div className={styles.installBar}>
      <div className={styles.installTitle}>{t('pluginInstallFromUrl')}</div>
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
    </div>
  )
}
