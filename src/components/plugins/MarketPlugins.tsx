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
  isBrowsableSource,
  market,
  toPluginId,
  type CatalogPlugin,
  type LocalizedText,
  type MarketSource,
  type SourceRuntime,
} from '../dsc-market/index.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Select, type SelectOption } from '../base/Select.js'
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

/** 目录项与它所属的来源：来源筛选、结论行与安装都按卡片自己的来源走 */
type MarketEntry = {
  sourceId: string
  /** 来源显示名，聚合视图下用来标注卡片归属 */
  sourceName: string
  runtime: SourceRuntime
  plugin: CatalogPlugin
}

/** 安装状态筛选 */
type StatusFilter = 'all' | 'installed' | 'uninstalled'

/** 排序口径；default 表示不排序，目录原序即来源给出的排名 */
type SortMode = 'default' | 'name' | 'author'

/** 卡片的界面键：跨来源可能有同名插件，键里带来源 id */
const cardId = (sourceId: string, plugin: CatalogPlugin): string => sourceId + '/' + plugin.key

/** 排序比较：按当前语言的字典序，数字按数值比、大小写不敏感 */
const collate = (left: string, right: string, locale: 'zh-CN' | 'en-US'): number =>
  left.localeCompare(right, locale, { numeric: true, sensitivity: 'base' })

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

