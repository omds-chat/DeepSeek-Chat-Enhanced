import { translate, type TranslationKey } from './index.js'

/** 单条原因代码的文案键；带参数的代码用 param 指定占位符名 */
type ReasonSpec = { key: TranslationKey; param?: string }

/**
 * 内部原因代码到文案键的映射。
 * 引擎与界面共用的代码都在这里登记，新增代码时只改这一处。
 */
const REASONS: Record<string, ReasonSpec> = {
  'invalid-manifest': { key: 'pluginReasonInvalidManifest' },
  'unknown-capability': { key: 'pluginReasonUnknownCapability' },
  'unknown-contribution': { key: 'pluginReasonUnknownContribution' },
  'incompatible-version': { key: 'pluginReasonIncompatibleVersion' },
  duplicate: { key: 'pluginReasonDuplicate' },
  conflict: { key: 'pluginReasonConflict' },
  'missing-dependency': { key: 'pluginReasonMissingDependency', param: 'id' },
  'depended-on': { key: 'pluginReasonDependedOn', param: 'id' },
  'load-failed': { key: 'pluginReasonLoadFailed' },
  'artifact-unreachable': { key: 'pluginReasonArtifactUnreachable' },
  'invalid-plugin': { key: 'pluginReasonInvalidPlugin' },
  'no-plugin-instance': { key: 'pluginReasonNoInstance' },
  'signature-invalid': { key: 'pluginReasonSignatureInvalid' },
  'certificate-revoked': { key: 'pluginReasonCertificateRevoked' },
  'unsupported-package': { key: 'pluginReasonUnsupportedPackage' },
  'corrupt-package': { key: 'pluginReasonCorruptPackage' },
  'missing-meta': { key: 'pluginReasonMissingMeta' },
  'missing-plugin': { key: 'pluginReasonMissingPlugin' },
  'invalid-meta': { key: 'pluginReasonInvalidMeta' },
  'package-too-large': { key: 'pluginReasonPackageTooLarge' },
}

/**
 * 把内部原因代码翻译成用户可读的文案。
 * 代码形如 code 或 code:参数，参数缺失时用 detail 补齐；未知代码回落到通用文案。
 * 原始代码仍由引擎写入插件日志，界面只展示这里的结果。
 */
export const pluginReasonText = (reason: string, detail?: string): string => {
  const separator = reason.indexOf(':')
  const code = separator === -1 ? reason : reason.slice(0, separator)
  const arg = separator === -1 ? '' : reason.slice(separator + 1)
  const spec = REASONS[code]
  if (!spec) {
    return translate('pluginReasonUnknown')
  }
  if (!spec.param) {
    return translate(spec.key)
  }
  const value = arg !== '' ? arg : (detail ?? '')
  if (value === '') {
    return translate('pluginReasonUnknown')
  }
  return translate(spec.key, { [spec.param]: value })
}
