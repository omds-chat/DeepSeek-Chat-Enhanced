import type { TranslationKey } from './index.js'
import type {
  SourceTrustState,
  SourceVerdict,
  SourceVerdictReason,
} from '../components/dsc-plugin-engine/types.js'

/** 来源结论的基础文案键 */
const VERDICT_KEYS: Record<SourceVerdict, TranslationKey> = {
  confirmed: 'pluginVerdictConfirmed',
  failed: 'pluginVerdictFailed',
  unknown: 'pluginVerdictUnknown',
  local: 'pluginVerdictLocal',
}

/**
 * 来源结论文案键。
 * failed 按原因细分：链校验失败与证书吊销各自成句，其余（含产物验签未通过）用通用文案。
 */
export const verdictTextKey = (
  verdict: SourceVerdict,
  reason: SourceVerdictReason
): TranslationKey => {
  if (verdict !== 'failed') {
    return VERDICT_KEYS[verdict]
  }
  if (reason === 'chain') {
    return 'pluginVerdictFailedChain'
  }
  if (reason === 'revoked') {
    return 'pluginVerdictFailedRevoked'
  }
  return 'pluginVerdictFailed'
}

/**
 * 来源是否未在 online-data 信任清单登记。
 * 信任清单只是策略层：未登记不等于不可信，界面只补一个中性标注。
 */
export const isUnlistedTrust = (trust: SourceTrustState | undefined): boolean =>
  trust === undefined || trust === 'unverified'
