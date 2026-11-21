import { useCallback, useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
import { useSettings } from '../../services/settings.js'
import { getPluginEngine } from '../dsc-plugin-engine/index.js'
import { pairDetailsCollapsed } from '../dsc-plugin-engine/pendingConflicts.js'
import type { PendingConflict, PluginStateView } from '../dsc-plugin-engine/types.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './PluginPanel.module.css'

/**
 * 待决定的插件冲突。
 * 冲突检测时引擎已把涉及的启用插件全部停用，这里只负责展示与让用户逐组选择保留哪一个。
 * 位置放在已安装列表顶部：冲突双方都在下面的列表里，选完能立刻看到状态从「已停用」变成「运行中」，
 * 且不必改动列表的表格结构。
 */
export const PendingConflicts = ({
  plugins,
  refresh,
}: {
  plugins: PluginStateView[]
  refresh: () => void
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [groups, setGroups] = useState<PendingConflict[]>([])
  /** 已展开逐条详情的组；冲突对多于门槛时默认收起 */
  const [expanded, setExpanded] = useState<readonly string[]>([])
  /** 正在处理的选择，形如「组 id:保留的插件 id」 */
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(() => {
    const engine = getPluginEngine()
    setGroups(engine ? engine.pendingConflicts() : [])
  }, [])

  // 插件列表变化（安装、启停、卸载）后重新读取：引擎在卸载时清理记录，这里随之刷新
  useEffect(reload, [reload, plugins])

  const names = new Map(plugins.map((plugin) => [plugin.id, plugin.name]))
  const nameOf = (id: string) => names.get(id) ?? id
  const joined = (ids: readonly string[]) =>
    ids.map(nameOf).join(locale === 'zh-CN' ? '、' : ', ')

  const toggleExpanded = (id: string) =>
    setExpanded((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    )

  /** 用户选择：记录先删再启用保留的那一个，其余保持停用；失败原因由引擎给出 */
  const choose = async (group: PendingConflict, keepId: string) => {
    const engine = getPluginEngine()
    if (!engine) {
      showToast({ type: 'error', key: 'pluginEngineUnavailable' })
      return
    }
    setBusy(group.id + ':' + keepId)
    try {
      const result = await engine.resolvePendingConflict(group.id, keepId)
      if (result.ok) {
        showToast({ key: 'pluginConflictPendingKept', params: { name: nameOf(keepId) } })
      } else if (result.reason === 'not-found' || result.reason === 'not-in-group') {
        // 记录在别处已被处理或清理：列表刷新即可，不再提示失败原因
        showToast({ key: 'pluginConflictPendingGone' })
      } else {
        showToast({
          type: 'error',
          key: 'pluginConflictPendingKeptFailed',
          params: { name: nameOf(keepId), reason: pluginReasonText(result.reason, result.detail) },
        })
      }
    } catch {
      showToast({
        type: 'error',
        key: 'pluginConflictPendingKeptFailed',
        params: { name: nameOf(keepId), reason: pluginReasonText('load-failed') },
      })
    } finally {
      setBusy(null)
      reload()
      refresh()
    }
  }

  if (groups.length === 0) {
    return null
  }

  return (
    <section className={styles.pendingSection} aria-label={t('pluginConflictPendingTitle')}>
      <div className={styles.pendingTitle}>{t('pluginConflictPendingTitle')}</div>
      <div className={styles.caption}>{t('pluginConflictPendingHint')}</div>
      {groups.map((group) => {
        const multiple = pairDetailsCollapsed(group.pairs.length)
        const collapsed = multiple && !expanded.includes(group.id)
        return (
          <div key={group.id} className={styles.pendingGroup} role="group">
            <div className={styles.pendingGroupLine}>
              {t('pluginConflictPendingGroup', {
                count: group.pairs.length,
                names: joined(group.plugins),
              })}
            </div>
            {collapsed ? null : (
              <ul className={styles.pendingPairList}>
                {group.pairs.map((pair) => (
                  <li
                    key={pair.kind + pair.declarer + pair.target}
                    className={styles.pendingPair}
                  >
                    {t(
                      pair.kind === 'mutual'
                        ? 'pluginConflictPendingPairMutual'
                        : 'pluginConflictPendingPairSingle',
                      { declarer: nameOf(pair.declarer), target: nameOf(pair.target) }
                    )}
                  </li>
                ))}
              </ul>
            )}
            {multiple ? (
              <button
                type="button"
                className={styles.pendingToggle}
                onClick={() => toggleExpanded(group.id)}
              >
                {collapsed
                  ? t('pluginConflictPendingExpand', { count: group.pairs.length })
                  : t('pluginConflictPendingCollapse')}
              </button>
            ) : null}
            <div className={styles.pendingActions}>
              {group.plugins.map((id) => (
                <Button
                  key={id}
                  variant="outlined"
                  size="s"
                  disabled={busy !== null}
                  onClick={() => void choose(group, id)}
                >
                  {busy === group.id + ':' + id
                    ? t('pluginOperationBusy')
                    : t('pluginConflictPendingKeep', { name: nameOf(id) })}
                </Button>
              ))}
            </div>
          </div>
        )
      })}
    </section>
  )
}
