import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
import { getPluginEngine, type PluginEngine } from '../dsc-plugin-engine/index.js'
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

/** 正在进行的操作；用于按钮的忙碌文案与禁用 */
type Busy = { id: string; action: 'toggle' | 'uninstall' }

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
  const running = busy !== null

  /**
   * 置忙执行一次操作，完成后刷新列表。
   * 引擎自己会用 toast 说明启用、停用与卸载被拒的原因；引擎未就绪时返回 null，由调用方决定是否补充提示。
   */
  const run = async (
    id: string,
    action: Busy['action'],
    task: (engine: PluginEngine) => Promise<boolean>
  ): Promise<boolean | null> => {
    const engine = getPluginEngine()
    if (!engine) {
      showToast({ type: 'error', key: 'pluginEngineUnavailable' })
      return null
    }
    setBusy({ id, action })
    let ok = false
    try {
      ok = await task(engine)
    } catch {
      ok = false
    } finally {
      setBusy(null)
      refresh()
    }
    return ok
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
    const ok = await run(plugin.id, 'uninstall', (engine) => engine.unload(plugin.id))
    // 引擎未就绪时已经提示过
    if (ok === null) {
      return
    }
    if (ok) {
      setConfirming(null)
      return
    }
    // 被依赖时引擎的 toast 已说明原因，再补一条会覆盖它
    if (dependentsOf(plugin).length > 0) {
      return
    }
    showToast({ type: 'error', key: 'pluginUninstallFailed', params: { id: plugin.id } })
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
          return (
            <div key={plugin.id} className={styles.row} role="row" aria-busy={busy?.id === plugin.id}>
              <div className={styles.nameCell} role="cell">
                <span className={styles.name}>{plugin.name}</span>
                <span className={styles.caption}>{plugin.id}</span>
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
                className={styles.versionCell}
                role="cell"
                data-label={t('pluginColumnVersion')}
              >
                {plugin.version}
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
          {t('pluginUninstallDescription', { name: confirming.name })}
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
