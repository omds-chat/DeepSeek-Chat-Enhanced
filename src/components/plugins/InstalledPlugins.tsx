import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
import { market, readRecordDataBase, type ReinstallPlan, type UpdateCheck } from '../dsc-market/index.js'
import {
  getPluginEngine,
  type InstallSource,
  type PluginEngine,
  type UnloadResult,
} from '../dsc-plugin-engine/index.js'
import type {
  PluginSourceType,
  PluginState,
  PluginStateView,
  SignatureState,
} from '../dsc-plugin-engine/types.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { formatDateTime } from '../../utils/format.js'
import styles from './PluginPanel.module.css'

const stateLabels: Record<PluginState, TranslationKey> = {
  active: 'pluginStateActive',
  inactive: 'pluginStateInactive',
  failed: 'pluginStateFailed',
  registered: 'pluginStateRegistered',
}

/** 来源类型文案；内置与宿主直接注册的插件另有文案 */
const sourceTypeLabels: Record<PluginSourceType, TranslationKey> = {
  inner: 'pluginSourceSameOrigin',
  awesome: 'pluginSourceAwesome',
  outer: 'pluginSourceOuter',
  local: 'pluginSourceLocal',
}

/** 签名状态文案；只对在线分发的插件展示 */
const signatureLabels: Record<SignatureState, TranslationKey> = {
  verified: 'pluginSignatureVerified',
  unverified: 'pluginSignatureUnverified',
  failed: 'pluginSignatureFailed',
}

const sourceLabel = (plugin: PluginStateView): TranslationKey => {
  if (!plugin.source) {
    return 'pluginSourceHost'
  }
  if (plugin.source.kind === 'builtin') {
    return 'pluginSourceBuiltin'
  }
  if (plugin.source.kind === 'local') {
    return 'pluginSourceLocal'
  }
  return sourceTypeLabels[plugin.sourceType]
}

/** 更新二次确认的保持时间（毫秒），与市场的安装确认同一节奏 */
const CONFIRM_MS = 3000

/** 正在进行的操作；用于按钮的忙碌文案与禁用 */
type Busy = { id: string; action: 'toggle' | 'uninstall' | 'update' }

/** 日志快照：读取时间用于提示日志时效 */
type LogSnapshot = { name: string; lines: readonly string[]; capturedAt: number }

