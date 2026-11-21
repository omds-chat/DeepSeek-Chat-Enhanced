import clsx from 'clsx'
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
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
import { IconRefreshOutline16 } from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import { showToast } from '../base/toastState.js'
import { formatDateTime } from '../../utils/format.js'
import styles from './PluginPanel.module.css'

/** 二次确认的保持时间（毫秒） */
const CONFIRM_MS = 3000

/** 来源面板的展开状态：只在本会话内记住，默认收起 */
const SOURCES_OPEN_KEY = 'dsc-plugins:sources-open'

const readSourcesOpen = (): boolean => {
  try {
    return window.sessionStorage.getItem(SOURCES_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

const writeSourcesOpen = (open: boolean): void => {
  try {
    window.sessionStorage.setItem(SOURCES_OPEN_KEY, open ? '1' : '0')
  } catch {
    /* 会话存储不可用时只在组件内记住 */
  }
}

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

const statusKey = (runtime: SourceRuntime | null): TranslationKey => {
  if (!runtime || runtime.state === 'idle' || runtime.state === 'loading') {
    return 'pluginMarketStatusLoading'
  }
  if (runtime.state === 'failed') {
    return 'pluginMarketStatusFailed'
  }
  return runtime.plugins.length === 0 ? 'pluginMarketStatusEmpty' : 'pluginMarketStatusReady'
}

/** 按当前语言取双语简介；缺失的一侧用另一侧补 */
const pickText = (text: LocalizedText, locale: 'zh-CN' | 'en-US'): string =>
  text[locale] !== '' ? text[locale] : locale === 'zh-CN' ? text['en-US'] : text['zh-CN']

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
}: {
  installedIds: Set<string>
  onInstalled: () => void
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const client = market()
  const store = client ?? EMPTY_STORE
  useSyncExternalStore(store.subscribe, store.version, store.version)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; name: string; urls: string } | null>(null)
  const [formError, setFormError] = useState<TranslationKey | null>(null)
  const confirmTimer = useRef(0)

  const sources = client ? client.sources() : []
  const selectedId = client ? client.selected() : null
  const runtime = client && selectedId !== null ? client.runtime(selectedId) : null
  /** 来源面板默认收起，只留一行摘要 */
  const [sourcesOpen, setSourcesOpen] = useState(readSourcesOpen)
  const sourcesListId = `${useId()}-sources`

  const selectedSource = sources.find((source) => source.id === selectedId) ?? null
  const summaryText =
    selectedSource === null
      ? t('pluginMarketNoSource')
      : t('pluginMarketSourcesSummary', {
          name: selectedSource.name,
          trust: t(trustKey(runtime)),
        })

  const toggleSources = () => {
    const next = !sourcesOpen
    setSourcesOpen(next)
    writeSourcesOpen(next)
  }

  useEffect(() => () => window.clearTimeout(confirmTimer.current), [])

  useEffect(() => {
    const instance = market()
    const id = instance?.selected() ?? null
    if (instance && id !== null) {
      void instance.refresh(id)
    }
  }, [])

  const refreshSource = useCallback(async (id: string, force: boolean) => {
    await market()?.refresh(id, force)
  }, [])

  const armConfirm = (key: string) => {
    setConfirmKey(key)
    window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setConfirmKey(null), CONFIRM_MS)
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
    const plan = instance.plan(selectedId, plugin)
    if (!plan) {
      showToast({
        type: 'error',
        key: 'pluginMarketInstallUnavailable',
        params: { id: plugin.name },
      })
      return
    }
    const engine = getPluginEngine()
    if (!engine) {
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
        showToast({
          type: 'error',
          key: 'pluginInstallRejected',
          params: { id: plugin.name, reason: pluginReasonText(result.reason, result.detail) },
        })
      }
      onInstalled()
    } catch {
      showToast({
        type: 'error',
        key: 'pluginInstallRejected',
        params: { id: plugin.name, reason: pluginReasonText('load-failed') },
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

  return (
    <>
      <div className={clsx(styles.marketSources, !sourcesOpen && styles.marketSourcesCollapsed)}>
        <div className={styles.sourcesSummary}>
          <span className={styles.summaryText}>{summaryText}</span>
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
            onClick={toggleSources}
          >
            {sourcesOpen ? t('pluginMarketSourcesCollapse') : t('pluginMarketSourcesExpand')}
          </Button>
        </div>
        <div className={styles.sourceList} id={sourcesListId}>
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
                    {state?.baseUrl ?? t('pluginMarketSourceNoUrl')}
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
                    <span className={styles.badgeCount}>{t('pluginMarketCountBadge')}</span>
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
          <Button variant="outlined" size="s" disabled={editing !== null} onClick={startAdd}>
            {t('pluginMarketSourceAdd')}
          </Button>
        </div>
      </div>
      <div className={styles.marketCatalog}>
        {!client ? (
          <div className={styles.empty}>{t('pluginMarketUnavailable')}</div>
        ) : runtime === null ? (
          <div className={styles.empty}>
            {t(selectedId === null ? 'pluginMarketNoSource' : 'pluginMarketStatusLoading')}
          </div>
        ) : (
          <>
            <div className={styles.marketBar}>
              <div className={styles.marketStatus}>
                <span className={styles.statusText} aria-busy={runtime.state === 'loading'}>
                  {t(statusKey(runtime), { count: runtime.plugins.length })}
                </span>
                {runtime.fetchedAt !== null ? (
                  <span className={styles.caption}>
                    {t('pluginMarketIndexUpdatedAt', {
                      time: formatDateTime(runtime.fetchedAt) ?? '',
                    })}
                  </span>
                ) : null}
                {runtime.error !== null ? (
                  <span className={styles.caption}>{t(runtime.error)}</span>
                ) : null}
                {runtime.state === 'ready' ? (
                  <span className={styles.caption}>
                    {t(
                      runtime.catalogVerified
                        ? 'pluginMarketCatalogVerified'
                        : 'pluginMarketCatalogUnverified'
                    )}
                  </span>
                ) : null}
                {runtime.revisionWarnings.map((warning) => (
                  <span key={warning.layer + '|' + warning.path} className={styles.caption}>
                    {t('pluginMarketRevisionRegressed', {
                      layer: warning.layer,
                      path: warning.path === '' ? '/' : warning.path,
                      seen: warning.seen,
                      revision: warning.revision,
                    })}
                  </span>
                ))}
              </div>
            </div>
            {runtime.trust === 'untrusted' ? (
              <div className={styles.trustError} role="alert">
                {t('pluginMarketTrustUntrustedHint', { reason: t(trustReasonKey(runtime)) })}
              </div>
            ) : null}
            {isUnlistedTrust(runtime.trust) ? (
              <div className={styles.caption}>{t('pluginMarketNotListed')}</div>
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
            {runtime.meta?.downloadCountEnabled ? (
              <div className={styles.caption}>{t('pluginMarketCountNotice')}</div>
            ) : null}
            {runtime.meta?.downloadCountEnabled && runtime.meta.apiNeedIp ? (
              <div className={styles.caption}>{t('pluginMarketCountIpNotice')}</div>
            ) : null}
            {runtime.plugins.length === 0 ? (
              <div className={styles.empty}>
                {runtime.state === 'failed'
                  ? t('pluginMarketStatusFailed')
                  : t('pluginMarketEmpty')}
              </div>
            ) : (
              <div className={styles.table} role="table">
                <div className={clsx(styles.row, styles.catalogRow, styles.head)} role="row">
                  <div role="columnheader">{t('pluginColumnName')}</div>
                  <div role="columnheader">{t('pluginMarketColumnTags')}</div>
                  <div role="columnheader">{t('pluginColumnVersion')}</div>
                  <div role="columnheader">{t('pluginMarketColumnIntro')}</div>
                  <div role="columnheader">{t('pluginColumnActions')}</div>
                </div>
                {runtime.plugins.map((plugin) => {
                  const id = plugin.manifest?.id ?? toPluginId(plugin.name)
                  const installed = id !== null && installedIds.has(id)
                  const unusable = plugin.error !== null || plugin.latest === null
                  const confirming = confirmKey === plugin.key
                  return (
                    <div
                      key={plugin.key}
                      className={clsx(styles.row, styles.catalogRow)}
                      role="row"
                      aria-busy={busyKey === plugin.key}
                    >
                      <div className={styles.nameCell} role="cell">
                        <span className={styles.name}>{plugin.name}</span>
                        <span className={styles.caption}>{plugin.author}</span>
                        {runtime.trust === 'endorsed' ? (
                          <span className={styles.endorsedBadge}>{t('pluginEndorsedBadge')}</span>
                        ) : null}
                        {runtime.catalogVerified && !plugin.catalogVerified && !unusable ? (
                          <span className={styles.caption}>
                            {t('pluginMarketCatalogUnverified')}
                          </span>
                        ) : null}
                      </div>
                      <div
                        className={styles.tagsCell}
                        role="cell"
                        data-label={t('pluginMarketColumnTags')}
                      >
                        {plugin.tags.length > 0 ? plugin.tags.join(' / ') : '-'}
                      </div>
                      <div
                        className={styles.versionCell}
                        role="cell"
                        data-label={t('pluginColumnVersion')}
                      >
                        {plugin.latest ?? '-'}
                      </div>
                      <div
                        className={styles.description}
                        role="cell"
                        data-label={t('pluginMarketColumnIntro')}
                      >
                        {plugin.error !== null
                          ? t(plugin.error)
                          : plugin.meta
                            ? pickText(plugin.meta.description, locale)
                            : ''}
                      </div>
                      <div className={styles.actions} role="cell">
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
                            ? t('pluginActionInstalled')
                            : busyKey === plugin.key
                              ? t('pluginInstalling')
                              : confirming
                                ? t('pluginMarketInstallConfirm')
                                : t('pluginActionInstall')}
                        </Button>
                        {untrusted ? (
                          <span className={styles.errorText}>{t('pluginMarketInstallUntrusted')}</span>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
