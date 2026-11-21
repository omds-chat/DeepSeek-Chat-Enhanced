import type { InstallConflict, InstallRejection } from './types.js'

/** 冲突判定只看清单的 id 与 conflicts，注册表记录与待安装清单都收敛成这个形状 */
export type ConflictDeclaration = {
  id: string
  conflicts?: readonly string[]
}

/**
 * 安装期冲突：新插件声明的 conflicts 与已安装插件的反向声明一并判定。
 * 正向是本插件声明排斥对方，反向是对方声明排斥本插件，两边都声明时合并成一条 mutual。
 * 只看已安装记录，不看记录处于启用还是停用：安装拦的是「能否共存」；
 * 启用期的 activationConflicts 才只看 active，拦的是「能否同时运行」。
 */
export const detectInstallConflicts = (
  manifest: ConflictDeclaration,
  installed: readonly ConflictDeclaration[]
): InstallConflict[] => {
  const declared = new Set(manifest.conflicts ?? [])
  const conflicts: InstallConflict[] = []
  for (const other of installed) {
    // 同 id 由重名判定处理，不重复报成冲突
    if (other.id === manifest.id) {
      continue
    }
    const forward = declared.has(other.id)
    const backward = (other.conflicts ?? []).includes(manifest.id)
    if (forward && backward) {
      conflicts.push({ kind: 'mutual', declarer: manifest.id, target: other.id })
    } else if (forward) {
      conflicts.push({ kind: 'single', declarer: manifest.id, target: other.id })
    } else if (backward) {
      conflicts.push({ kind: 'single', declarer: other.id, target: manifest.id })
    }
  }
  return conflicts
}

/** 冲突类拒绝原因：按声明方向分成三条，文案据此说明是哪一方声明的 */
export type InstallConflictReason = Extract<
  InstallRejection,
  'install-conflict-declared' | 'install-conflict-required' | 'install-conflict-mutual'
>

/** 一次安装拒绝的冲突结论 */
export type InstallConflictVerdict = {
  reason: InstallConflictReason
  /** 与原因同类的冲突里的对方 id，去重升序；详情文案据此列出涉及的插件 */
  ids: string[]
}

/**
 * 把冲突集合收敛成一条拒绝原因。
 * 优先级为双向、反向、正向：先报双方互相声明，其次报已安装方的声明——后者不依赖新插件自己的清单，最容易让用户意外。
 * 同一优先级可以有多对，对方 id 全部列出；其余冲突对仍由 conflicts 原样带回。
 * 只在有冲突时调用；没有冲突时返回正向口径与空列表。
 */
export const installConflictVerdict = (
  id: string,
  conflicts: readonly InstallConflict[]
): InstallConflictVerdict => {
  /** 双向 0、反向 1、正向 2；数值越小越优先 */
  const rank = (conflict: InstallConflict): number =>
    conflict.kind === 'mutual' ? 0 : conflict.declarer === id ? 2 : 1
  let top = Number.POSITIVE_INFINITY
  for (const conflict of conflicts) {
    top = Math.min(top, rank(conflict))
  }
  const reason: InstallConflictReason =
    top === 0
      ? 'install-conflict-mutual'
      : top === 1
        ? 'install-conflict-required'
        : 'install-conflict-declared'
  const ids = new Set<string>()
  for (const conflict of conflicts) {
    if (rank(conflict) === top) {
      ids.add(conflict.declarer === id ? conflict.target : conflict.declarer)
    }
  }
  return { reason, ids: [...ids].sort() }
}