/** 已安装插件列表：状态、来源、启用/停用、卸载与查看日志 */
export const InstalledPlugins = ({
  plugins,
  ready,
  refresh,
}: {
  plugins: PluginStateView[]
  ready: boolean
  refresh: () => void
}) => {
  const t = useTranslate()
  const [busy, setBusy] = useState<Busy | null>(null)
  const [confirming, setConfirming] = useState<PluginStateView | null>(null)
  const [logs, setLogs] = useState<LogSnapshot | null>(null)
  /** 版本更新检查结论；没有条目的插件不显示任何标注 */
  const [updates, setUpdates] = useState<ReadonlyMap<string, UpdateCheck>>(new Map())
  const [confirmUpdate, setConfirmUpdate] = useState<string | null>(null)
  const confirmTimer = useRef(0)
  const running = busy !== null

  /** 更新检查的目标：优先取记录里的数据基址，缺失时由来源地址推导 */
  const targets = useMemo(
    () =>
      plugins.map((plugin) => {
        const dataBase = readRecordDataBase(plugin)
        return {
          id: plugin.id,
          version: plugin.version,
          ...(dataBase === null ? {} : { dataBase }),
          ...(plugin.source?.kind === 'url' ? { sourceUrl: plugin.source.url } : {}),
        }
      }),
    [plugins]
  )

  useEffect(() => {
    const client = market()
    if (!client || targets.length === 0) {
      setUpdates(new Map())
      return
    }
    let cancelled = false
    // 请求超时与失败都在市场内静默处理，无法判断的插件不出现在结果里
    void client
      .checkUpdates(targets)
      .then((report) => {
        if (!cancelled) {
          setUpdates(report)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUpdates(new Map())
        }
      })
    return () => {
      cancelled = true
    }
  }, [targets])

  useEffect(() => () => window.clearTimeout(confirmTimer.current), [])

  /**
   * 置忙执行一次操作，完成后刷新列表。
   * 引擎自己会用 toast 说明启用、停用与卸载被拒的原因；引擎未就绪时返回 null，由调用方决定是否补充提示。
   * 操作本身抛错时同样返回 null，由调用方按失败处理。
   */
  const run = async <T,>(
    id: string,
    action: Busy['action'],
    task: (engine: PluginEngine) => Promise<T>
  ): Promise<T | null> => {
    const engine = getPluginEngine()
    if (!engine) {
      showToast({ type: 'error', key: 'pluginEngineUnavailable' })
      return null
    }
    setBusy({ id, action })
    try {
      return await task(engine)
    } catch {
      return null
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const toggle = async (plugin: PluginStateView) => {
    await run(plugin.id, 'toggle', (engine) =>
      plugin.state === 'active' ? engine.deactivate(plugin.id) : engine.activate(plugin.id)
    )
  }

  /** 已启用且声明依赖该插件的插件；卸载被拒的原因由引擎提示，这里只用来避免重复提示 */
  const dependentsOf = (plugin: PluginStateView) =>
    plugins.filter(
      (other) =>
        other.id !== plugin.id &&
        other.state === 'active' &&
        other.dependencies.includes(plugin.id)
    )

  const uninstall = async (plugin: PluginStateView) => {
    const result = await run<UnloadResult>(plugin.id, 'uninstall', async (engine) => {
      try {
        return await engine.unload(plugin.id)
      } catch {
        return { removed: false, hasLeftoverData: false }
      }
    })
    // 引擎未就绪时已经提示过
    if (result === null) {
      return
    }
    if (result.removed) {
      setConfirming(null)
      // 卸载默认保留插件本地数据，遗留数据只在有数据时提示清理入口
      if (result.hasLeftoverData) {
        showToast({ key: 'pluginUninstalledDataKept' })
      }
      return
    }
    // 被依赖时引擎的 toast 已说明原因，再补一条会覆盖它
    if (dependentsOf(plugin).length > 0) {
      return
    }
    showToast({ type: 'error', key: 'pluginUninstallFailed', params: { id: plugin.id } })
  }

  /** 更新按钮的二次确认：3 秒内再次点击才真正执行 */
  const armUpdate = (id: string) => {
    setConfirmUpdate(id)
    window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setConfirmUpdate(null), CONFIRM_MS)
  }

  /** 安装计划转成引擎需要的来源信息；eec 与 eecUrl 二选一，与其他安装入口同一口径 */
  const installSourceOf = (reinstall: ReinstallPlan): InstallSource => ({
    sourceType: reinstall.plan.sourceType,
    sigUrl: reinstall.plan.sigUrl,
    authorPubUrl: reinstall.plan.authorPubUrl,
    authorSigUrl: reinstall.plan.authorSigUrl,
    ...(reinstall.plan.eec === undefined ? {} : { eec: reinstall.plan.eec }),
    ...(reinstall.plan.eecUrl === undefined ? {} : { eecUrl: reinstall.plan.eecUrl }),
    ...(reinstall.trustFailure === 'revoked' ? { trustFailure: reinstall.trustFailure } : {}),
  })

  /**
   * 更新到最新版：引擎没有覆盖安装的入口，先卸载旧记录再按最新版走完整安装流程，
   * 验签、清单校验与落库都与市场安装一致。新版本安装失败时按记录里的版本回滚，避免插件就此消失。
   */
  const updatePlugin = async (plugin: PluginStateView, check: UpdateCheck) => {
    const client = market()
    const engine = getPluginEngine()
    if (!client) {
      showToast({ type: 'error', key: 'pluginMarketUnavailable' })
      return
    }
    if (!engine) {
      showToast({ type: 'error', key: 'pluginEngineUnavailable' })
      return
    }
    const target = targets.find((item) => item.id === plugin.id)
    const next = target ? client.reinstallPlan(target, check.latest) : null
    if (!target || !next) {
      showToast({ type: 'error', key: 'pluginUpdateUnavailable', params: { name: plugin.name } })
      return
    }
    setConfirmUpdate(null)
    setBusy({ id: plugin.id, action: 'update' })
    try {
      if (!(await engine.unload(plugin.id)).removed) {
        showToast({ type: 'error', key: 'pluginUpdateUnloadFailed', params: { name: plugin.name } })
        return
      }
      const result = await engine.installFromUrl(
        next.plan.url,
        next.plan.manifest,
        installSourceOf(next)
      )
      if (result.ok) {
        showToast({ key: 'pluginUpdated', params: { name: plugin.name, version: check.latest } })
        return
      }
      const previous = client.reinstallPlan(target, plugin.version)
      if (previous) {
        await engine.installFromUrl(
          previous.plan.url,
          previous.plan.manifest,
          installSourceOf(previous)
        )
      }
      showToast({
        type: 'error',
        key: 'pluginUpdateFailed',
        params: { name: plugin.name, reason: pluginReasonText(result.reason, result.detail) },
      })
    } catch {
      showToast({
        type: 'error',
        key: 'pluginUpdateFailed',
        params: { name: plugin.name, reason: pluginReasonText('load-failed') },
      })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const openLogs = (plugin: PluginStateView) => {
    const engine = getPluginEngine()
    let lines: readonly string[] = []
    try {
      lines = engine ? [...engine.logs(plugin.id)] : []
    } catch {
      lines = []
    }
    setLogs({ name: plugin.name, lines, capturedAt: Date.now() })
  }

  if (!ready) {
    return <div className={styles.empty}>{t('pluginEngineUnavailable')}</div>
  }
  if (plugins.length === 0) {
    return <div className={styles.empty}>{t('pluginEmptyInstalled')}</div>
  }

  return (
    <>
      <div className={styles.table} role="table">
        <div className={clsx(styles.row, styles.head)} role="row">
          <div role="columnheader">{t('pluginColumnName')}</div>
          <div role="columnheader">{t('pluginColumnVersion')}</div>
          <div role="columnheader">{t('pluginColumnState')}</div>
          <div className={styles.sourceCell} role="columnheader">
            {t('pluginColumnSource')}
          </div>
          <div role="columnheader">{t('pluginColumnActions')}</div>
        </div>
        {plugins.map((plugin) => {
          const builtin = plugin.source?.kind === 'builtin'
          const active = plugin.state === 'active'
          const toggling = busy?.id === plugin.id && busy.action === 'toggle'
          const check = updates.get(plugin.id) ?? null
          const confirmingUpdate = confirmUpdate === plugin.id
          const updating = busy?.id === plugin.id && busy.action === 'update'
          return (
            <div key={plugin.id} className={styles.row} role="row" aria-busy={busy?.id === plugin.id}>
              <div className={styles.nameCell} role="cell">
                <span className={styles.name}>{plugin.name}</span>
                <span className={styles.caption}>{plugin.id}</span>
                {plugin.sourceType === 'inner' && plugin.source?.kind === 'url' ? (
                  <span className={styles.endorsedBadge}>{t('pluginEndorsedBadge')}</span>
                ) : null}
                {plugin.source !== null && plugin.source.kind !== 'builtin' ? (
                  <span
                    className={clsx(
                      styles.signatureText,
                      plugin.signatureVerified === 'failed' && styles.signatureFailed
                    )}
                  >
                    {t(signatureLabels[plugin.signatureVerified])}
                  </span>
                ) : null}
                {plugin.error ? (
                  <span className={styles.errorText}>{pluginReasonText(plugin.error)}</span>
                ) : null}
                {builtin ? (
                  <span className={styles.caption}>{t('pluginBuiltinUninstallHint')}</span>
                ) : null}
              </div>
              <div
                className={clsx(styles.versionCell, styles.versionStack)}
                role="cell"
                data-label={t('pluginColumnVersion')}
              >
                <span>{plugin.version}</span>
                {check?.status === 'latest' ? (
                  <span className={styles.updateLatest}>{t('pluginUpdateLatest')}</span>
                ) : null}
              </div>
              <div role="cell" data-label={t('pluginColumnState')}>
                {t(stateLabels[plugin.state])}
              </div>
              <div
                className={styles.sourceCell}
                role="cell"
                data-label={t('pluginColumnSource')}
              >
                {t(sourceLabel(plugin))}
              </div>
              <div className={styles.actions} role="cell">
                {check?.status === 'outdated' ? (
                  <Button
                    variant={confirmingUpdate ? 'danger' : 'primary'}
                    size="s"
                    disabled={running}
                    title={confirmingUpdate ? t('pluginUpdateHint') : undefined}
                    onClick={() => {
                      if (!confirmingUpdate) {
                        armUpdate(plugin.id)
                        return
                      }
                      void updatePlugin(plugin, check)
                    }}
                  >
                    {updating
                      ? t('pluginOperationBusy')
                      : confirmingUpdate
                        ? t('pluginUpdateConfirm')
                        : t('pluginUpdateAvailable')}
                  </Button>
                ) : null}
                <Button
                  variant="outlined"
                  size="s"
                  disabled={running}
                  onClick={() => void toggle(plugin)}
                >
                  {toggling
                    ? t('pluginOperationBusy')
                    : t(active ? 'pluginActionDisable' : 'pluginActionEnable')}
                </Button>
                <Button
                  variant="outlined"
                  size="s"
                  disabled={running}
                  onClick={() => openLogs(plugin)}
                >
                  {t('pluginActionLogs')}
                </Button>
                <Button
                  variant="dangerOutlined"
                  size="s"
                  disabled={running || builtin}
                  title={builtin ? t('pluginBuiltinUninstallHint') : undefined}
                  onClick={() => setConfirming(plugin)}
                >
                  {t('pluginActionUninstall')}
                </Button>
              </div>
            </div>
          )
        })}
      </div>
      {confirming ? (
        <Modal
          title={t('pluginUninstallTitle')}
          onClose={() => {
            if (!running) {
              setConfirming(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={running} onClick={() => setConfirming(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={running}
                onClick={() => void uninstall(confirming)}
              >
                {busy?.action === 'uninstall' ? t('pluginOperationBusy') : t('pluginActionUninstall')}
              </Button>
            </>
          }
        >
          <div>{t('pluginUninstallDescription', { name: confirming.name })}</div>
          <div className={styles.caption}>{t('pluginUninstallKeepDataHint')}</div>
        </Modal>
      ) : null}
      {logs ? (
        <Modal
          title={t('pluginLogsTitle', { name: logs.name })}
          closable
          onClose={() => setLogs(null)}
        >
          <div className={styles.caption}>
            {t('pluginLogsCapturedAt', { time: formatDateTime(logs.capturedAt) ?? '' })}
          </div>
          {logs.lines.length === 0 ? (
            <div className={styles.empty}>{t('pluginLogsEmpty')}</div>
          ) : (
            <div className={styles.logList}>
              {logs.lines.map((line, index) => (
                <div key={index} className={styles.logLine}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </Modal>
      ) : null}
    </>
  )
}
