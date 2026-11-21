#!/usr/bin/env node
/**
 * 生成 trusted-manifest 分支的信任清单 index.json。
 *
 * 合集条目取自 certs/manifest.json,collections 里每项的 eec 路径相对 certs 目录,
 * 以 certs 分支根目录为基准,前缀补 certs/ 。
 *
 * index.json 的结构:
 * {
 *   "schemaVersion": 2,
 *   "rootCa": "certs/ds-chat/ds-chat-root-ca.crt",
 *   "crl": null,
 *   "collections": [
 *     { "id": "<合集名>", "eec": "certs/<合集名>/<合集名>-eec.crt" }
 *   ]
 * }
 *
 * 用法:
 *   node .github/scripts/build-trust-index.mjs --manifest <清单> --out <index.json> [--certs-root <certs 目录>]
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 输出清单的结构版本 */
const SCHEMA_VERSION = 2
/** 根证书相对 certs 分支根目录的路径,固定不变 */
const ROOT_CA_PATH = 'certs/ds-chat/ds-chat-root-ca.crt'
/** 合集证书相对 certs 分支根目录的目录前缀 */
const COLLECTION_PREFIX = 'certs/'
/** 不登记进 collections 的目录: dsc-inner-plugin 不是普通合集,其 EEC 直接放在 certs/dsc-inner-plugin/ 下 */
const NOT_A_COLLECTION = new Set(['dsc-inner-plugin'])
/** 合集 id 允许的字符 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const USAGE = [
  '用法: node .github/scripts/build-trust-index.mjs --manifest <清单> --out <index.json> [--certs-root <certs 目录>]',
  '',
  '  --manifest <文件>   certs/manifest.json',
  '  --certs-root <目录> 主仓库的 certs 目录,用于核对证书文件是否存在,默认 certs',
  '  --out <文件>        输出的 index.json',
  '  --help              打印用法',
].join('\n')

const fail = (message) => {
  throw new Error(message)
}

/** 只接受清单内的相对路径,避免拼出越界路径或站外地址 */
const isSafeRelative = (value) =>
  value !== '' &&
  !path.isAbsolute(value) &&
  !value.includes('..') &&
  !/^[a-z][a-z0-9+.-]*:/i.test(value)

const parseArgs = (argv) => {
  const spec = new Set(['--manifest', '--out', '--certs-root'])
  const options = { manifest: '', out: '', certsRoot: 'certs', help: false }
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
    if (value === undefined || value === '' || value.startsWith('--')) {
      fail('选项 ' + arg + ' 缺少值\n' + USAGE)
    }
    index += 1
    const key = arg === '--manifest' ? 'manifest' : arg === '--out' ? 'out' : 'certsRoot'
    if (arg !== '--certs-root' && options[key] !== '') {
      fail('选项 ' + arg + ' 重复给出')
    }
    options[key] = value
  }
  return options
}

/**
 * 依据合集清单推导 collections。
 * 跳过非合集目录,校验 id 与 eec 路径,并在给出 certs 目录时核对证书文件确实存在。
 */
const buildCollections = (manifest, manifestDir) => {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    fail('清单结构不是对象')
  }
  if (!Array.isArray(manifest.collections)) {
    fail('清单缺少 collections 数组')
  }
  const collections = []
  const seen = new Set()
  const skipped = []
  for (const entry of manifest.collections) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail('清单里的 collections 条目不是对象')
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const eec = typeof entry.eec === 'string' ? entry.eec.trim() : ''
    if (!ID_PATTERN.test(id)) {
      fail('合集 id 不合法: ' + JSON.stringify(entry.id))
    }
    if (NOT_A_COLLECTION.has(id)) {
      skipped.push(id)
      continue
    }
    if (!isSafeRelative(eec)) {
      fail('合集 ' + id + ' 的 eec 路径不合法: ' + JSON.stringify(entry.eec))
    }
    if (seen.has(id)) {
      fail('合集 id 重复: ' + id)
    }
    seen.add(id)
    // 证书按清单所在目录解析;分支内的路径前缀另外补,两者不能混用
    const source = path.join(path.resolve(manifestDir), eec)
    if (!existsSync(source) || !statSync(source).isFile()) {
      fail('合集 ' + id + ' 的证书不存在: ' + source)
    }
    collections.push({ id, eec: COLLECTION_PREFIX + eec })
  }
  return { collections, skipped }
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (options.manifest === '') {
    fail('缺少 --manifest 参数\n' + USAGE)
  }
  if (options.out === '') {
    fail('缺少 --out 参数\n' + USAGE)
  }
  const manifestPath = path.resolve(options.manifest)
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    fail('清单不存在: ' + options.manifest)
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail('清单不是合法 JSON: ' + (error instanceof Error ? error.message : String(error)))
  }
  const certsRoot = path.resolve(options.certsRoot)
  if (!existsSync(certsRoot) || !statSync(certsRoot).isDirectory()) {
    fail('certs 目录不存在: ' + options.certsRoot)
  }
  const rootCa = path.join(certsRoot, 'ds-chat', 'ds-chat-root-ca.crt')
  if (!existsSync(rootCa) || !statSync(rootCa).isFile()) {
    fail('根证书不存在: ' + rootCa)
  }
  const { collections, skipped } = buildCollections(manifest, path.dirname(manifestPath))
  const index = {
    schemaVersion: SCHEMA_VERSION,
    rootCa: ROOT_CA_PATH,
    crl: null,
    collections,
  }
  const outPath = path.resolve(options.out)
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n', 'utf8')
  console.log('[build-trust-index] 清单: ' + options.manifest + '(schemaVersion ' + manifest.schemaVersion + ')')
  console.log('[build-trust-index] 已写出: ' + options.out + '(' + collections.length + ' 个合集)')
  for (const entry of collections) {
    console.log('[build-trust-index] 合集 ' + entry.id + ' -> ' + entry.eec)
  }
  if (skipped.length > 0) {
    console.log('[build-trust-index] 未登记: ' + skipped.join('、') + '(非普通合集)')
  }
}

try {
  main()
} catch (error) {
  console.error('[build-trust-index] ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
