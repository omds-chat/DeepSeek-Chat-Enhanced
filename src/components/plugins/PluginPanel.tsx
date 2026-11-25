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
import { Menu } from '../base/Menu.js'
import { IconLinkOutline14, IconUploadOutline14 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { InstalledPlugins } from './InstalledPlugins.js'
import { PluginSettingsDetail } from './PluginSettingsDetail.js'
import { judgeInstallFailure } from './installFailure.js'
import { LocalInstall, type LocalInstallHandle } from './LocalInstall.js'
import { MarketPlugins } from './MarketPlugins.js'
import { PendingConflicts } from './PendingConflicts.js'
import { MobileHeader } from '../session/MobileHeader.js'
import {
  closePluginDetail,
  setPluginPanelTab,
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
 * 插件面板：管理插件，占据主区域，与会话视图互斥。
 * 页头左侧是标题与副标题，右侧是刷新与「添加插件」工具条，下面是分段标签页。
 * 安装入口全部收进页头菜单：地址安装展开一张面板，本地安装复用离线包选择。
 * 插件页面不在这里: 它是会话视图的一种, 入口在会话视图列表(见 pluginViewState)。
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
  /** 市场工具条的挂载点：它落在吸顶块里，市场页通过 portal 把工具条挂进来 */
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null)
  /** 地址安装面板是否展开；入口是页头「添加插件」菜单的第一项 */
  const [adding, setAdding] = useState(false)
  /** 本地安装的入口：文件选择框与确认对话框都在 LocalInstall 里，这里只持有触发句柄 */
  const localInstall = useRef<LocalInstallHandle>(null)

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
    setPluginPanelTab(tabs[next].value)
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
      {/* 滚动上提到页面层：滚动条落在主区右缘，页头与页签条在其中吸顶 */}
      <div className={styles.feed}>
        <div className={styles.stickyBar}>
          <div className={styles.bar}>
            <div className={styles.pluginHead}>
              {/* 左块：标题与副标题纵向排列。契约只给了两个文本类，分组由无类名的 div 承担 */}
              <div>
                <h1 className={styles.pluginTitle}>{t('pluginPanelTitle')}</h1>
                <div className={styles.pluginIntro}>{t('pluginPageIntro')}</div>
              </div>
              <div className={styles.pluginToolbar}>
                <Button variant="outlined" size="s" onClick={refresh}>
                  {t('pluginRefresh')}
                </Button>
                <Menu
                  options={[
                    {
                      key: 'url',
                      label: t('pluginAddFromUrl'),
                      icon: <IconLinkOutline14 />,
                      onSelect: () => setAdding(true),
                    },
                    {
                      key: 'file',
                      label: t('pluginAddFromFile'),
                      icon: <IconUploadOutline14 />,
                      onSelect: () => localInstall.current?.pick(),
                    },
                  ]}
                >
                  {({ open, toggle }) => (
                    <Button
                      variant="primary"
                      size="s"
                      aria-haspopup="menu"
                      aria-expanded={open}
                      onClick={toggle}
                    >
                      {t('pluginAdd')}
                    </Button>
                  )}
                </Menu>
              </div>
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
                    onClick={() => setPluginPanelTab(item.value)}
                  >
                    {t(item.label)}
                  </button>
                ))}
              </div>
            </div>
            {/* 市场工具条随页头吸顶：挂载点只在市场页签存在，占位高度由工具条自身撑开 */}
            {tab === 'market' ? <div ref={setToolbarSlot} /> : null}
          </div>
        </div>
        <div className={styles.column} role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
          {/* 地址安装面板落在正文最上方，收起后把高度还给列表 */}
          {adding ? (
            <InstallFromUrl onInstalled={refresh} onCancel={() => setAdding(false)} />
          ) : null}
          {tab === 'installed' ? (
            <>
              <PendingConflicts plugins={plugins} refresh={refresh} />
              <InstalledPlugins plugins={plugins} ready={ready} refresh={refresh} />
            </>
          ) : (
            <MarketPlugins
              installedIds={installedIds}
              onInstalled={refresh}
              toolbarSlot={toolbarSlot}
            />
          )}
        </div>
      </div>
      {/* 本地安装的隐藏文件输入与确认对话框常驻挂载：两个页签都能从页头菜单触发 */}
      <LocalInstall ref={localInstall} hideTrigger onInstalled={refresh} />
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

/**
 * 从地址安装：只输入产物地址，清单由产物自带的 manifest 导出提供。
 * 面板由页头菜单展开、由「取消」收起，失败原因常驻在面板内直到重新提交。
 */
const InstallFromUrl = ({
  onInstalled,
  onCancel,
}: {
  onInstalled: () => void
  onCancel: () => void
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [url, setUrl] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [installing, setInstalling] = useState(false)
  /** 安装失败的提示，常驻在面板下方；notice 用于已移除插件的温馨提示 */
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
    <div className={styles.addPanel}>
      {/* 面板标题沿用既有的「从地址安装」文案键，菜单项另有自己的键 */}
      <div className={styles.caption}>{t('pluginInstallFromUrl')}</div>
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
        <Button variant="primary" size="s" disabled={installing} onClick={() => void submit()}>
          {installing ? t('pluginInstalling') : t('pluginActionInstall')}
        </Button>
        {/* 安装进行中不能收起面板：面板一收，安装结论就没有落点 */}
        <Button variant="outlined" size="s" disabled={installing} onClick={onCancel}>
          {t('cancel')}
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
