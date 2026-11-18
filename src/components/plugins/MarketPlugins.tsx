import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
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
import { showToast } from '../base/toastState.js'
import { formatDateTime } from '../../utils/format.js'
import styles from './PluginPanel.module.css'

/** 二次确认的保持时间（毫秒） */
const CONFIRM_MS = 3000

/** 客户端缺失时的占位订阅源，保证 Hook 顺序稳定 */
const EMPTY_STORE = {
  subscribe: () => () => undefined,
  version: () => 0,
}

const trustKey = (runtime: SourceRuntime | null): TranslationKey => {
  if (runtime?.trust === 'trusted') {
    return 'pluginMarketTrustTrusted'
  }
  if (runtime?.trust === 'untrusted') {
    return 'pluginMarketTrustUntrusted'
  }
  return 'pluginMarketTrustUnverified'
}

const trustReasonKey = (runtime: SourceRuntime | null): TranslationKey =>
  runtime?.trustFailure === 'signature'
    ? 'pluginMarketTrustReasonSignature'
    : 'pluginMarketTrustReasonMissing'

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
      const result = await engine.installFromUrl(plan.url, plan.manifest, {
        sourceType: plan.sourceType,
        pub: plan.pub,
        sign: plan.sign,
      })
      if (result.ok) {
        instance.countInstall(selectedId, plugin)
        showToast({ key: 'pluginInstalled', params: { id: plugin.name } })
      } else {
        showToast({
          type: 'error',
          key: 'pluginInstallRejected',
          params: { id: plugin.name, reason: pluginReasonText(result.reason) },
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

  const blocked = runtime?.trust === 'untrusted'
  const needsConfirm = runtime?.trust === 'unverified'

  return (
    <>
      <div className={styles.marketSources}>
        <div className={styles.marketBar}>
          <span className={styles.statusText}>{t('pluginMarketSources')}</span>
          <Button variant="outlined" size="s" disabled={editing !== null} onClick={startAdd}>
            {t('pluginMarketSourceAdd')}
          </Button>
        </div>
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
                    {state?.baseUrl ?? t('pluginMarketSourceNoUrl')}
                  </span>
                </button>
                <div className={styles.sourceBadges}>
                  <span
                    className={clsx(
                      styles.badge,
                      state?.trust === 'trusted'
                        ? styles.badgeTrusted
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
              </div>
            </div>
            {runtime.trust === 'untrusted' ? (
              <div className={styles.trustError} role="alert">
                {t('pluginMarketTrustUntrustedHint', { reason: t(trustReasonKey(runtime)) })}
              </div>
            ) : null}
            {runtime.trust === 'unverified' ? (
              <div className={styles.trustWarn}>{t('pluginMarketTrustUnverifiedHint')}</div>
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
                  const unusable = plugin.error !== null || plugin.latest === null || plugin.sign === null
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
                      </div>
                      <div className={styles.tagsCell} role="cell">
                        {plugin.tags.length > 0 ? plugin.tags.join(' / ') : '-'}
                      </div>
                      <div className={styles.versionCell} role="cell">
                        {plugin.latest ?? '-'}
                      </div>
                      <div className={styles.description} role="cell">
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
                          disabled={installed || blocked || unusable || busyKey !== null}
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
                        {blocked ? (
                          <span className={styles.errorText}>{t('pluginMarketInstallBlocked')}</span>
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
