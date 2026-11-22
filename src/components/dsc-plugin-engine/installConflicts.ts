import type { InstallConflict } from './types.js'

/** 冲突判定只看清单的 id 与 conflicts，注册表记录与待安装清单都收敛成这个形状 */
export type ConflictDeclaration = {
  id: string
  conflicts?: readonly string[]
}

/**
 * 安装期冲突：新插件声明的 conflicts 与已安装插件的反向声明一并判定。
 * 正向是本插件声明排斥对方，反向是对方声明排斥本插件，两边都声明时合并成一条 mutual。
 * 只看已安装记录，不看记录处于启用还是停用：安装允许冲突共存，检出结果交给引擎区分处置——
 * 对方在启用中时新插件保持停用并写入待决定记录，对方全部停用时仅警告；
 * 启用期的 activationConflicts 只看 active，拦的是「能否同时运行」。
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
