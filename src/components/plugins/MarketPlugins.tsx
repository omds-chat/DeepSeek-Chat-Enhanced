import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
import { getPluginEngine } from '../dsc-plugin-engine/index.js'
import {
  market,
  type MarketClient,
  type MarketEntry,
  type MarketStatus,
} from '../dsc-market/index.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconRefreshOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { formatDateTime } from '../../utils/format.js'
import styles from './PluginPanel.module.css'

/** 状态文案；缓存过期与拉取失败都落在 stale 上，用是否已有缓存时间区分 */
const statusLabel = (status: MarketStatus | null): TranslationKey => {
  if (!status || status.state === 'loading' || status.state === 'idle') {
    return 'pluginMarketStatusLoading'
  }
  if (status.state === 'ready') {
    return status.total === 0 ? 'pluginMarketStatusEmpty' : 'pluginMarketStatusReady'
  }
  return status.fetchedAt === null ? 'pluginMarketStatusFailed' : 'pluginMarketStatusStale'
}

/** 空态文案：区分拉取中、拉取失败与索引确实为空 */
const emptyLabel = (status: MarketStatus | null): TranslationKey => {
  if (!status || status.state === 'idle' || status.state === 'loading') {
    return 'pluginMarketStatusLoading'
  }
  if (status.state === 'stale' && status.fetchedAt === null) {
    return 'pluginMarketFailedEmpty'
  }
  return 'pluginMarketEmpty'
}

/** 插件市场：索引状态、刷新与安装 */
export const MarketPlugins = ({
  installedIds,
  onInstalled,
}: {
  installedIds: Set<string>
  onInstalled: () => void
}) => {
  const t = useTranslate()
  const [client, setClient] = useState<MarketClient | null>(() => market())
  const [status, setStatus] = useState<MarketStatus | null>(() => market()?.status() ?? null)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async (force: boolean) => {
    const instance = market()
    setClient(instance)
    if (!instance) {
      setStatus(null)
      return
    }
    setLoading(true)
    try {
      setStatus(await instance.refresh(force))
    } catch {
      // 客户端的失败已经收敛成状态，这里只保证界面不中断
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh(false)
  }, [refresh])

  const install = async (entry: MarketEntry) => {
    const engine = getPluginEngine()
    if (!engine) {
      showToast({ type: 'error', key: 'pluginEngineUnavailable' })
      return
    }
    setBusyId(entry.id)
    try {
      // 索引没有内联清单时不传第二个参数，交给产物自带的 manifest 导出
      const result = await engine.installFromUrl(entry.download, entry.manifest)
      if (result.ok) {
        showToast({ key: 'pluginInstalled', params: { id: entry.id } })
      }
      onInstalled()
    } catch {
      showToast({
        type: 'error',
        key: 'pluginInstallRejected',
        params: { id: entry.id, reason: pluginReasonText('load-failed') },
      })
    } finally {
      setBusyId(null)
    }
  }

  const unavailable = client === null
  const entries = client ? client.list() : []
  const failed = !unavailable && status !== null && status.state === 'stale'

  return (
    <>
      <div className={styles.marketBar}>
        <div className={styles.marketStatus}>
          <span className={styles.statusText} aria-busy={loading}>
            {t(unavailable ? 'pluginMarketUnavailable' : statusLabel(status), {
              count: status?.total ?? 0,
            })}
          </span>
          {status?.error ? <span className={styles.caption}>{t(status.error)}</span> : null}
          {status?.fetchedAt ? (
            <span className={styles.caption}>
              {t('pluginMarketIndexUpdatedAt', { time: formatDateTime(status.fetchedAt) ?? '' })}
            </span>
          ) : null}
        </div>
        <div className={styles.marketControls}>
          {failed ? (
            <Button
              variant="outlined"
              size="s"
              disabled={loading}
              onClick={() => void refresh(true)}
            >
              {t('retry')}
            </Button>
          ) : null}
          <IconButton
            icon={<IconRefreshOutline16 />}
            tooltip={t('pluginMarketRefresh')}
            disabled={loading}
            onClick={() => void refresh(true)}
          />
        </div>
      </div>
      {unavailable ? (
        <div className={styles.empty}>{t('pluginMarketUnavailable')}</div>
      ) : entries.length === 0 ? (
        <div className={styles.empty}>{t(emptyLabel(status))}</div>
      ) : (
        <div className={styles.table} role="table">
          <div className={clsx(styles.row, styles.marketRow, styles.head)} role="row">
            <div role="columnheader">{t('pluginColumnName')}</div>
            <div role="columnheader">{t('pluginColumnVersion')}</div>
            <div role="columnheader">{t('pluginColumnDescription')}</div>
            <div className={styles.authorCell} role="columnheader">
              {t('pluginColumnAuthor')}
            </div>
            <div role="columnheader">{t('pluginColumnActions')}</div>
          </div>
          {entries.map((entry) => {
            const installed = installedIds.has(entry.id)
            return (
              <div
                key={entry.id}
                className={clsx(styles.row, styles.marketRow)}
                role="row"
                aria-busy={busyId === entry.id}
              >
                <div className={styles.nameCell} role="cell">
                  <span className={styles.name}>{entry.name}</span>
                  <span className={styles.caption}>{entry.id}</span>
                </div>
                <div className={styles.versionCell} role="cell">
                  {entry.version}
                </div>
                <div className={styles.description} role="cell">
                  {entry.description}
                </div>
                <div className={styles.authorCell} role="cell">
                  {entry.author}
                </div>
                <div className={styles.actions} role="cell">
                  <Button
                    variant="outlined"
                    size="s"
                    disabled={installed || busyId !== null}
                    onClick={() => void install(entry)}
                  >
                    {installed
                      ? t('pluginActionInstalled')
                      : busyId === entry.id
                        ? t('pluginInstalling')
                        : t('pluginActionInstall')}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
