#!/usr/bin/env node
/**
 * 生成 online-data 分支的 PKI 信任数据。
 *
 * 输入: 根证书、可选的 CRL、以及若干「合集名=eec 证书路径」。
 * 产出: index.json、root_ca.crt、crl.pem(可选)、collections/<合集名>/eec.pem。
 *
 * 写盘前用 openssl verify 自检每张 EEC 确实由该根证书签发,任一项不通过则不写出任何文件。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  PkiError,
  describeCertificate,
  hasDigitalSignature,
  verifyChain,
} from './pki/pki.mjs'

/** 信任清单文件名 */
const INDEX_FILE = 'index.json'
/** 根证书文件名 */
const ROOT_CA_FILE = 'root_ca.crt'
/** 吊销列表文件名 */
const CRL_FILE = 'crl.pem'
/** 合集终端签名证书文件名 */
const EEC_FILE = 'eec.pem'
/** 信任清单结构版本 */
const SCHEMA_VERSION = 2
/** 合集 id 只允许安全字符,避免拼出越界路径 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** 网页 EEC 证书在输出目录内的相对路径 */
const WEB_EEC_PATH = 'web/eec.pem'
/** 旧结构留下的文件,生成新结构时清理 */
const LEGACY_ROOT_FILES = ['web_public.pem']
/** 旧结构在合集目录下留下的文件 */
const LEGACY_COLLECTION_FILES = ['plugin_secret.pub', 'plugin_set_sign.json']

const USAGE = [
  '用法: node scripts/build-online-data.mjs --root-ca <根证书> [--crl <吊销列表>] --eec <合集名>=<eec 证书> [--eec ...] --out <目录>',
  '',
  '  --root-ca <路径>   根证书,作为信任锚写入输出目录',
  '  --crl <路径>       可选的吊销列表,写入输出目录并在 index.json 中登记',
  '  --web-eec <路径>   可选的网页签名 EEC 证书,写入输出目录的 web/eec.pem',
  '  --eec <名>=<路径>  合集名与该合集的 EEC 证书,可重复给出',
  '  --out <目录>       输出目录,不存在时创建',
  '  --help             打印用法',
  '',
  '在 pnpm 中传递参数时写作: pnpm run build:online-data -- --root-ca root_ca.crt --eec awesome-dsc-plugin=../awesome-dsc-plugin/eec.pem --out single-branch/online-data',
].join('\n')

const fail = (message) => {
  throw new Error(message)
}

/** 把路径转成便于阅读的形式: 工作目录内的路径用相对路径 */
const display = (target) => {
  const relativePath = path.relative(process.cwd(), target)
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return target
  }
  return relativePath
}

