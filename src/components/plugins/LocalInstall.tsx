import { forwardRef, Fragment, useImperativeHandle, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
import { getPluginEngine } from '../dsc-plugin-engine/index.js'
import type { LocalPackageInspection } from '../dsc-plugin-engine/types.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './PluginPanel.module.css'

/** 预检通过的待安装信息 */
type ReadyInspection = Extract<LocalPackageInspection, { ok: true }>

/** 对话框状态：解析中、被拒、待确认 */
type DialogState =
  | { kind: 'inspecting'; fileName: string }
  | { kind: 'rejected'; fileName: string; reason: string }
  | { kind: 'ready'; fileName: string; inspection: ReadyInspection }

/** 对外句柄：入口放在别处时，由调用方代为打开文件选择框 */
export type LocalInstallHandle = { pick: () => void }

/**
 * 从本地安装：选择 .zip 或 .tgz 离线包，预检通过后在对话框内二次确认。
 * 一次只接受一个文件；解析与校验失败的原因就地显示，不弹原生对话框。
 * hideTrigger 时不渲染自带入口按钮，文件选择由调用方通过 ref 触发。
 */
export const LocalInstall = forwardRef<
  LocalInstallHandle,
  { onInstalled: () => void; hideTrigger?: boolean }
>(({ onInstalled, hideTrigger = false }, ref) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<DialogState | null>(null)
  const [installing, setInstalling] = useState(false)
  /** 提交失败原因，留在对话框内直到用户重新提交或关闭 */
  const [failure, setFailure] = useState<string | null>(null)

  useImperativeHandle(ref, () => ({ pick: () => inputRef.current?.click() }), [])

  const close = () => {
    if (installing) {
      return
    }
    setState(null)
    setFailure(null)
  }

  /** 选中文件后先预检；预检不改动任何状态，确认后才提交 */
  const inspect = async (file: File) => {
    const engine = getPluginEngine()
    if (!engine) {
      showToast({ type: 'error', key: 'pluginEngineUnavailable' })
      return
    }
    setFailure(null)
    setState({ kind: 'inspecting', fileName: file.name })
    let result: LocalPackageInspection
    try {
      result = await engine.inspectLocalPackage(file)
    } catch {
      result = { ok: false, reason: 'corrupt-package' }
    }
    if (!result.ok) {
      setState({
        kind: 'rejected',
        fileName: file.name,
        reason: pluginReasonText(result.reason, result.detail),
      })
      return
    }
    setState({ kind: 'ready', fileName: file.name, inspection: result })
  }

  const confirm = async () => {
    if (state === null || state.kind !== 'ready') {
      return
    }
    const { inspection } = state
    setInstalling(true)
    setFailure(null)
    try {
      const result = await inspection.commit()
      if (result.ok) {
        // 自动启用被拒时引擎已经提示原因，这里不再用安装完成盖掉它
        if (result.activation?.ok !== false) {
          showToast({ key: 'pluginInstallDone' })
        }
        setState(null)
      } else {
        setFailure(pluginReasonText(result.reason, result.detail))
      }
    } catch {
      setFailure(pluginReasonText('load-failed'))
    } finally {
      setInstalling(false)
      onInstalled()
    }
  }

  const info = state?.kind === 'ready' ? state.inspection.info : null
  const signed = info !== null && info.signatureVerified === 'verified'
  const signatureFailed = info !== null && info.signatureVerified === 'failed'
  const rows =
    info === null
      ? []
      : [
          { label: t('pluginLocalName'), value: info.name, warn: false },
          { label: t('pluginLocalVersion'), value: info.version, warn: false },
          { label: t('pluginLocalAuthor'), value: info.author, warn: false },
          {
            label: t('pluginLocalLicense'),
            value: info.license !== '' ? info.license : t('pluginLocalUnknown'),
            warn: false,
          },
          {
            label: t('pluginLocalSignature'),
            value: t(
              signed
                ? 'pluginLocalSignatureVerified'
                : signatureFailed
                  ? 'pluginLocalSignatureFailed'
                  : 'pluginLocalSignatureUnverified'
            ),
            warn: signatureFailed,
          },
          {
            label: t('pluginLocalInstalledState'),
            value: t(info.installed ? 'pluginLocalInstalledYes' : 'pluginLocalInstalledNo'),
            warn: info.installed,
          },
        ]

  return (
    <>
      {hideTrigger ? null : (
        <Button
          variant="outlined"
          size="m"
          disabled={installing}
          onClick={() => inputRef.current?.click()}
        >
          {t('pluginInstallFromLocal')}
        </Button>
      )}
      <input
        ref={inputRef}
        className={styles.fileInput}
        type="file"
        accept=".zip,.tgz"
        aria-label={t('pluginLocalFileLabel')}
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null
          // 清空取值，允许再次选择同一个文件
          event.target.value = ''
          if (file) {
            void inspect(file)
          }
        }}
      />
      {state ? (
        <Modal
          title={t('pluginLocalDialogTitle')}
          onClose={close}
          footer={
            <>
              <Button variant="outlined" disabled={installing} onClick={close}>
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={installing || state.kind !== 'ready' || state.inspection.info.installed}
                onClick={() => void confirm()}
              >
                {installing ? t('pluginInstalling') : t('pluginLocalConfirm')}
              </Button>
            </>
          }
        >
          <div className={styles.infoGrid}>
            <div className={styles.infoLabel}>{t('pluginLocalFile')}</div>
            <div className={styles.infoValue}>{state.fileName}</div>
            {rows.map((item) => (
              <Fragment key={item.label}>
                <div className={styles.infoLabel}>{item.label}</div>
                <div className={item.warn ? styles.infoWarn : styles.infoValue}>{item.value}</div>
              </Fragment>
            ))}
          </div>
          {state.kind === 'inspecting' ? (
            <div className={styles.caption}>{t('pluginLocalInspecting')}</div>
          ) : null}
          {state.kind === 'rejected' ? (
            <div className={styles.fieldError} role="alert">
              {state.reason}
            </div>
          ) : null}
          {info !== null && signatureFailed ? (
            <div className={styles.trustWarn}>{t('pluginLocalSignatureFailedNotice')}</div>
          ) : null}
          {info !== null && !signed && !signatureFailed ? (
            <div className={styles.trustWarn}>{t('pluginLocalUnsignedNotice')}</div>
          ) : null}
          {info !== null && info.installed ? (
            <div className={styles.fieldError}>{t('pluginLocalDuplicateNotice')}</div>
          ) : null}
          {failure !== null ? (
            <div className={styles.fieldError} role="alert">
              {failure}
            </div>
          ) : null}
        </Modal>
      ) : null}
    </>
  )
})

LocalInstall.displayName = 'LocalInstall'
