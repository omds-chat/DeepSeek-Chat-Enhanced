import clsx from 'clsx'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
import { isUnlistedTrust } from '../../i18n/pluginVerdicts.js'
import { useSettings } from '../../services/settings.js'
import { getPluginEngine } from '../dsc-plugin-engine/index.js'
import {
  market,
  toPluginId,
  type CatalogPlugin,
  type LocalizedText,
  type MarketSource,
  type SourceRuntime,
} from '../dsc-market/index.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconCloseOutline16,
  IconLoadingOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
} from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import { showToast } from '../base/toastState.js'
import { formatDateTime } from '../../utils/format.js'
import styles from './PluginPanel.module.css'

/** 二次确认的保持时间（毫秒） */
const CONFIRM_MS = 3000

/** 搜索防抖时延（毫秒） */
const SEARCH_DEBOUNCE_MS = 250

/** 卡片上平铺的标签上限，其余合并成一枚 +N */
const MAX_TAG_PILLS = 3

/** 客户端缺失时的占位订阅源，保证 Hook 顺序稳定 */
const EMPTY_STORE = {
  subscribe: () => () => undefined,
  version: () => 0,
}

const trustKey = (runtime: SourceRuntime | null): TranslationKey => {
  if (runtime?.trust === 'trusted') {
    return 'pluginMarketTrustTrusted'
  }
  if (runtime?.trust === 'endorsed') {
    return 'pluginMarketTrustEndorsed'
  }
  if (runtime?.trust === 'untrusted') {
    return 'pluginMarketTrustUntrusted'
  }
  return 'pluginMarketTrustUnverified'
}

const trustReasonKey = (runtime: SourceRuntime | null): TranslationKey => {
  if (runtime?.trustFailure === 'revoked') {
    return 'pluginMarketTrustReasonRevoked'
  }
  return runtime?.trustFailure === 'chain'
    ? 'pluginMarketTrustReasonChain'
    : 'pluginMarketTrustReasonMissing'
}

/** 按当前语言取双语简介；缺失的一侧用另一侧补 */
const pickText = (text: LocalizedText, locale: 'zh-CN' | 'en-US'): string =>
  text[locale] !== '' ? text[locale] : locale === 'zh-CN' ? text['en-US'] : text['zh-CN']

/** 本地过滤：名称、作者、标签与双语简介，大小写不敏感 */
const matchesQuery = (plugin: CatalogPlugin, needle: string): boolean => {
  const fields: string[] = [plugin.name, plugin.author, ...plugin.tags]
  if (plugin.meta !== null) {
    fields.push(plugin.meta.description['zh-CN'], plugin.meta.description['en-US'])
  }
  return fields.some((field) => field.toLowerCase().includes(needle))
}

/** 来源表单：新增与编辑共用 */
const SourceForm = ({
  name,
  urls,
  saveLabel,
  error,
  onName,
  onUrls,
  onSave,
  onCancel,
}: {
  name: string
  urls: string
  saveLabel: TranslationKey
  error: TranslationKey | null
  onName: (value: string) => void
  onUrls: (value: string) => void
  onSave: () => void
  onCancel: () => void
}) => {
  const t = useTranslate()
  return (
    <div className={styles.sourceForm}>
      <input
        className={clsx(styles.input, styles.inputSourceName)}
        value={name}
        placeholder={t('pluginMarketSourceName')}
        aria-label={t('pluginMarketSourceName')}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onName(event.target.value)}
      />
      <textarea
        className={styles.textarea}
        value={urls}
        placeholder={t('pluginMarketSourceUrls')}
        aria-label={t('pluginMarketSourceUrls')}
        rows={3}
        spellCheck={false}
        onChange={(event) => onUrls(event.target.value)}
      />
      {error !== null ? <div className={styles.fieldError}>{t(error)}</div> : null}
      <div className={styles.sourceFormActions}>
        <Button variant="outlined" size="s" onClick={onCancel}>
          {t('pluginMarketSourceCancel')}
        </Button>
        <Button variant="primary" size="s" onClick={onSave}>
          {t(saveLabel)}
        </Button>
      </div>
    </div>
  )
}