/** 来源徽章的配色；结论只有四种，配色跟着走 */
const trustBadgeClass = (runtime: SourceRuntime | null): string => {
  if (runtime?.trust === 'trusted') {
    return styles.badgeTrusted
  }
  if (runtime?.trust === 'endorsed') {
    return styles.badgeEndorsed
  }
  return runtime?.trust === 'untrusted' ? styles.badgeUntrusted : styles.badgeUnverified
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
  /*
   * 可浏览来源：内部插件来源只在来源浮层里登记，它的条目走已安装页的「内部插件」组，
   * 因此目录浏览、来源筛选与来源计数都只认 awesome 与 user 两类。
   */
  const browsableSources = sources.filter((source) => isBrowsableSource(source))
  const selectedId = client ? client.selected() : null
  const runtime = client && selectedId !== null ? client.runtime(selectedId) : null
  const fetchedAt = runtime === null ? null : runtime.fetchedAt

  /** 已配置来源的运行态，按来源顺序；来源筛选与结论行都在它之上取子集 */
  const allRuntimes: SourceRuntime[] = []
  for (const source of browsableSources) {
    const state = client?.runtime(source.id) ?? null
    if (state !== null) {
      allRuntimes.push(state)
    }
  }

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

  /*
   * 筛选与排序只在本次面板打开期间有效，不做持久化；
   * 来源筛选用空串表示「全部」，来源 id 非空，两者不会撞。
   */
  const [sourceFilter, setSourceFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('default')

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

  /*
   * 最大高按视口减顶边偏移算，顶边随窗口宽度与吸顶高度变化，
   * 所以打开时与改宽时各实测一次，写进 --ds-popover-top 供样式表取值。
   */
  useEffect(() => {
    if (!sourcesOpen) {
      return
    }
    const node = popoverRef.current
    if (node === null) {
      return
    }
    const sync = () => {
      const top = Math.round(node.getBoundingClientRect().top)
      node.style.setProperty('--ds-popover-top', Math.max(0, top) + 'px')
    }
    sync()
    window.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('resize', sync)
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

  /*
   * 安装：计划与信任都取卡片自己的来源，聚合视图下同一插件只可能属于一个来源。
   * 失败结论钉在卡片上，键里带来源 id，跨来源同名插件不会串行。
   */
  const install = async (entry: MarketEntry) => {
    const { plugin, runtime: source, sourceId } = entry
    const instance = market()
    if (!instance) {
      return
    }
    const key = cardId(sourceId, plugin)
    setFailure(key, '')
    const plan = instance.plan(sourceId, plugin)
    if (!plan) {
      const text = t('pluginMarketInstallUnavailable', { id: plugin.name })
      setFailure(key, text)
      showToast({ type: 'error', key: 'pluginMarketInstallUnavailable', params: { id: plugin.name } })
      return
    }
    const engine = getPluginEngine()
    if (!engine) {
      setFailure(key, t('pluginEngineUnavailable'))
      showToast({ type: 'error', key: 'pluginEngineUnavailable' })
      return
    }
    setBusyKey(key)
    try {
      // 来源信任判定一并交给引擎，只用于界面展示是否被官方认可
      const trustFailure = source.trustFailure
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
        trust: source.trust,
        ...(trustFailure === null ? {} : { trustFailure }),
      })
      if (result.ok) {
        instance.countInstall(sourceId, plugin)
        // 自动启用被拒时引擎已经提示原因，这里不再用安装完成盖掉它
        if (result.activation?.ok !== false) {
          showToast({ key: 'pluginInstalled', params: { id: plugin.name } })
        }
      } else {
        // 失败结论同时钉在卡片上，toast 只做即时提醒
        const reason = pluginReasonText(result.reason, result.detail)
        setFailure(key, reason)
        showToast({
          type: 'error',
          key: 'pluginInstallRejected',
          params: { id: plugin.name, reason },
        })
      }
      onInstalled()
    } catch {
      const reason = pluginReasonText('load-failed')
      setFailure(key, reason)
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

  /** 已安装判定：目录清单里的 id 优先，缺失时按名称归一 */
  const isInstalled = (plugin: CatalogPlugin): boolean => {
    const id = plugin.manifest?.id ?? toPluginId(plugin.name)
    return id !== null && installedIds.has(id)
  }

  const needle = term.trim().toLowerCase()
  const searching = needle !== ''
  const statusOn = statusFilter !== 'all'
  const filtersOn = sourceFilter !== '' || statusOn

  /* 来源筛选先改基数：空串是全部可浏览来源，即它们的并集，单来源时与目录原序一致 */
  const scopedSources =
    sourceFilter === ''
      ? browsableSources
      : browsableSources.filter((source) => source.id === sourceFilter)
  const scopedRuntimes: SourceRuntime[] = []
  const entries: MarketEntry[] = []
  for (const source of scopedSources) {
    const state = client?.runtime(source.id) ?? null
    if (state === null) {
      continue
    }
    scopedRuntimes.push(state)
    for (const plugin of state.plugins) {
      entries.push({ sourceId: source.id, sourceName: source.name, runtime: state, plugin })
    }
  }
  /** 所有来源的插件总数：三态判据只看有没有数据，与筛选无关 */
  const allPlugins = allRuntimes.reduce((count, state) => count + state.plugins.length, 0)
  /** 基数：来源筛选后的全部插件，搜索与安装状态都在它之上再取交集 */
  const total = entries.length
  const matched = entries.filter(({ plugin }) => {
    if (searching && !matchesQuery(plugin, needle)) {
      return false
    }
    return statusFilter === 'all' || isInstalled(plugin) === (statusFilter === 'installed')
  })
  /* 默认口径不排序：目录原序就是来源给出的排名，只有显式选了才排 */
  const visible =
    sortMode === 'default'
      ? matched
      : matched.sort((left, right) =>
          sortMode === 'name'
            ? collate(left.plugin.name, right.plugin.name, locale) ||
              collate(left.plugin.author, right.plugin.author, locale)
            : collate(left.plugin.author, right.plugin.author, locale) ||
              collate(left.plugin.name, right.plugin.name, locale)
        )

  /*
   * 结论行：清单结论一行、下载计数说明一行，最多两行。
   * 刷新失败但仍有上次目录时，失败原因独占第一行，过期结论不再重复播报。
   * 聚合视图下按来源各出一条再去重，同类结论不重复铺行。
   */
  const noticeLines = (state: SourceRuntime): string[] => {
    if (state.state === 'failed' && state.plugins.length > 0) {
      return [state.error === null ? t('pluginMarketStatusFailed') : t(state.error)]
    }
    const lines: string[] = []
    const manifestNotes: string[] = []
    if (state.state === 'ready' && !state.catalogVerified) {
      manifestNotes.push(t('pluginMarketCatalogUnverified'))
    }
    for (const warning of state.revisionWarnings) {
      manifestNotes.push(
        t('pluginMarketRevisionRegressed', {
          layer: warning.layer,
          path: warning.path === '' ? '/' : warning.path,
          seen: warning.seen,
          revision: warning.revision,
        })
      )
    }
    if (isUnlistedTrust(state.trust)) {
      manifestNotes.push(t('pluginMarketNotListed'))
    }
    if (manifestNotes.length > 0) {
      lines.push(manifestNotes.join(' · '))
    }
    const countNotes: string[] = []
    if (state.meta?.downloadCountEnabled === true) {
      countNotes.push(t('pluginMarketCountNotice'))
      if (state.meta.apiNeedIp) {
        countNotes.push(t('pluginMarketCountIpNotice'))
      }
    }
    if (countNotes.length > 0) {
      lines.push(countNotes.join(' · '))
    }
    return lines
  }
  const notices = [...new Set(scopedRuntimes.flatMap(noticeLines))].slice(0, 2)

  const refreshSelected = () => {
    if (selectedId !== null) {
      void refreshSource(selectedId, true)
    }
  }

  /** 清除筛选：搜索是另一条通道，不在这里一并清掉 */
  const clearFilters = () => {
    setSourceFilter('')
    setStatusFilter('all')
  }

  /*
   * 下拉选项：只列可浏览来源（组织社区与用户自加），内部插件来源的条目在已安装页；
   * 来源增删后选项跟着变，筛选停在已消失的来源上时按「没有命中」处理。
   * 只剩一条来源时照常渲染这一个选项，不退化、不隐藏控件。
   */
  const sourceOptions: SelectOption<string>[] = [
    { value: '', label: t('pluginMarketFilterSourceAll') },
    ...browsableSources.map((source) => ({ value: source.id, label: source.name })),
  ]
  const statusOptions: SelectOption<StatusFilter>[] = [
    { value: 'all', label: t('pluginMarketFilterStatusAll') },
    { value: 'installed', label: t('pluginMarketFilterStatusInstalled') },
    { value: 'uninstalled', label: t('pluginMarketFilterStatusUninstalled') },
  ]
  const sortOptions: SelectOption<SortMode>[] = [
    { value: 'default', label: t('pluginMarketSortDefault') },
    { value: 'name', label: t('pluginMarketSortName') },
    { value: 'author', label: t('pluginMarketSortAuthor') },
  ]

  /*
   * 工具条由 PluginPanel 的吸顶块承载：portal 把它挂进 .stickyBar 里的挂载点，
   * 因此随页头与页签条一起吸顶，而不是跟着目录滚走。浮层的绝对定位仍相对这条工具条。
   */
  const toolbar = (
    <div className={styles.marketToolbar}>
      <div className={styles.marketSearch}>
        {/* 搜索图标是输入框的前置图标：绝对定位在框内左侧，输入框让出左内距 */}
        <span className={styles.marketSearchIcon} aria-hidden="true">
          <IconSearchOutline16 />
        </span>
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
          {searching || statusOn
            ? t('pluginMarketSearchResultFiltered', { shown: visible.length, total })
            : t('pluginMarketSearchResult', { count: total })}
        </span>
        {/* 窄屏不渲染更新时间与来源数，工具条才收得回两行；数据本身不裁剪 */}
        <span className={styles.marketToolbarExtra}>
          {fetchedAt === null ? null : (
            <span className={styles.caption}>
              {t('pluginMarketIndexUpdatedAt', { time: formatDateTime(fetchedAt) ?? '' })}
            </span>
          )}
          {browsableSources.length > 1 ? (
            <Tooltip content={t('pluginMarketSourcesCount', { count: browsableSources.length })}>
              <span
                className={styles.badgeCount}
                aria-label={t('pluginMarketSourcesCount', { count: browsableSources.length })}
              >
                {browsableSources.length}
              </span>
            </Tooltip>
          ) : null}
        </span>
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
      {/* 筛选排在元信息簇之后：折行时先保住搜索与计数，筛选整体落到第二行 */}
      <div className={styles.marketFilters}>
        <Select
          value={sourceFilter}
          options={sourceOptions}
          ariaLabel={t('pluginMarketFilterSourceLabel')}
          className={styles.marketSelect}
          onChange={setSourceFilter}
        />
        <Select
          value={statusFilter}
          options={statusOptions}
          ariaLabel={t('pluginMarketFilterStatusLabel')}
          className={styles.marketSelect}
          onChange={setStatusFilter}
        />
        <Select
          value={sortMode}
          options={sortOptions}
          ariaLabel={t('pluginMarketSortLabel')}
          className={styles.marketSelect}
          onChange={setSortMode}
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
                /*
                 * 内置来源是市场默认项：不给编辑、删除与调序入口，也不给切换态；
                 * 只有用户自加来源可写，用户来源之间可调序，但越不过内置段。
                 */
                const selectable = isBrowsableSource(source)
                const writable = source.kind === 'user'
                const previous = index > 0 ? sources[index - 1] : null
                const canMoveUp = writable && previous !== null && previous.kind === 'user'
                const canMoveDown = writable && index < sources.length - 1
                const texts = (
                  <span className={styles.sourceTexts}>
                    <span className={styles.sourceName}>{source.name}</span>
                    <span className={styles.sourceUrl}>
                      {state === null
                        ? t('pluginMarketSourceIdle')
                        : (state.baseUrl ?? t('pluginMarketSourceNoUrl'))}
                    </span>
                  </span>
                )
                return (
                  <div
                    key={source.id}
                    className={clsx(styles.sourceRow, active && styles.sourceRowActive)}
                  >
                    <div className={styles.sourceHead}>
                      {selectable ? (
                        <button
                          type="button"
                          className={styles.sourcePick}
                          aria-pressed={active}
                          onClick={() => selectSource(source.id)}
                        >
                          <span className={styles.sourceDot} aria-hidden="true" />
                          {texts}
                        </button>
                      ) : (
                        <div className={styles.sourceFixed}>{texts}</div>
                      )}
                      <span className={styles.sourceBadges}>
                        <span className={clsx(styles.badge, trustBadgeClass(state))}>
                          {t(trustKey(state))}
                        </span>
                        {state?.meta?.downloadCountEnabled ? (
                          <span className={styles.badgeCount}>
                            {t('pluginMarketCountBadge')}
                          </span>
                        ) : null}
                      </span>
                    </div>
                    {writable ? (
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
                          disabled={!canMoveUp || editing !== null}
                          onClick={() => moveSource(source.id, -1)}
                        >
                          {t('pluginMarketSourceMoveUp')}
                        </Button>
                        <Button
                          variant="outlined"
                          size="s"
                          disabled={!canMoveDown || editing !== null}
                          onClick={() => moveSource(source.id, 1)}
                        >
                          {t('pluginMarketSourceMoveDown')}
                        </Button>
                        <Button
                          variant="dangerOutlined"
                          size="s"
                          disabled={editing !== null}
                          onClick={() => requestDelete(source.id)}
                        >
                          {confirmKey === 'delete:' + source.id
                            ? t('pluginMarketSourceDeleteConfirm')
                            : t('pluginMarketSourceDelete')}
                        </Button>
                      </div>
                    ) : (
                      <div className={styles.sourceFoot}>
                        <span className={styles.sourceNote}>
                          {t('pluginMarketSourceBuiltinNote')}
                        </span>
                        <IconButton
                          icon={<IconRefreshOutline16 />}
                          tooltip={t('pluginMarketRefresh')}
                          disabled={state?.state === 'loading'}
                          onClick={() => void refreshSource(source.id, true)}
                        />
                      </div>
                    )}
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
              {runtime.state === 'failed' && allPlugins === 0 ? (
                <div className={styles.marketState}>
                  <div className={styles.marketStateText}>
                    {runtime.error === null ? t('pluginMarketStatusFailed') : t(runtime.error)}
                  </div>
                  <Button variant="outlined" size="s" onClick={refreshSelected}>
                    {t('pluginMarketRetry')}
                  </Button>
                </div>
              ) : runtime.state === 'loading' && allPlugins === 0 ? (
                <div className={styles.marketState}>
                  <IconLoadingOutline16 />
                  <div className={styles.marketStateText}>{t('pluginMarketStatusLoading')}</div>
                </div>
              ) : allPlugins === 0 ? (
                <div className={styles.marketState}>
                  <div className={styles.marketStateText}>{t('pluginMarketStatusEmpty')}</div>
                  <Button variant="outlined" size="s" onClick={refreshSelected}>
                    {t('pluginMarketRefresh')}
                  </Button>
                </div>
              ) : visible.length === 0 ? (
                /* 筛选无结果与搜索无结果是两回事：筛选优先给「清除筛选」，搜索给「清除搜索」 */
                <div className={styles.marketState}>
                  <div className={styles.marketStateText}>
                    {t(filtersOn ? 'pluginMarketFilterEmpty' : 'pluginMarketSearchResultFiltered', {
                      shown: 0,
                      total,
                    })}
                  </div>
                  <Button
                    variant="outlined"
                    size="s"
                    onClick={filtersOn ? clearFilters : clearSearch}
                  >
                    {t(filtersOn ? 'pluginMarketFilterClear' : 'pluginMarketSearchClear')}
                  </Button>
                </div>
              ) : (
                <div className={styles.catalogGrid} role="list">
                  {visible.map((entry) => {
                    const { plugin } = entry
                    /* 卡片键带来源 id：聚合视图下同名插件分属不同来源，状态不能串 */
                    const cardKey = cardId(entry.sourceId, plugin)
                    const installed = isInstalled(plugin)
                    const unusable = plugin.error !== null || plugin.latest === null
                    const confirming = confirmKey === cardKey
                    const failure = failures[cardKey] ?? ''
                    // 未在官方清单登记只是中性说明；安装时仍按本地链校验与验签给出结论
                    const needsConfirm =
                      entry.runtime.trust === 'unverified' || entry.runtime.trust === 'untrusted'
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
                          : entry.runtime.catalogVerified && !plugin.catalogVerified
                            ? t('pluginMarketCatalogUnverified')
                            : ''
                    return (
                      <div
                        key={cardKey}
                        role="listitem"
                        className={styles.catalogCard}
                        aria-busy={busyKey === cardKey}
                      >
                        <div className={styles.cardHead}>
                          <span className={styles.cardName}>{plugin.name}</span>
                          {plugin.latest === null ? null : (
                            <span className={styles.cardVersion}>{plugin.latest}</span>
                          )}
                        </div>
                        <div className={styles.cardMeta}>
                          <span>{plugin.author}</span>
                          {/* 聚合视图下标注来源归属；单来源时口径无歧义，不重复 */}
                          {scopedSources.length > 1 ? (
                            <span className={styles.tagPill}>{entry.sourceName}</span>
                          ) : null}
                          {entry.runtime.trust === 'endorsed' ? (
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
                                armConfirm(cardKey)
                                return
                              }
                              void install(entry)
                            }}
                          >
                            {installed
                              ? `✓ ${t('pluginActionInstalled')}`
                              : busyKey === cardKey
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
