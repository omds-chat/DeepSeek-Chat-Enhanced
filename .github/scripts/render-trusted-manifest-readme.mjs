#!/usr/bin/env node
/**
 * 用 .github/scripts/trusted-manifest-README.md 模板渲染 trusted-manifest 分支的 README.md。
 *
 * 模板占位符:
 *   {{TAG}}         本次发布的 tag
 *   {{VERSIONS}}    已归档的版本目录列表
 *   {{COLLECTIONS}} 本次登记的合集列表
 *
 * 用法:
 *   node .github/scripts/render-trusted-manifest-readme.mjs --template <模板> --out <README.md> --tag <tag> \
 *     [--index <index.json>] [--versions <tag,tag>]
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 模板里允许出现的占位符 */
const PLACEHOLDERS = new Set(['TAG', 'VERSIONS', 'COLLECTIONS'])
/** 渲染后仍残留的占位符 */
const RESIDUAL = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

const USAGE = [
  '用法: node .github/scripts/render-trusted-manifest-readme.mjs --template <模板> --out <README.md> --tag <tag> [--index <index.json>] [--versions <tag,tag>]',
  '',
  '  --template <文件>  .github/scripts/trusted-manifest-README.md',
  '  --out <文件>       输出的 README.md',
  '  --tag <tag>        本次发布的 tag',
  '  --index <文件>     信任清单,用于渲染合集列表',
  '  --versions <列表>  已归档版本,逗号分隔',
  '  --help             打印用法',
].join('\n')

const fail = (message) => {
  throw new Error(message)
}

const parseArgs = (argv) => {
  const spec = new Set(['--template', '--out', '--tag', '--index', '--versions'])
  const options = { template: '', out: '', tag: '', index: '', versions: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (!spec.has(arg)) {
      fail('未知选项 ' + arg + '\n' + USAGE)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      fail('选项 ' + arg + ' 缺少值\n' + USAGE)
    }
    index += 1
    const key = arg.slice(2)
    if (options[key] !== '') {
      fail('选项 ' + arg + ' 重复给出')
    }
    options[key] = value
  }
  return options
}

/** 把逗号分隔的列表渲染成 markdown 列表,子项统一包一层反引号 */
const renderList = (items, wrap) => {
  if (items.length === 0) {
    return '- (无)'
  }
  return items.map((item) => '- ' + wrap(item)).join('\n')
}

const splitList = (value) =>
  value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')

/** 从 index.json 取合集 id,渲染成列表 */
const renderCollections = (indexPath) => {
  if (indexPath === '') {
    return renderList([], (id) => `\`${id}\``)
  }
  const target = path.resolve(indexPath)
  if (!existsSync(target) || !statSync(target).isFile()) {
    fail('信任清单不存在: ' + indexPath)
  }
  const parsed = JSON.parse(readFileSync(target, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.collections)) {
    fail('信任清单缺少 collections 数组: ' + indexPath)
  }
  const ids = parsed.collections
    .map((item) => (item !== null && typeof item === 'object' ? item.id : undefined))
    .filter((id) => typeof id === 'string' && id !== '')
  return renderList(ids, (id) => `\`${id}\``)
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }
  for (const [key, label] of [
    ['template', '--template'],
    ['out', '--out'],
    ['tag', '--tag'],
  ]) {
    if (options[key] === '') {
      fail('缺少 ' + label + ' 参数\n' + USAGE)
    }
  }
  const templatePath = path.resolve(options.template)
  if (!existsSync(templatePath) || !statSync(templatePath).isFile()) {
    fail('模板不存在: ' + options.template)
  }
  const versions = splitList(options.versions)
  const rendered = readFileSync(templatePath, 'utf8')
    .replaceAll('{{TAG}}', options.tag)
    .replaceAll('{{VERSIONS}}', renderList(versions, (tag) => `\`version/${tag}/\``))
    .replaceAll('{{COLLECTIONS}}', renderCollections(options.index))
  const unknown = []
  for (const match of rendered.matchAll(RESIDUAL)) {
    if (!PLACEHOLDERS.has(match[1])) {
      unknown.push(match[1])
    }
  }
  if (unknown.length > 0) {
    fail('模板含未知占位符: ' + unknown.join('、'))
  }
  if (/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/.test(rendered)) {
    fail('模板仍有未替换的占位符')
  }
  const outPath = path.resolve(options.out)
  writeFileSync(outPath, rendered.endsWith('\n') ? rendered : rendered + '\n', 'utf8')
  console.log('[render-readme] 已写出: ' + options.out + '(版本 ' + versions.length + ' 个)')
}

try {
  main()
} catch (error) {
  console.error('[render-readme] ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
