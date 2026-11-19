#!/usr/bin/env node
/**
 * 清理分支工作树的根目录。
 *
 * 删除范围是根目录下的全部顶层条目(目录递归删除),隐藏文件与隐藏目录同样处理,
 * 只保留 .git 与白名单条目;白名单只对顶层条目生效,白名单目录内部的内容不动。
 *
 * 用法:
 *   node .github/scripts/clean-worktree.mjs --dir <工作树目录> [--whitelist <条目,条目>]
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 白名单: 清理后保留的顶层条目,version 目录存放历史发布 */
export const WHITELIST = ['version']

/** 永远保留的 git 元数据目录 */
const GIT_ENTRY = '.git'

const USAGE = [
  '用法: node .github/scripts/clean-worktree.mjs --dir <工作树目录> [--whitelist <条目,条目>]',
  '',
  '  --dir <目录>        待清理的分支工作树根目录,必须含 .git',
  '  --whitelist <条目>  额外保留的顶层条目,逗号分隔;内置白名单始终生效',
  '  --help              打印用法',
].join('\n')

const fail = (message) => {
  throw new Error(message)
}

/**
 * 清理工作树根目录。
 * 返回被删除与被保留的顶层条目,便于在日志里核对结果。
 */
export const cleanWorktree = (dir, whitelist = WHITELIST) => {
  const root = path.resolve(dir)
  if (!existsSync(root)) {
    fail('工作树目录不存在: ' + dir)
  }
  if (!statSync(root).isDirectory()) {
    fail('目标不是目录: ' + dir)
  }
  if (path.dirname(root) === root) {
    fail('拒绝清理文件系统根目录: ' + dir)
  }
  // 只允许清理检出目录: 缺少 .git 时大概率传错了路径
  if (!existsSync(path.join(root, GIT_ENTRY))) {
    fail('目标目录不是 git 工作树(缺少 .git): ' + dir)
  }
  const keep = new Set([GIT_ENTRY, ...whitelist])
  const removed = []
  const kept = []
  for (const entry of readdirSync(root)) {
    if (keep.has(entry)) {
      kept.push(entry)
      continue
    }
    rmSync(path.join(root, entry), { recursive: true, force: true })
    removed.push(entry)
  }
  return { root, removed: removed.sort(), kept: kept.sort() }
}

const parseArgs = (argv) => {
  const options = { dir: '', whitelist: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg !== '--dir' && arg !== '--whitelist') {
      fail('未知选项 ' + arg + '\n' + USAGE)
    }
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) {
      fail('选项 ' + arg + ' 缺少值\n' + USAGE)
    }
    index += 1
    if (arg === '--dir') {
      if (options.dir !== '') {
        fail('选项 --dir 重复给出')
      }
      options.dir = value
      continue
    }
    const items = value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
    if (items.length === 0) {
      fail('选项 --whitelist 的值不能为空')
    }
    options.whitelist = items
  }
  return options
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
  const whitelist =
    options.whitelist === null ? WHITELIST : [...new Set([...WHITELIST, ...options.whitelist])]
  const result = cleanWorktree(options.dir, whitelist)
  console.log('[clean-worktree] 目录: ' + result.root)
  console.log(
    '[clean-worktree] 已删除: ' + (result.removed.length === 0 ? '(无)' : result.removed.join('、'))
  )
  console.log('[clean-worktree] 已保留: ' + result.kept.join('、'))
}

const entry = process.argv[1]
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error('[clean-worktree] ' + (error instanceof Error ? error.message : String(error)))
    process.exit(1)
  }
}