/** 插件市场：多来源、信任链校验、目录与安装 */
export const MarketPlugins = ({
  installedIds,
  onInstalled,
  toolbarSlot = null,
}: {
  installedIds: Set<string>
  onInstalled: () => void
  /** 页头吸顶块里的挂载点；交由 plugin 页注入，缺失时就地渲染工具条 */
  toolbarSlot?: HTMLElement | null
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const client = market()
  const store = client ?? EMPTY_STORE
  useSyncExternalStore(store.subscribe, store.version, store.version)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  /** 每张卡最近一次安装被拒的结论；空串表示没有失败 */
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<{ id: string; name: string; urls: string } | null>(null)
  const [formError, setFormError] = useState<TranslationKey | null>(null)
  const confirmTimer = useRef(0)

  const sources = client ? client.sources() : []
  const selectedId = client ? client.selected() : null
  const runtime = client && selectedId !== null ? client.runtime(selectedId) : null
  const plugins = runtime === null ? [] : runtime.plugins
  const fetchedAt = runtime === null ? null : runtime.fetchedAt

  /** 来源浮层默认收起；不跨会话记忆，浮层不是常驻区域 */
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const sourcesButtonRef = useRef<HTMLButtonElement | null>(null)
  const sourcesListId = `${useId()}-sources`

  /** 搜索草稿输入即改，防抖到点才提交成生效值 term */
  const [query, setQuery] = useState('')
  const [term, setTerm] = useState('')
  const searchTimer = useRef(0)
  const composingRef = useRef(false)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(
    () => () => {
      window.clearTimeout(confirmTimer.current)
      window.clearTimeout(searchTimer.current)
    },
    []
  )

  useEffect(() => {
    const instance = market()
    if (!instance) {
      return
    }
    // 打开市场时把每个来源都拉一次，来源列表才不会显示成「未拉取」的空白行
    for (const source of instance.sources()) {
      void instance.refresh(source.id)
    }
  }, [])

  // 点浮层与「来源」按钮之外关闭；Esc 关闭并把焦点交还按钮。
  // 不复用 useDismiss：它的两个入口共用一个回调，而交还焦点只该发生在 Esc 上。
  useEffect(() => {
    if (!sourcesOpen) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target) === true) {
        return
      }
      if (sourcesButtonRef.current?.contains(target) === true) {
        return
      }
      setSourcesOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      // 捕获阶段拦下，页面层的 Esc 不再重复处理
      event.stopPropagation()
      setSourcesOpen(false)
      sourcesButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [sourcesOpen])

  const refreshSource = useCallback(async (id: string, force: boolean) => {
    await market()?.refresh(id, force)
  }, [])

  const armConfirm = (key: string) => {
    setConfirmKey(key)
    window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setConfirmKey(null), CONFIRM_MS)
  }

  /** 卡片上的失败结论：写空串等于清掉该卡的行 */
  const setFailure = (key: string, text: string) => {
    setFailures((current) => ({ ...current, [key]: text }))
  }

  /** 只清未到点的定时器，不立刻提交 */
  const scheduleSearch = (value: string) => {
    window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(() => setTerm(value), SEARCH_DEBOUNCE_MS)
  }

  /** 立即提交：回车与清空都走这里，撤掉未到点的定时器 */
  const commitSearch = (value: string) => {
    window.clearTimeout(searchTimer.current)
    setTerm(value)
  }

  const onSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value
    setQuery(value)
    // 合成期不提交，等 compositionend 补一次
    if (composingRef.current) {
      return
    }
    if (value === '') {
      commitSearch('')
      return
    }
    scheduleSearch(value)
  }

  /** 清除搜索：草稿与生效值一起清空，焦点回输入框 */
  const clearSearch = () => {
    window.clearTimeout(searchTimer.current)
    setQuery('')
    setTerm('')
    searchInputRef.current?.focus()
  }

  /** 浮层内的 Tab 在浮层内循环，焦点不逃到背后的目录 */
  const onPopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = popoverRef.current
    if (event.key !== 'Tab' || root === null) {
      return
    }
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href]')
    ).filter((node) => !node.hasAttribute('disabled') && node.offsetParent !== null)
    if (focusable.length === 0) {
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const selectSource = (id: string) => {
    const instance = market()
    if (!instance) {
      return
    }
    instance.select(id)
    void instance.refresh(id)
  }

  const moveSource = (id: string, delta: -1 | 1) => {
    market()?.moveSource(id, delta)
  }

  const requestDelete = (id: string) => {
    if (confirmKey === 'delete:' + id) {
      market()?.removeSource(id)
      setConfirmKey(null)
      return
    }
    armConfirm('delete:' + id)
  }

  const startAdd = () => {
    setEditing({ id: '', name: '', urls: '' })
    setFormError(null)
  }

  const startEdit = (source: MarketSource) => {
    setEditing({ id: source.id, name: source.name, urls: source.baseUrls.join('\n') })
    setFormError(null)
  }

  const cancelEdit = () => {
    setEditing(null)
    setFormError(null)
  }

  const saveEdit = () => {
    const instance = market()
    if (!instance || !editing) {
      return
    }
    const urls = editing.urls
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
    if (editing.id === '') {
      const id = instance.addSource(editing.name, urls)
      if (id === null) {
        setFormError('pluginMarketSourceInvalid')
        return
      }
      setEditing(null)
      setFormError(null)
      void instance.refresh(id)
      return
    }
    if (!instance.setBaseUrls(editing.id, urls)) {
      setFormError('pluginMarketSourceInvalid')
      return
    }
    setEditing(null)
    setFormError(null)
    void instance.refresh(editing.id, true)
  }

  const install = async (plugin: CatalogPlugin) => {
    const instance = market()
    if (!instance || selectedId === null) {
      return
    }
    setFailure(plugin.key, '')
    const plan = instance.plan(selectedId, plugin)
    if (!plan) {
      const text = t('pluginMarketInstallUnavailable', { id: plugin.name })
      setFailure(plugin.key, text)
      showToast({ type: 'error', key: 'pluginMarketInstallUnavailable', params: { id: plugin.name } })
      return
    }
    const engine = getPluginEngine()
    if (!engine) {
      setFailure(plugin.key, t('pluginEngineUnavailable'))
      showToast({ type: 'error', key: 'pluginEngineUnavailable' })
      return
    }
    setBusyKey(plugin.key)
    try {
      // 来源信任判定一并交给引擎，只用于界面展示是否被官方认可
      const trustFailure = runtime?.trustFailure ?? null
      const result = await engine.installFromUrl(plan.url, plan.manifest, {
        sourceType: plan.sourceType,
        dataBase: plan.dataBase,
        pluginBase: plan.pluginBase,
        ...(plan.eec === undefined ? {} : { eec: plan.eec }),
        ...(plan.eecUrls === undefined ? {} : { eecUrls: plan.eecUrls }),
        sigUrl: plan.sigUrl,
        authorPubUrl: plan.authorPubUrl,
        authorSigUrl: plan.authorSigUrl,
        // 三层清单的结论一并交给引擎：目录数据是否已校验与来源结论相互独立
        catalogVerified: plan.catalogVerified,
        metaVerified: plan.metaVerified,
        revisions: plan.revisions,
        ...(plan.authorPubSha512 === undefined ? {} : { authorPubSha512: plan.authorPubSha512 }),
        ...(runtime === null ? {} : { trust: runtime.trust }),
        ...(trustFailure === null ? {} : { trustFailure }),
      })
      if (result.ok) {
        instance.countInstall(selectedId, plugin)
        // 自动启用被拒时引擎已经提示原因，这里不再用安装完成盖掉它
        if (result.activation?.ok !== false) {
          showToast({ key: 'pluginInstalled', params: { id: plugin.name } })
        }
      } else {
        // 失败结论同时钉在卡片上，toast 只做即时提醒
        const reason = pluginReasonText(result.reason, result.detail)
        setFailure(plugin.key, reason)
        showToast({
          type: 'error',
          key: 'pluginInstallRejected',
          params: { id: plugin.name, reason },
        })
      }
      onInstalled()
    } catch {
      const reason = pluginReasonText('load-failed')
      setFailure(plugin.key, reason)
      showToast({
        type: 'error',
        key: 'pluginInstallRejected',
        params: { id: plugin.name, reason },
      })
    } finally {
      setBusyKey(null)
      setConfirmKey(null)
    }
  }

  // 信任校验未通过不再禁用安装：保留「不可信」标识与提示，由用户自行判断
  const untrusted = runtime?.trust === 'untrusted'
  // 未在官方清单登记只是中性说明，不按不可信处理；安装时仍按本地链校验与验签给出结论
  const needsConfirm = runtime?.trust === 'unverified' || untrusted

  const needle = term.trim().toLowerCase()
  const searching = needle !== ''
  const visible = searching ? plugins.filter((plugin) => matchesQuery(plugin, needle)) : plugins

  /*
   * 结论行：清单结论一行、下载计数说明一行，最多两行。
   * 刷新失败但仍有上次目录时，失败原因独占第一行，过期结论不再重复播报。
   */
  const notices: string[] = []
  if (runtime !== null) {
    if (runtime.state === 'failed' && plugins.length > 0) {
      notices.push(runtime.error === null ? t('pluginMarketStatusFailed') : t(runtime.error))
    } else {
      const manifestNotes: string[] = []
      if (runtime.state === 'ready' && !runtime.catalogVerified) {
        manifestNotes.push(t('pluginMarketCatalogUnverified'))
      }
      for (const warning of runtime.revisionWarnings) {
        manifestNotes.push(
          t('pluginMarketRevisionRegressed', {
            layer: warning.layer,
            path: warning.path === '' ? '/' : warning.path,
            seen: warning.seen,
            revision: warning.revision,
          })
        )
      }
      if (isUnlistedTrust(runtime.trust)) {
        manifestNotes.push(t('pluginMarketNotListed'))
      }
      if (manifestNotes.length > 0) {
        notices.push(manifestNotes.join(' · '))
      }
      const countNotes: string[] = []
      if (runtime.meta?.downloadCountEnabled === true) {
        countNotes.push(t('pluginMarketCountNotice'))
        if (runtime.meta.apiNeedIp) {
          countNotes.push(t('pluginMarketCountIpNotice'))
        }
      }
      if (countNotes.length > 0) {
        notices.push(countNotes.join(' · '))
      }
    }
  }

  const refreshSelected = () => {
    if (selectedId !== null) {
      void refreshSource(selectedId, true)
    }
  }

  /*
   * 工具条由 PluginPanel 的吸顶块承载：portal 把它挂进 .stickyBar 里的挂载点，
   * 因此随页头与页签条一起吸顶，而不是跟着目录滚走。浮层的绝对定位仍相对这条工具条。
   */
  const toolbar = (
    <div className={styles.marketToolbar}>
      {/* 搜索图标：契约没给容纳它的类，按工具条 flex 行放在搜索框左侧 */}
      <IconSearchOutline16 />
      <div className={styles.marketSearch}>
        <input
          ref={searchInputRef}
          className={clsx(styles.input, styles.marketSearchInput)}
          value={query}
          placeholder={t('pluginMarketSearchPlaceholder')}
          aria-label={t('pluginMarketSearchPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={onSearchChange}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false
            scheduleSearch(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              commitSearch(event.currentTarget.value)
            }
          }}
        />
        {query === '' ? null : (
          <IconButton
            icon={<IconCloseOutline16 />}
            tooltip={t('pluginMarketSearchClear')}
            className={styles.marketSearchClear}
            // 按下时不抢焦点，清除后光标仍留在输入框
            onMouseDown={(event) => event.preventDefault()}
            onClick={clearSearch}
          />
        )}
      </div>
      <div className={styles.marketToolbarMeta}>
        <span className={styles.marketToolbarCount}>
          {searching
            ? t('pluginMarketSearchResultFiltered', {
                shown: visible.length,
                total: plugins.length,
              })
            : t('pluginMarketSearchResult', { count: plugins.length })}
        </span>
        {fetchedAt === null ? null : (
          <span className={styles.caption}>
            {t('pluginMarketIndexUpdatedAt', { time: formatDateTime(fetchedAt) ?? '' })}
          </span>
        )}
        {sources.length > 1 ? (
          <Tooltip content={t('pluginMarketSourcesCount', { count: sources.length })}>
            <span
              className={styles.badgeCount}
              aria-label={t('pluginMarketSourcesCount', { count: sources.length })}
            >
              {sources.length}
            </span>
          </Tooltip>
        ) : null}
        <Button
          variant="outlined"
          size="s"
          aria-expanded={sourcesOpen}
          aria-controls={sourcesListId}
          onClick={(event) => {
            // 退出浮层时把焦点还给这枚按钮
            sourcesButtonRef.current = event.currentTarget
            setSourcesOpen((open) => !open)
          }}
        >
          {t('pluginMarketSourcesOpen')}
        </Button>
        <IconButton
          icon={<IconRefreshOutline16 />}
          tooltip={t('pluginMarketRefresh')}
          disabled={selectedId === null || runtime?.state === 'loading'}
          onClick={refreshSelected}
        />
      </div>
      {sourcesOpen ? (
        <div
          ref={popoverRef}
          className={styles.sourcesPopover}
          id={sourcesListId}
          role="dialog"
          aria-label={t('pluginMarketSourcesOpen')}
          onKeyDown={onPopoverKeyDown}
        >
          <div className={styles.sourcesPopoverHead}>
            <span className={styles.sourcesPopoverTitle}>{t('pluginMarketSourcesOpen')}</span>
            <IconButton
              icon={<IconCloseOutline16 />}
              tooltip={t('pluginMarketSourcesClose')}
              onClick={() => setSourcesOpen(false)}
            />
          </div>
          <div className={styles.sourcesPopoverBody}>
            <div className={styles.sourceList}>
              {sources.length === 0 ? (
                <div className={styles.empty}>{t('pluginMarketNoSource')}</div>
              ) : null}
              {sources.map((source, index) => {
                const state = client?.runtime(source.id) ?? null
                const active = source.id === selectedId
                return (
                  <div
                    key={source.id}
                    className={clsx(styles.sourceRow, active && styles.sourceRowActive)}
                  >
                    <button
                      type="button"
                      className={styles.sourcePick}
                      aria-pressed={active}
                      onClick={() => selectSource(source.id)}
                    >
                      <span className={styles.sourceName}>{source.name}</span>
                      <span className={styles.caption}>
                        {state === null
                          ? t('pluginMarketSourceIdle')
                          : (state.baseUrl ?? t('pluginMarketSourceNoUrl'))}
                      </span>
                    </button>
                    <div className={styles.sourceBadges}>
                      <span
                        className={clsx(
                          styles.badge,
                          state?.trust === 'trusted'
                            ? styles.badgeTrusted
                            : state?.trust === 'endorsed'
                              ? styles.badgeEndorsed
                              : state?.trust === 'untrusted'
                                ? styles.badgeUntrusted
                                : styles.badgeUnverified
                        )}
                      >
                        {t(trustKey(state))}
                      </span>
                      {state?.meta?.downloadCountEnabled ? (
                        <span className={styles.badgeCount}>
                          {t('pluginMarketCountBadge')}
                        </span>
                      ) : null}
                    </div>
                    <div className={styles.sourceActions}>
                      <IconButton
                        icon={<IconRefreshOutline16 />}
                        tooltip={t('pluginMarketRefresh')}
                        disabled={state?.state === 'loading'}
                        onClick={() => void refreshSource(source.id, true)}
                      />
                      <Button
                        variant="outlined"
                        size="s"
                        disabled={editing !== null}
                        onClick={() => startEdit(source)}
                      >
                        {t('pluginMarketSourceEdit')}
                      </Button>
                      <Button
                        variant="outlined"
                        size="s"
                        disabled={index === 0 || editing !== null}
                        onClick={() => moveSource(source.id, -1)}
                      >
                        {t('pluginMarketSourceMoveUp')}
                      </Button>
                      <Button
                        variant="outlined"
                        size="s"
                        disabled={index === sources.length - 1 || editing !== null}
                        onClick={() => moveSource(source.id, 1)}
                      >
                        {t('pluginMarketSourceMoveDown')}
                      </Button>
                      <Button
                        variant="dangerOutlined"
                        size="s"
                        disabled={source.builtin || sources.length <= 1 || editing !== null}
                        onClick={() => requestDelete(source.id)}
                      >
                        {confirmKey === 'delete:' + source.id
                          ? t('pluginMarketSourceDeleteConfirm')
                          : t('pluginMarketSourceDelete')}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
            {editing ? (
              <SourceForm
                name={editing.name}
                urls={editing.urls}
                saveLabel={
                  editing.id === '' ? 'pluginMarketSourceAddConfirm' : 'pluginMarketSourceSave'
                }
                error={formError}
                onName={(value) => setEditing({ ...editing, name: value })}
                onUrls={(value) => setEditing({ ...editing, urls: value })}
                onSave={saveEdit}
                onCancel={cancelEdit}
              />
            ) : null}
            <div className={styles.sourceFooter}>
              <Button
                variant="outlined"
                size="s"
                disabled={editing !== null}
                onClick={startAdd}
              >
                {t('pluginMarketSourceAdd')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )

  return (
    <div className={styles.marketCatalog}>
      {!client ? (
        <div className={styles.marketState}>
          <div className={styles.marketStateText}>{t('pluginMarketUnavailable')}</div>
        </div>
      ) : (
        <>
          {/* 有挂载点就挂进吸顶块，还没拿到时先就地渲染 */}
          {toolbarSlot ? createPortal(toolbar, toolbarSlot) : toolbar}
          {runtime === null ? (
            <div className={styles.marketState}>
              {selectedId === null ? null : <IconLoadingOutline16 />}
              <div className={styles.marketStateText}>
                {t(selectedId === null ? 'pluginMarketNoSource' : 'pluginMarketStatusLoading')}
              </div>
            </div>
          ) : (
            <>
              {untrusted ? (
                <div className={styles.trustError} role="alert">
                  {t('pluginMarketTrustUntrustedHint', { reason: t(trustReasonKey(runtime)) })}
                </div>
              ) : null}
              {runtime.trust === 'endorsed' ? (
                <div className={styles.trustWarn}>
                  {t(
                    runtime.chainVerified
                      ? 'pluginMarketTrustEndorsedChainHint'
                      : 'pluginMarketTrustEndorsedHint'
                  )}
                </div>
              ) : null}
              {notices.map((line) => (
                <div key={line} className={styles.marketNotice}>
                  {line}
                </div>
              ))}
              {runtime.state === 'failed' && plugins.length === 0 ? (
                <div className={styles.marketState}>
                  <div className={styles.marketStateText}>
                    {runtime.error === null ? t('pluginMarketStatusFailed') : t(runtime.error)}
                  </div>
                  <Button variant="outlined" size="s" onClick={refreshSelected}>
                    {t('pluginMarketRetry')}
                  </Button>
                </div>
              ) : runtime.state === 'loading' && plugins.length === 0 ? (
                <div className={styles.marketState}>
                  <IconLoadingOutline16 />
                  <div className={styles.marketStateText}>{t('pluginMarketStatusLoading')}</div>
                </div>
              ) : plugins.length === 0 ? (
                <div className={styles.marketState}>
                  <div className={styles.marketStateText}>{t('pluginMarketStatusEmpty')}</div>
                  <Button variant="outlined" size="s" onClick={refreshSelected}>
                    {t('pluginMarketRefresh')}
                  </Button>
                </div>
              ) : visible.length === 0 ? (
                <div className={styles.marketState}>
                  <div className={styles.marketStateText}>
                    {t('pluginMarketSearchResultFiltered', { shown: 0, total: plugins.length })}
                  </div>
                  <Button variant="outlined" size="s" onClick={clearSearch}>
                    {t('pluginMarketSearchClear')}
                  </Button>
                </div>
              ) : (
                <div className={styles.catalogGrid} role="list">
                  {visible.map((plugin) => {
                    const id = plugin.manifest?.id ?? toPluginId(plugin.name)
                    const installed = id !== null && installedIds.has(id)
                    const unusable = plugin.error !== null || plugin.latest === null
                    const confirming = confirmKey === plugin.key
                    const failure = failures[plugin.key] ?? ''
                    const description =
                      plugin.meta === null ? '' : pickText(plugin.meta.description, locale)
                    /** 动作行左侧的错误结论：安装被拒优先，其次目录里记录的拉取错误 */
                    const error =
                      failure !== '' ? failure : plugin.error === null ? '' : t(plugin.error)
                    /** 中性说明：缺版本信息装不了，或该插件所在目录未校验 */
                    const notice =
                      plugin.error !== null
                        ? ''
                        : plugin.latest === null
                          ? t('pluginMarketInstallUnavailable', { id: plugin.name })
                          : runtime.catalogVerified && !plugin.catalogVerified
                            ? t('pluginMarketCatalogUnverified')
                            : ''
                    return (
                      <div
                        key={plugin.key}
                        role="listitem"
                        className={styles.catalogCard}
                        aria-busy={busyKey === plugin.key}
                      >
                        <div className={styles.cardHead}>
                          <span className={styles.cardName}>{plugin.name}</span>
                          {plugin.latest === null ? null : (
                            <span className={styles.cardVersion}>{plugin.latest}</span>
                          )}
                        </div>
                        <div className={styles.cardMeta}>
                          <span>{plugin.author}</span>
                          {runtime.trust === 'endorsed' ? (
                            <span className={styles.endorsedBadge}>{t('pluginEndorsedBadge')}</span>
                          ) : null}
                        </div>
                        {plugin.tags.length === 0 ? null : (
                          <div className={styles.cardTags}>
                            {plugin.tags.slice(0, MAX_TAG_PILLS).map((tag) => (
                              <span key={tag} className={styles.tagPill}>
                                {tag}
                              </span>
                            ))}
                            {plugin.tags.length > MAX_TAG_PILLS ? (
                              <span className={styles.tagMore}>
                                +{plugin.tags.length - MAX_TAG_PILLS}
                              </span>
                            ) : null}
                          </div>
                        )}
                        {description === '' ? null : (
                          <div className={styles.cardDesc}>{description}</div>
                        )}
                        <div className={styles.cardActions}>
                          {/*
                           * 动作行左侧常驻一格说明：安装被拒的结论优先，其次是目录里的
                           * 拉取错误，最后是中性说明。空着也占位，按钮才始终贴右端。
                           */}
                          <div className={error === '' ? styles.cardNotice : styles.cardError}>
                            {error === '' ? notice : error}
                          </div>
                          <Button
                            variant={confirming ? 'danger' : 'outlined'}
                            size="s"
                            disabled={installed || unusable || busyKey !== null}
                            onClick={() => {
                              if (needsConfirm && !confirming) {
                                armConfirm(plugin.key)
                                return
                              }
                              void install(plugin)
                            }}
                          >
                            {installed
                              ? `✓ ${t('pluginActionInstalled')}`
                              : busyKey === plugin.key
                                ? t('pluginInstalling')
                                : confirming
                                  ? t('pluginMarketInstallConfirm')
                                  : t('pluginActionInstall')}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
