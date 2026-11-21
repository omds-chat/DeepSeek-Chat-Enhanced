import clsx from 'clsx'
import { useTranslate, type TranslationKey, type TranslationParams } from '../../../i18n/index.js'
import { Select } from '../../base/Select.js'
import type { SettingFieldDescriptor } from '../../dsc-plugin-engine/index.js'
import type { SettingsFieldDraft, SecretFieldState } from './useSettingsForm.js'
import styles from './PluginSettings.module.css'

/**
 * 宿主渲染的五种字段控件。
 * 插件只交字段描述，控件形态、样式与 i18n 全部归宿主：
 * 每个控件自带标签、覆盖徽标、重置按钮与错误行，草稿状态由表单模型持有。
 */

/** switch 控件；布尔草稿 */
const SwitchControl = ({
  draft,
  onChange,
}: {
  draft: boolean
  onChange: (value: boolean) => void
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={draft}
    className={clsx(styles.switch, draft && styles.switchOn)}
    onClick={() => onChange(!draft)}
  >
    <span className={styles.switchThumb} />
  </button>
)

/** number / text / secret 共用的胶囊输入框 */
const InputControl = ({
  draft,
  secret,
  invalid,
  placeholder,
  ariaLabel,
  onChange,
}: {
  draft: string
  secret: boolean
  invalid: boolean
  placeholder?: string
  ariaLabel: string
  onChange: (value: string) => void
}) => (
  <input
    type={secret ? 'password' : 'text'}
    className={clsx(styles.input, invalid && styles.inputInvalid)}
    value={draft}
    placeholder={placeholder}
    aria-label={ariaLabel}
    aria-invalid={invalid}
    autoComplete={secret ? 'new-password' : 'off'}
    spellCheck={false}
    onChange={(event) => onChange(event.target.value)}
  />
)

/** 单个字段行：标签、覆盖徽标、重置按钮、控件与错误行 */
export const SettingsFieldRow = ({
  field,
  draft,
  label,
  secret,
  onSwitchChange,
  onTextChange,
  onSelectChange,
  onReset,
  onSecretReset,
}: {
  field: SettingFieldDescriptor
  draft: SettingsFieldDraft
  /** 解析后的标签文案：labelKey 走宿主字典，label 直给 */
  label: string
  /** secret 字段的状态；非 secret 字段为 null */
  secret: SecretFieldState | null
  onSwitchChange: (value: boolean) => void
  onTextChange: (value: string) => void
  onSelectChange: (value: string) => void
  onReset: () => void
  onSecretReset: () => void
}) => {
  const t = useTranslate()
  const showReset = field.type === 'secret' ? secret?.configured === true : draft.overridden || draft.dirty
  const problem = draft.problem
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <span className={styles.label}>{label}</span>
        {field.type === 'secret' ? (
          <span className={styles.badge}>
            {t(secret?.configured ? 'pluginSettingsSecretConfigured' : 'pluginSettingsSecretNotConfigured')}
          </span>
        ) : (
          draft.overridden ? <span className={styles.badge}>{t('pluginSettingsOverridden')}</span> : null
        )}
        {field.type === 'secret' && secret?.configured ? (
          <button type="button" className={styles.resetButton} onClick={onSecretReset}>
            {t('pluginSettingsReset')}
          </button>
        ) : null}
        {field.type !== 'secret' && showReset ? (
          <button type="button" className={styles.resetButton} onClick={onReset}>
            {t('pluginSettingsReset')}
          </button>
        ) : null}
      </div>
      <div className={styles.controlRow}>
        {field.type === 'switch' ? (
          <SwitchControl draft={draft.draft === true} onChange={onSwitchChange} />
        ) : field.type === 'select' ? (
          <Select
            value={String(draft.draft)}
            ariaLabel={label}
            options={(field.options ?? []).map((option) => ({
              value: option.value,
              label: typeof option.labelKey === 'string' ? t(option.labelKey as TranslationKey) : (option.label ?? option.value),
            }))}
            onChange={onSelectChange}
          />
        ) : field.type === 'secret' ? (
          <InputControl
            draft={secret?.draft ?? ''}
            secret
            invalid={false}
            placeholder={
              secret?.configured ? t('pluginSettingsSecretPlaceholder') : undefined
            }
            ariaLabel={label}
            onChange={onTextChange}
          />
        ) : (
          <InputControl
            draft={String(draft.draft)}
            secret={false}
            invalid={draft.invalid}
            ariaLabel={label}
            onChange={onTextChange}
          />
        )}
      </div>
      {problem ? (
        <div className={styles.problem} role="alert">
          {t(problem.key, problem.params)}
        </div>
      ) : null}
    </div>
  )
}

/** 供详情页解析字段标签；labelKey 优先 */
export const settingFieldLabel = (
  field: SettingFieldDescriptor,
  translate: (key: TranslationKey, params?: TranslationParams) => string
): string =>
  typeof field.labelKey === 'string'
    ? translate(field.labelKey as TranslationKey)
    : (field.label ?? field.key)
