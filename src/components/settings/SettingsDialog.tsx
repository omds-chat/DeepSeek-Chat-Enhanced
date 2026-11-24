import { useTranslate } from '../../i18n/index.js'
import { useIsMobile } from '../../app/viewport.js'
import { Modal } from '../base/Modal.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { closeSettings, useSettingsDialog } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 首启的 API Key 弹窗：设置本体已改为主区整页（SettingsPage），
 * 只有「还没有 API Key」这一处保留模态例外——它要能在任何页面之上出现，
 * 保存成功后自行关闭；已配置过 Key 时不会自动出现，见 settingsDialogState 的 ensureApiKey。
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <ApiKeyDialog /> : null
}

const ApiKeyDialog = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const editor = useApiKeyEditor(closeSettings)
  return (
    <Modal
      title={t('settings')}
      closable
      className={styles.dialog}
      mainClassName={styles.dialogMain}
      onClose={closeSettings}
    >
      <ApiKeyField editor={editor} />
      {isMobile ? <ApiKeyConfirm editor={editor} /> : null}
    </Modal>
  )
}
