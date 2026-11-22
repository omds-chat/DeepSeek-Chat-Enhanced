#!/usr/bin/env node
/**
 * 裁剪分支工作树的 version 目录,只保留最近的 MAX_VERSIONS 个历史版本。
 *
 * 排序口径: 版本目录名按 dsc-主版本.次版本.修订版本(-XXX.序号) 解析成数值后比较,
 * 按数值排序,避免 10.0.0 排在 9.0.0 之前这样的字符串序错误;
 * 三段数值都相同时,正式版排在预发行之前,预发行之间按 XXX 的 ASCII 降序、序号降序;
 * 仍相同时再比较目录名,保证同一份目录树的排序结果稳定可复现。
 *
 * 保留 latest 目录(当前版本入口)与数值最大的 MAX_VERSIONS 个版本目录,其余版本目录删除。
 * 不符合命名规范的条目一律跳过并给出警告,既不参与排序也不删除。
 *
 * 用法:
 *   node .github/scripts/prune-versions.mjs --dir <version 目录>
 */
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 保留的历史版本目录数量上限 */
export const MAX_VERSIONS = 1000

/** latest 目录指向当前版本,不属于历史版本,始终保留 */
export const LATEST_ENTRY = 'latest'

/**
 * 版本目录命名: dsc-主版本.次版本.修订版本,三段均为十进制数。
 * 预发行追加 -XXX.序号(XXX 为小写字母串,序号为十进制数),是正式版之外的发布形态,
 * 在 version/ 下以 version/<tag>/ 独立成目录,同样参与留存裁剪。
 */
export const VERSION_PATTERN = /^dsc-([0-9]+)\.([0-9]+)\.([0-9]+)(-([a-z]+)\.([0-9]+))?$/

const USAGE = [
  '用法: node .github/scripts/prune-versions.mjs --dir <version 目录>',
  '',
  '  --dir <目录>  分支工作树的 version 目录,只裁剪其下的历史版本目录',
  '  --help        打印用法',
].join('\n')

const fail = (message) => {
  throw new Error(message)
}

const warn = (message) => {
  console.warn('[prune-versions] 警告: ' + message)
}

/**
 * 解析版本目录名,返回三段数值与预发行标记。
 * 预发行 pre 为 { kind, n };正式版 pre 为 null。
 * 不符合命名规范时返回 null,由调用方按条目跳过处理。
 */
export const parseVersionEntry = (name) => {
  const matched = VERSION_PATTERN.exec(name)
  if (matched === null) {
    return null
  }
  return {
    name,
    parts: [Number(matched[1]), Number(matched[2]), Number(matched[3])],
    pre: matched[4] === undefined ? null : { kind: matched[5], n: Number(matched[6]) },
  }
}

/**
 * 按三段数值降序比较,数值最大的排在前面。
 * 三段数值相同时,正式版排在预发行之前(同基础版本的正式发布晚于其预发行);
 * 两个预发行之间按 XXX 的 ASCII 降序、序号降序排序:
 * 「旧到新」的口径是 XXX 的 ASCII 升序、序号升序,ASCII 小的更旧,裁剪时先被淘汰。
 * 全部相同时按目录名降序,保证排序结果稳定。
 */
export const compareVersionsDesc = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) {
      return right.parts[index] - left.parts[index]
    }
  }
  if (left.pre !== right.pre) {
    // 正式版(pre 为 null)视为更大,排在前面
    if (left.pre === null) {
      return -1
    }
    if (right.pre === null) {
      return 1
    }
    if (left.pre.kind !== right.pre.kind) {
      return right.pre.kind < left.pre.kind ? -1 : 1
    }
    return right.pre.n - left.pre.n
  }
  if (left.name === right.name) {
    return 0
  }
  return left.name < right.name ? 1 : -1
}

/**
 * 裁剪 version 目录。
 * 返回保留、删除与跳过的条目清单,便于在日志里核对结果。
 */
export const pruneVersions = (dir, max = MAX_VERSIONS) => {
  const root = path.resolve(dir)
  if (!existsSync(root)) {
    fail('version 目录不存在: ' + dir)
  }
  if (!statSync(root).isDirectory()) {
    fail('目标不是目录: ' + dir)
  }
  const versions = []
  const skipped = []
  let hasLatest = false
  for (const entry of readdirSync(root)) {
    if (entry === LATEST_ENTRY) {
      hasLatest = true
      continue
    }
    const parsed = parseVersionEntry(entry)
    if (parsed === null) {
      skipped.push({ name: entry, reason: '命名不符合 dsc-主版本.次版本.修订版本(-XXX.序号)' })
      continue
    }
    if (!lstatSync(path.join(root, entry)).isDirectory()) {
      skipped.push({ name: entry, reason: '同名条目不是目录' })
      continue
    }
    versions.push(parsed)
  }
  versions.sort(compareVersionsDesc)
  const kept = versions.slice(0, max)
  const removed = versions.slice(max)
  for (const item of removed) {
    rmSync(path.join(root, item.name), { recursive: true, force: true })
  }
  return {
    root,
    hasLatest,
    versions: versions.length,
    kept: kept.map((item) => item.name),
    removed: removed.map((item) => item.name),
    skipped,
  }
}

const parseArgs = (argv) => {
  const options = { dir: '', help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg !== '--dir') {
      fail('未知选项 ' + arg + '\n' + USAGE)
    }
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) {
      fail('选项 ' + arg + ' 缺少值\n' + USAGE)
    }
    index += 1
    if (options.dir !== '') {
      fail('选项 --dir 重复给出')
    }
    options.dir = value
  }
  return options
}

/** 删除清单只截断打印,不影响实际删除结果 */
const formatNameList = (names, limit = 100) => {
  if (names.length === 0) {
    return '(无)'
  }
  if (names.length <= limit) {
    return names.join('、')
  }
  return names.slice(0, limit).join('、') + ' 等共 ' + names.length + ' 个'
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (options.dir === '') {
    fail('缺少 --dir 参数\n' + USAGE)
  }
  const result = pruneVersions(options.dir, MAX_VERSIONS)
  for (const item of result.skipped) {
    warn('跳过条目 ' + item.name + '(' + item.reason + '),未删除')
  }
  console.log('[prune-versions] 目录: ' + result.root)
  console.log('[prune-versions] latest 目录: ' + (result.hasLatest ? '存在,保留' : '不存在'))
  console.log(
    '[prune-versions] 规范版本目录 ' +
      result.versions +
      ' 个,保留上限 ' +
      MAX_VERSIONS +
      ' 个,实际保留 ' +
      result.kept.length +
      ' 个,删除 ' +
      result.removed.length +
      ' 个,跳过 ' +
      result.skipped.length +
      ' 个'
  )
  console.log('[prune-versions] 已删除: ' + formatNameList(result.removed))
}

const entry = process.argv[1]
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error('[prune-versions] ' + (error instanceof Error ? error.message : String(error)))
    process.exit(1)
  }
}
