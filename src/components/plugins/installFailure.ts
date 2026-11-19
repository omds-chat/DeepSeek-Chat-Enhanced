import type { TranslationMessage } from '../../i18n/index.js'
import type { InstallResult } from '../dsc-plugin-engine/types.js'
import type { RemovedVerdict } from '../dsc-market/index.js'

/**
 * 直接链接安装失败时的提示结论。
 * removed 表示链接指向已被来源移除的插件；not-found 表示没有任何清单命中；
 * undetermined 表示清单全部不可达，此时沿用现有失败文案，不臆断。
 */
export type InstallFailureTip =
  | { kind: 'removed'; message: TranslationMessage }
  | { kind: 'not-found'; message: TranslationMessage }
  | { kind: 'undetermined' }

/**
 * 判定该给用户提示什么。
 * 只有「取不到产物」这一类失败才细看已移除插件清单：签名校验未通过只提示不阻断，
 * 其余失败原因与清单无关，一律按未判定处理。
 */
export const judgeInstallFailure = (input: {
  result: InstallResult
  /** 没有做判定时传 null，与「清单全部不可达」同样按未判定处理 */
  verdict: RemovedVerdict | null
  locale: 'zh-CN' | 'en-US'
}): InstallFailureTip => {
  const { result, verdict, locale } = input
  if (result.ok || result.reason !== 'artifact-unreachable' || verdict === null) {
    return { kind: 'undetermined' }
  }
  if (verdict.state === 'removed') {
    const name = verdict.entry.name
    const note = verdict.entry.note === null ? '' : verdict.entry.note[locale]
    return note === ''
      ? { kind: 'removed', message: { key: 'pluginInstallRemovedNotice', params: { name } } }
      : {
          kind: 'removed',
          message: { key: 'pluginInstallRemovedNoticeWithNote', params: { name, note } },
        }
  }
  if (verdict.state === 'absent') {
    return { kind: 'not-found', message: { key: 'pluginInstallNotFound' } }
  }
  return { kind: 'undetermined' }
}