/** 解析命令行参数 */
const parseArgs = (argv) => {
  const options = { out: '', rootCa: '', crl: '', webEec: '', eec: [], help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    // pnpm 传参时会插入一个单独的 -- 分隔符,直接忽略
    if (arg === '--') {
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    const equal = arg.indexOf('=')
    const name = equal === -1 ? arg : arg.slice(0, equal)
    if (name !== '--out' && name !== '--root-ca' && name !== '--crl' && name !== '--eec' && name !== '--web-eec') {
      fail('未知选项 ' + arg + '\n' + USAGE)
    }
    const inlineValue = equal === -1 ? undefined : arg.slice(equal + 1)
    const value = inlineValue === undefined ? argv[index + 1] : inlineValue
    if (value === undefined || value === '' || (inlineValue === undefined && value.startsWith('-'))) {
      fail(name + ' 缺少值' + '\n' + USAGE)
    }
    if (inlineValue === undefined) {
      index += 1
    }
    if (name === '--eec') {
      const separator = value.indexOf('=')
      if (separator <= 0 || separator === value.length - 1) {
        fail('--eec 的值必须写成 <合集名>=<eec 证书路径>,收到 ' + value)
      }
      options.eec.push({ id: value.slice(0, separator), cert: value.slice(separator + 1) })
      continue
    }
    const key =
      name === '--out' ? 'out' : name === '--crl' ? 'crl' : name === '--web-eec' ? 'webEec' : 'rootCa'
    if (options[key] !== '') {
      fail(name + ' 重复给出')
    }
    options[key] = value
  }
  return options
}

const isFile = (target) => {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

const isDirectory = (target) => {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * 用 openssl crl -verify 确认 CRL 确实由该根证书签发。
 * pki.mjs 不提供 CRL 校验,这里直接调用 openssl。
 */
const verifyCrlIssuer = (crlPath, rootCaPath) => {
  try {
    execFileSync(process.env.OPENSSL_BIN || 'openssl', ['crl', '-in', crlPath, '-noout', '-CAfile', rootCaPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, reason: null }
  } catch (error) {
    const text = String((error && error.stderr) || '') || String((error && error.message) || '')
    return { ok: false, reason: text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 2).join(' ') }
  }
}

/** 校验根证书: 必须是 CA,且带 keyCertSign */
const checkRootCa = (rootCaPath) => {
  if (!isFile(rootCaPath)) {
    fail('根证书不存在: ' + display(rootCaPath))
  }
  const info = describeCertificate(rootCaPath)
  if (info.isCa !== true) {
    fail('根证书 ' + display(rootCaPath) + ' 的 basicConstraints 不是 CA:TRUE,不能作为信任锚')
  }
  // openssl x509 -ext keyUsage 输出的是展示名 "Certificate Sign",不是扩展名 keyCertSign
  const usages = info.keyUsage.map((item) => item.toLowerCase().replace(/\s+/g, ''))
  if (!usages.includes('keycertsign') && !usages.includes('certificatesign')) {
    fail('根证书 ' + display(rootCaPath) + ' 的 keyUsage 缺少 keyCertSign,不能签发证书')
  }
  return info
}

/** 校验单个 EEC: 由根证书签发、可签名、不是 CA */
const checkEec = (entry, rootCaPath) => {
  const certPath = path.resolve(entry.cert)
  if (!isFile(certPath)) {
    fail('合集 ' + entry.id + ' 的 EEC 证书不存在: ' + display(certPath))
  }
  const chain = verifyChain(certPath, rootCaPath)
  if (!chain.ok) {
    fail(
      '合集 ' + entry.id + ' 的 EEC 证书不是由 ' + display(rootCaPath) + ' 签发: ' + String(chain.reason)
    )
  }
  const info = describeCertificate(certPath)
  if (!hasDigitalSignature(info.keyUsage)) {
    fail('合集 ' + entry.id + ' 的 EEC 证书缺少 digitalSignature 用途,不能用于 CMS 签名')
  }
  if (info.isCa === true) {
    fail('合集 ' + entry.id + ' 的 EEC 证书 basicConstraints 为 CA:TRUE,不能作为终端签名证书')
  }
  if (!info.validNow) {
    fail('合集 ' + entry.id + ' 的 EEC 证书已过期: ' + String(info.notAfter))
  }
  const commonName = (String(info.subject).match(/CN\s*=\s*([^,]+)/) || [])[1]
  if (commonName !== undefined && commonName.trim() !== entry.id) {
    console.warn(
      '[build-online-data] 警告: 合集 ' + entry.id + ' 的 EEC 证书 CN 为 ' + commonName.trim() + ',与合集名不一致'
    )
  }
  return { certPath, info }
}

/** 校验网页 EEC: 由根证书签发、可签名、不是 CA、未过期 */
const checkWebEec = (certPath, rootCaPath) => {
  const absolute = path.resolve(certPath)
  if (!isFile(absolute)) {
    fail('网页 EEC 证书不存在: ' + display(absolute))
  }
  const chain = verifyChain(absolute, rootCaPath)
  if (!chain.ok) {
    fail('网页 EEC 证书不是由 ' + display(rootCaPath) + ' 签发: ' + String(chain.reason))
  }
  const info = describeCertificate(absolute)
  if (!hasDigitalSignature(info.keyUsage)) {
    fail('网页 EEC 证书缺少 digitalSignature 用途,不能用于 CMS 签名')
  }
  if (info.isCa === true) {
    fail('网页 EEC 证书 basicConstraints 为 CA:TRUE,不能作为终端签名证书')
  }
  if (!info.validNow) {
    fail('网页 EEC 证书已过期: ' + String(info.notAfter))
  }
  return absolute
}

/** 清理旧结构留下的文件;不认识的残留只告警,不删除 */
const cleanLegacy = (outDir, keepIds) => {
  const removed = []
  for (const name of LEGACY_ROOT_FILES) {
    const target = path.join(outDir, name)
    if (isFile(target)) {
      rmSync(target, { force: true })
      removed.push(name)
    }
  }
  const collectionsDir = path.join(outDir, 'collections')
  if (!isDirectory(collectionsDir)) {
    return removed
  }
  for (const entry of readdirSync(collectionsDir, { withFileTypes: true })) {
    const target = path.join(collectionsDir, entry.name)
    if (!entry.isDirectory()) {
      continue
    }
    for (const name of LEGACY_COLLECTION_FILES) {
      const legacyFile = path.join(target, name)
      if (isFile(legacyFile)) {
        rmSync(legacyFile, { force: true })
        removed.push('collections/' + entry.name + '/' + name)
      }
    }
    if (keepIds.has(entry.name)) {
      continue
    }
    const left = readdirSync(target)
    if (left.every((name) => name === EEC_FILE)) {
      rmSync(target, { recursive: true, force: true })
      removed.push('collections/' + entry.name + '/')
      continue
    }
    if (left.length > 0) {
      console.warn('[build-online-data] 警告: collections/' + entry.name + ' 不在本次清单内,但含未识别文件,保留不删')
    }
  }
  return removed
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (options.out === '') {
    fail('缺少 --out 参数' + '\n' + USAGE)
  }
  if (options.rootCa === '') {
    fail('缺少 --root-ca 参数' + '\n' + USAGE)
  }
  if (options.eec.length === 0) {
    fail('缺少 --eec 参数,至少需要一个合集' + '\n' + USAGE)
  }

  const rootCaPath = path.resolve(options.rootCa)
  checkRootCa(rootCaPath)

  let crlPath = ''
  if (options.crl !== '') {
    crlPath = path.resolve(options.crl)
    if (!isFile(crlPath)) {
      fail('CRL 不存在: ' + display(crlPath))
    }
    const crlCheck = verifyCrlIssuer(crlPath, rootCaPath)
    if (!crlCheck.ok) {
      fail('CRL 不是由 ' + display(rootCaPath) + ' 签发: ' + String(crlCheck.reason))
    }
  }

  let webEecPath = ''
  if (options.webEec !== '') {
    webEecPath = checkWebEec(options.webEec, rootCaPath)
  }

  const seen = new Map()
  const entries = []
  for (const entry of options.eec) {
    if (!ID_PATTERN.test(entry.id)) {
      fail('合集名 ' + entry.id + ' 不能作为合集 id: 只允许字母、数字、点、下划线与连字符,且不能以符号开头')
    }
    if (seen.has(entry.id)) {
      fail('合集 id 重复: ' + entry.id)
    }
    seen.set(entry.id, true)
    entries.push({ id: entry.id, ...checkEec(entry, rootCaPath) })
  }

  const outDir = path.resolve(options.out)
  mkdirSync(outDir, { recursive: true })

  const removed = cleanLegacy(outDir, new Set(entries.map((entry) => entry.id)))
  if (options.crl === '' && isFile(path.join(outDir, CRL_FILE))) {
    rmSync(path.join(outDir, CRL_FILE), { force: true })
    removed.push(CRL_FILE)
  }

  copyFileSync(rootCaPath, path.join(outDir, ROOT_CA_FILE))
  if (crlPath !== '') {
    copyFileSync(crlPath, path.join(outDir, CRL_FILE))
  }

  // 网页 EEC 供网页运行时校验证书链使用;本次没给时清掉上一轮留下的旧证书
  const webEecTarget = path.join(outDir, 'web', EEC_FILE)
  if (webEecPath === '') {
    if (isFile(webEecTarget)) {
      rmSync(webEecTarget, { force: true })
      removed.push(WEB_EEC_PATH)
    }
  } else {
    mkdirSync(path.dirname(webEecTarget), { recursive: true })
    copyFileSync(webEecPath, webEecTarget)
  }

  const collections = []
  for (const entry of entries) {
    const targetDir = path.join(outDir, 'collections', entry.id)
    mkdirSync(targetDir, { recursive: true })
    copyFileSync(entry.certPath, path.join(targetDir, EEC_FILE))
    collections.push({ id: entry.id, eec: 'collections/' + entry.id + '/' + EEC_FILE })
  }

  const index = {
    schemaVersion: SCHEMA_VERSION,
    rootCa: ROOT_CA_FILE,
    crl: crlPath === '' ? null : CRL_FILE,
    collections,
  }
  writeFileSync(path.join(outDir, INDEX_FILE), JSON.stringify(index, null, 2) + '\n', 'utf8')

  console.log('[build-online-data] 输出目录: ' + display(outDir))
  console.log('[build-online-data] 已写出: ' + ROOT_CA_FILE + '(根证书)')
  console.log(
    '[build-online-data] 已写出: ' + (crlPath === '' ? '(无 CRL)' : CRL_FILE + '(吊销列表)')
  )
  console.log(
    '[build-online-data] 已写出: ' + (webEecPath === '' ? '(无网页 EEC)' : WEB_EEC_PATH + '(网页签名证书)')
  )
  for (const entry of entries) {
    console.log('[build-online-data] 合集 ' + entry.id + ': EEC 由根证书签发,自检通过')
  }
  console.log('[build-online-data] 已写出: ' + INDEX_FILE + '(' + entries.length + ' 个合集)')
  if (removed.length > 0) {
    console.log('[build-online-data] 已清理旧结构文件: ' + removed.join('、'))
  }
}

try {
  main()
} catch (error) {
  const message = error instanceof PkiError ? error.message : error instanceof Error ? error.message : String(error)
  console.error('[build-online-data] ' + message)
  process.exit(1)
}
