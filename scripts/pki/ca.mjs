#!/usr/bin/env node
/**
 * 根证书机构(CA)命令行工具。
 *
 * 本仓库在 PKI 中承担根 CA 角色: 持有根私钥(离线,不入库)、签发终端签名证书(EEC)、
 * 分发根证书与吊销列表。密码学运算全部交给 OpenSSL,本脚本只负责参数解析、目录布局、
 * 自检与错误汇总;底层封装见同目录 pki.mjs。
 *
 * 约定见 .agents/signing-conventions.md:
 * - 根 CA 密钥 Ed25519,自签名,有效期 3650 天
 * - EEC 密钥 ECDSA P-256,由根 CA 签发,有效期 365 天
 * - 合集与网页签名 openssl cms -sign -binary -nocerts -noattr,产出 <文件>.sig
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EEC_CERT_FILE,
  LEGACY_EEC_CERT_FILE,
  ROOT_CA_FILE,
  ROOT_CA_KEY_FILE,
  PkiError,
  certMatchesKey,
  certsLayoutPath,
  cmsSignaturePath,
  describeCertificate,
  genRootCa,
  hasDigitalSignature,
  issueEec,
  requireOpenssl,
  resolveEecCertPath,
  signFileCms,
  verifyChain,
  verifyFileCms,
} from './pki.mjs'

/** 需要 CMS 签名的文件扩展名 */
const SIGNED_EXTENSIONS = new Set(['.html', '.js', '.css'])
/** 网页清单文件名,记录本次签名的全部网页产物 */
const WEB_MANIFEST_FILE = 'web_files.json'
/** 网页清单结构版本 */
const WEB_MANIFEST_SCHEMA = 1
/** 根私钥路径环境变量 */
const ROOT_SECRET_ENV = 'ROOT_CA_SECRET'
/** 根证书路径环境变量 */
const ROOT_CERT_ENV = 'ROOT_CA_CERT'
/** 根证书有效期(天) */
const ROOT_DAYS = 3650
/** EEC 证书有效期(天) */
const EEC_DAYS = 365
/** 仓库根目录,用于拦截把根私钥写进被追踪路径的操作 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** 仓库内允许临时存放私钥的目录,全部是 git 忽略项 */
const PRIVATE_KEY_ALLOWED_DIRS = ['temp', 'tmp', '.agent', '.agents', 'single-branch', 'dist', 'build', 'node_modules', '.cache', '.pnpm-store']

const USAGE = [
  '用法: node scripts/pki/ca.mjs <子命令> [选项]',
  '',
  '子命令:',
  '  init-root   生成 ECDSA P-256 根私钥与自签名根证书',
  '  issue-eec   用根私钥签发终端签名证书(EEC)',
  '  sign-web    对目录下的 .html/.js/.css 生成 CMS 分离签名',
  '  verify-web  用根证书与目录内的 EEC 证书校验全部签名',
  '  gen-crl     生成证书吊销列表(CRL)',
  '',
  '各子命令的选项用 --help 查看。',
  '',
  '在 pnpm 中调用: pnpm run pki -- <子命令> [选项]',
].join('\n')

const USAGES = {
  'init-root': [
    '用法: node scripts/pki/ca.mjs init-root --dir <目录> [--days <天数>] [--org <O>] [--name <CN>] [--force]',
    '',
    '  --dir <目录>    输出目录,写 root_secret.pem 与 root_ca.crt',
    '  --days <天数>   根证书有效期,默认 ' + ROOT_DAYS,
    '  --org <O>       证书 O 字段,默认 omds-chat',
    '  --name <CN>     证书 CN 字段,默认 omds-chat Root CA',
    '  --force         目标目录已有根私钥或根证书时覆盖',
    '',
    '根私钥只写到 --dir 指定的目录: 该目录必须位于仓库之外,或位于仓库内被 git 忽略的目录',
    '(' + PRIVATE_KEY_ALLOWED_DIRS.join(' ') + ')。',
  ].join('\n'),
  'issue-eec': [
    '用法: node scripts/pki/ca.mjs issue-eec --csr <文件> --out <文件> [--days <天数>] [--force]',
    '',
    '  --csr <文件>    EEC 证书签名请求,公钥必须是 ECDSA P-256',
    '  --out <文件>    输出的 EEC 证书',
    '  --days <天数>   证书有效期,默认 ' + EEC_DAYS,
    '  --force         输出文件已存在时覆盖',
    '',
    '环境变量:',
    '  ' + ROOT_SECRET_ENV + '   根私钥路径',
    '  ' + ROOT_CERT_ENV + '     根证书路径',
  ].join('\n'),
  'sign-web': [
    '用法: node scripts/pki/ca.mjs sign-web --dir <目录> --eec <证书> --key <私钥>',
    '',
    '  --dir <目录>    待签名目录,默认 dist;递归处理全部 .html/.js/.css',
    '  --eec <证书>    EEC 证书',
    '  --key <私钥>    EEC 私钥',
    '',
    '每个 .html/.js/.css 生成 <文件>.sig(CMS 分离签名, -binary),同时写出 ' + WEB_MANIFEST_FILE,
    '记录全部已签名文件(按路径排序)并对其单独签名;EEC 证书按 certs 布局写成',
    '<目录>/' + EEC_CERT_FILE + ',供 verify-web 与网页校验直接取用。',
    '目标目录若留有旧布局的 <目录>/' + LEGACY_EEC_CERT_FILE + ',本子命令报错要求先删除,',
    '不再产出也不再覆盖旧布局的证书。',
  ].join('\n'),
  'verify-web': [
    '用法: node scripts/pki/ca.mjs verify-web --dir <目录> --root-ca <根证书> [--eec <证书>] [--crl <吊销列表>]',
    '',
    '  --dir <目录>      待校验目录',
    '  --root-ca <证书>  根证书,作为信任锚',
    '  --eec <证书>      EEC 证书,默认 <目录>/' + EEC_CERT_FILE + ';',
    '                    旧布局的 <目录>/' + LEGACY_EEC_CERT_FILE + ' 只作兼容回退',
    '  --crl <文件>      吊销列表,给出时同时做吊销检查',
    '',
    '先校验证书链,再逐文件校验 .sig;缺失签名与孤儿签名都计入失败清单。',
    '存在任何失败时以非零状态退出。',
  ].join('\n'),
  'gen-crl': [
    '用法: node scripts/pki/ca.mjs gen-crl --out <文件> --days <天数> [--revoke <序列号> ...] [--force]',
    '',
    '  --out <文件>     输出的 CRL 文件',
    '  --days <天数>    CRL 有效期',
    '  --revoke <序列号> 被吊销证书的序列号,可重复给出;支持十六进制与冒号分隔写法',
    '  --force          输出文件已存在时覆盖',
    '',
    '环境变量:',
    '  ' + ROOT_SECRET_ENV + '   根私钥路径',
    '  ' + ROOT_CERT_ENV + '     根证书路径',
  ].join('\n'),
}

const fail = (message) => {
  throw new Error(message)
}

/** 解析选项: 支持 "--名字 值" 与 "--名字=值";flag 型不接受值;list 型可重复 */
const parseOptions = (argv, spec) => {
  const options = {}
  const positional = []
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
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const equal = arg.indexOf('=')
    const name = equal === -1 ? arg.slice(2) : arg.slice(2, equal)
    const inlineValue = equal === -1 ? undefined : arg.slice(equal + 1)
    const kind = spec[name]
    if (kind === undefined) {
      fail('未知选项 --' + name + '\n' + USAGE)
    }
    if (kind === 'flag') {
      if (inlineValue !== undefined) {
        fail('选项 --' + name + ' 不接受值')
      }
      options[name] = true
      continue
    }
    const value = inlineValue === undefined ? argv[index + 1] : inlineValue
    if (value === undefined || value === '' || (inlineValue === undefined && value.startsWith('-'))) {
      fail('选项 --' + name + ' 缺少值')
    }
    if (inlineValue === undefined) {
      index += 1
    }
    if (kind === 'list') {
      if (options[name] === undefined) {
        options[name] = []
      }
      options[name].push(value)
      continue
    }
    if (options[name] !== undefined) {
      fail('选项 --' + name + ' 重复给出')
    }
    options[name] = value
  }
  return { options, positional }
}

const requireOption = (options, name) => {
  const value = options[name]
  if (value === undefined || value === '') {
    fail('缺少必需选项 --' + name + '\n' + USAGE)
  }
  return value
}

const parseDays = (value, fallback, label) => {
  if (value === undefined) {
    if (fallback === null) {
      fail('缺少必需选项 ' + label)
    }
    return fallback
  }
  const days = Number(value)
  if (!Number.isInteger(days) || days <= 0) {
    fail(label + ' 必须是正整数,收到 ' + value)
  }
  return days
}

/** 路径展示: 工作目录内用相对路径 */
const display = (target) => {
  const relativePath = relative(process.cwd(), target)
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return target
  }
  return relativePath
}

const requireDir = (target, label) => {
  let info = null
  try {
    info = statSync(target)
  } catch {
    info = null
  }
  if (info === null || !info.isDirectory()) {
    fail(label + ' 不存在或不是目录: ' + display(target))
  }
  return target
}

const requireFile = (target, label) => {
  let info = null
  try {
    info = statSync(target)
  } catch {
    info = null
  }
  if (info === null || !info.isFile()) {
    fail(label + ' 不存在: ' + display(target))
  }
  return target
}

/** 从环境变量取文件路径;未设置或文件不存在时给出明确提示 */
const requireEnvFile = (name) => {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    fail('缺少环境变量 ' + name + ',请把它设置为对应的文件路径')
  }
  return requireFile(resolve(value.trim()), '环境变量 ' + name + ' 指向的文件')
}

/**
 * 拦截把根私钥写进仓库被追踪路径的操作。
 * 仓库外的目录一律允许;仓库内的目录只允许 git 忽略项。
 */
const assertKeyLocationAllowed = (dir) => {
  const relativePath = relative(REPO_ROOT, dir)
  if (relativePath === '') {
    fail('根私钥不得直接写入仓库根目录: ' + display(dir) + ',请改用仓库外的目录或仓库内的临时目录')
  }
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('..' + sep)) {
    return
  }
  const first = relativePath.split(sep)[0]
  if (PRIVATE_KEY_ALLOWED_DIRS.includes(first)) {
    return
  }
  fail(
    '根私钥不得写入仓库被追踪的路径: ' +
      display(dir) +
      ',请改用仓库外的目录或仓库内的 ' +
      PRIVATE_KEY_ALLOWED_DIRS.join('、') +
      ' 之一'
  )
}

/** 递归列出目录内的文件,返回相对路径(正斜杠) */
const listFiles = (dir, prefix = '') => {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.isDirectory()) {
      files.push(...listFiles(join(dir, entry.name), relativePath))
    } else if (entry.isFile()) {
      files.push(relativePath)
    }
  }
  return files
}

const toAbsolute = (dir, relativePath) => join(dir, ...relativePath.split('/'))

const isSignedFile = (relativePath) => SIGNED_EXTENSIONS.has(extname(relativePath).toLowerCase())

/** 跑一次 openssl,失败返回 stderr,不抛错 */
const opensslQuiet = (args) => {
  try {
    const stdout = execFileSync(process.env.OPENSSL_BIN || 'openssl', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, text: String(stdout) }
  } catch (error) {
    const text = String((error && error.stderr) || '') || String((error && error.message) || '')
    return { ok: false, text }
  }
}

/**
 * 要求 CSR 的公钥是 ECDSA P-256。
 * OpenSSL 的 CMS 实现无法用 Ed25519 签名(provider signature failure),因此 EEC 密钥固定为 P-256。
 */
const assertCsrKeyIsEcP256 = (csrPath) => {
  const result = opensslQuiet(['req', '-in', csrPath, '-noout', '-text'])
  if (!result.ok) {
    fail('无法读取 CSR: ' + display(csrPath) + ': ' + result.text.split('\n').slice(0, 2).join(' '))
  }
  const text = result.text
  const isEc = /Public Key Algorithm:\s*id-ecPublicKey/i.test(text)
  const isP256 = /NIST CURVE:\s*P-256/i.test(text) || /ASN1 OID:\s*prime256v1/i.test(text)
  if (!isEc || !isP256) {
    const algorithm = (text.match(/Public Key Algorithm:\s*(\S+)/i) || [])[1] || '未知'
    fail(
      'CSR 的公钥算法为 ' +
        algorithm +
        ',要求 ECDSA P-256: OpenSSL 的 CMS 实现无法用 Ed25519 私钥签名,签出的 EEC 无法用于合集签名'
    )
  }
}

const printCertificate = (certPath) => {
  const info = describeCertificate(certPath)
  console.log('[pki] 证书: ' + display(certPath))
  console.log('[pki]   subject: ' + String(info.subject))
  console.log('[pki]   issuer: ' + String(info.issuer))
  console.log('[pki]   serial: ' + String(info.serial))
  console.log('[pki]   有效期: ' + String(info.notBefore) + ' -> ' + String(info.notAfter))
  console.log('[pki]   keyUsage: ' + (info.keyUsage.length === 0 ? '(无)' : info.keyUsage.join(',')))
  console.log('[pki]   CA: ' + (info.isCa === null ? '(未声明)' : info.isCa ? 'TRUE' : 'FALSE'))
  console.log('[pki]   sha256: ' + String(info.fingerprint))
  return info
}

/** init-root: 生成 ECDSA P-256 根私钥与自签名根证书 */
const initRoot = (argv) => {
  const { options } = parseOptions(argv, { dir: 'value', days: 'value', org: 'value', name: 'value', force: 'flag' })
  if (options.help) {
    console.log(USAGES['init-root'])
    return
  }
  const dir = resolve(requireOption(options, 'dir'))
  const days = parseDays(options.days, ROOT_DAYS, '--days')
  assertKeyLocationAllowed(dir)
  const keyPath = join(dir, ROOT_CA_KEY_FILE)
  const certPath = join(dir, ROOT_CA_FILE)
  if (!options.force && (existsSync(keyPath) || existsSync(certPath))) {
    fail('目标目录已存在根私钥或根证书: ' + display(dir) + ',确认覆盖时加 --force')
  }
  const result = genRootCa(dir, { days, org: options.org, name: options.name })
  console.log('[pki] 已生成根私钥: ' + display(result.keyPath))
  console.log('[pki] 已生成根证书: ' + display(result.certPath))
  printCertificate(result.certPath)
  console.log('[pki] 根私钥不得提交、不得随产物分发;签完 EEC 后应删除或离线保管')
}

/** issue-eec: 用根私钥签发 EEC 证书 */
const issueEecCommand = (argv) => {
  const { options } = parseOptions(argv, { csr: 'value', out: 'value', days: 'value', force: 'flag' })
  if (options.help) {
    console.log(USAGES['issue-eec'])
    return
  }
  const csrPath = resolve(requireOption(options, 'csr'))
  const outPath = resolve(requireOption(options, 'out'))
  const days = parseDays(options.days, EEC_DAYS, '--days')
  requireFile(csrPath, 'CSR')
  if (!options.force && existsSync(outPath)) {
    fail('输出文件已存在: ' + display(outPath) + ',确认覆盖时加 --force')
  }
  const secretPath = requireEnvFile(ROOT_SECRET_ENV)
  const certPath = requireEnvFile(ROOT_CERT_ENV)
  assertCsrKeyIsEcP256(csrPath)
  const issued = issueEec(csrPath, certPath, secretPath, outPath, { days })
  const chain = verifyChain(issued, certPath)
  if (!chain.ok) {
    fail('签发后证书链自检未通过: ' + String(chain.reason))
  }
  console.log('[pki] 已用根证书 ' + display(certPath) + ' 签发: ' + display(issued))
  const info = printCertificate(issued)
  if (!hasDigitalSignature(info.keyUsage)) {
    fail('签发的证书缺少 digitalSignature 用途,不能用于 CMS 签名')
  }
  console.log('[pki] 证书链自检通过;私钥只保留在申请方,本工具不产出 EEC 私钥')
}

/** sign-web: 对目录下的 .html/.js/.css 生成 CMS 分离签名 */
const signWeb = (argv) => {
  const { options } = parseOptions(argv, { dir: 'value', eec: 'value', key: 'value' })
  if (options.help) {
    console.log(USAGES['sign-web'])
    return
  }
  const dir = resolve(options.dir === undefined ? 'dist' : options.dir)
  const eecPath = resolve(requireOption(options, 'eec'))
  const keyPath = resolve(requireOption(options, 'key'))
  requireDir(dir, '待签名目录')
  requireFile(eecPath, 'EEC 证书')
  requireFile(keyPath, 'EEC 私钥')
  if (!certMatchesKey(eecPath, keyPath)) {
    fail('EEC 证书与私钥不配对: ' + display(eecPath) + ' 与 ' + display(keyPath))
  }
  // 旧布局把证书放在产物根目录,与 certs 布局并存会让打包带上两份可能不同步的证书,
  // 因此这里要求先迁移,而不是静默覆盖或忽略
  const legacyEec = join(dir, LEGACY_EEC_CERT_FILE)
  if (existsSync(legacyEec)) {
    fail(
      '目标目录存在旧布局的证书 ' +
        display(legacyEec) +
        ': sign-web 只写出 ' +
        EEC_CERT_FILE +
        ',请先删除该文件再签名,迁移说明见 docs/user/develop/basic/web-signature.md'
    )
  }
  const files = listFiles(dir).filter(isSignedFile).sort()
  if (files.length === 0) {
    fail('目录下没有可签名的 .html/.js/.css 文件: ' + display(dir))
  }
  for (const file of files) {
    signFileCms(toAbsolute(dir, file), eecPath, keyPath)
  }
  // 清单只列被逐文件签名的产物,清单自身不在其中,它的签名单独生成
  const manifestPath = join(dir, WEB_MANIFEST_FILE)
  writeFileSync(
    manifestPath,
    JSON.stringify({ schemaVersion: WEB_MANIFEST_SCHEMA, files }, null, 2) + '\n',
    'utf8'
  )
  signFileCms(manifestPath, eecPath, keyPath)
  const targetEec = certsLayoutPath(dir, EEC_CERT_FILE)
  if (resolve(targetEec) !== eecPath) {
    mkdirSync(dirname(targetEec), { recursive: true })
    copyFileSync(eecPath, targetEec)
  }
  console.log('[pki] 目录: ' + display(dir))
  console.log('[pki] 已签名 ' + files.length + ' 个文件,输出 <文件>.sig(CMS 分离签名, -binary)')
  console.log('[pki] 已写出清单 ' + display(manifestPath) + ' 及其签名 ' + display(manifestPath) + '.sig')
  console.log('[pki] 已写出 EEC 证书: ' + display(targetEec))
}

/**
 * 带吊销检查的证书链校验。
 * openssl cms 在 OpenSSL 3.5 没有 -CRLfile 选项,CRL 只能随证书一起放进 -CAfile 指向的证书库,
 * 因此这里先把根证书与 CRL 拼成 bundle,再追加 -crl_check。
 */
const verifyChainWithCrl = (certPath, bundlePath) => {
  const result = opensslQuiet(['verify', '-CAfile', bundlePath, '-crl_check', certPath])
  if (result.ok) {
    return { ok: true, reason: null }
  }
  const lines = result.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('error'))
  return { ok: false, reason: lines.slice(0, 2).join(' ') || 'openssl verify 失败' }
}

/** 带吊销检查的 CMS 分离签名验签,参数含义同 pki.mjs 的 verifyFileCms */
const verifyFileCmsWithCrl = (filePath, sigPath, bundlePath, eecPath) => {
  if (!existsSync(filePath)) {
    return { ok: false, reason: '被签名文件不存在: ' + display(filePath) }
  }
  if (!existsSync(sigPath)) {
    return { ok: false, reason: '签名文件不存在: ' + display(sigPath) }
  }
  const result = opensslQuiet([
    'cms', '-verify', '-binary', '-inform', 'DER', '-in', sigPath, '-content', filePath,
    '-CAfile', bundlePath, '-certfile', eecPath, '-crl_check',
  ])
  if (result.ok) {
    return { ok: true, reason: null }
  }
  const lines = result.text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return { ok: false, reason: lines.slice(0, 2).join(' ') || 'openssl cms -verify 失败' }
}

/** 读取网页清单里列出的文件;文件缺失或结构不符返回空数组 */
const readWebManifest = (manifestPath) => {
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.files)) {
    return []
  }
  return parsed.files.filter((item) => typeof item === 'string')
}

/** verify-web: 校验目录内全部签名 */
const verifyWeb = (argv) => {
  const { options } = parseOptions(argv, { dir: 'value', 'root-ca': 'value', eec: 'value', crl: 'value' })
  if (options.help) {
    console.log(USAGES['verify-web'])
    return
  }
  const dir = resolve(requireOption(options, 'dir'))
  const rootCa = resolve(requireOption(options, 'root-ca'))
  requireDir(dir, '待校验目录')
  requireFile(rootCa, '根证书')
  let eecPath = ''
  if (options.eec === undefined) {
    const located = resolveEecCertPath(dir)
    eecPath = located.path
    if (!existsSync(eecPath)) {
      fail(
        '目录内没有 EEC 证书: 缺少 ' +
          display(certsLayoutPath(dir, EEC_CERT_FILE)) +
          ',旧布局的 ' +
          display(join(dir, LEGACY_EEC_CERT_FILE)) +
          ' 也不存在'
      )
    }
    if (located.legacy) {
      console.log('[pki] 提示: 目录内只有旧布局的证书 ' + display(eecPath) + ',已按兼容回退使用')
    }
  } else {
    eecPath = resolve(options.eec)
  }
  requireFile(eecPath, 'EEC 证书')

  const checkCrl = options.crl !== undefined
  let workDir = null
  let caFile = rootCa
  if (checkCrl) {
    const crlPath = requireFile(resolve(options.crl), 'CRL')
    workDir = mkdtempSync(join(tmpdir(), 'dsc-pki-bundle-'))
    caFile = join(workDir, 'bundle.pem')
    const bundleText =
      readFileSync(rootCa, 'utf8').trimEnd() + '\n' + readFileSync(crlPath, 'utf8').trimEnd() + '\n'
    writeFileSync(caFile, bundleText, 'utf8')
  }

  const failures = []
  try {
    const chain = checkCrl ? verifyChainWithCrl(eecPath, caFile) : verifyChain(eecPath, rootCa)
    if (!chain.ok) {
      failures.push({ file: display(eecPath), reason: '证书链校验失败: ' + String(chain.reason) })
    }

    const files = listFiles(dir).filter(isSignedFile).sort()
    for (const file of files) {
      const absolute = toAbsolute(dir, file)
      const result = checkCrl
        ? verifyFileCmsWithCrl(absolute, cmsSignaturePath(absolute), caFile, eecPath)
        : verifyFileCms(absolute, cmsSignaturePath(absolute), rootCa, eecPath)
      if (!result.ok) {
        failures.push({ file, reason: String(result.reason) })
      }
    }

    // 清单签名通过后,清单里列出的文件必须都在,且各自都有签名
    const manifestPath = join(dir, WEB_MANIFEST_FILE)
    if (existsSync(manifestPath)) {
      const manifestResult = checkCrl
        ? verifyFileCmsWithCrl(manifestPath, cmsSignaturePath(manifestPath), caFile, eecPath)
        : verifyFileCms(manifestPath, cmsSignaturePath(manifestPath), rootCa, eecPath)
      if (!manifestResult.ok) {
        failures.push({ file: WEB_MANIFEST_FILE, reason: '清单签名校验失败: ' + String(manifestResult.reason) })
      } else {
        for (const file of readWebManifest(manifestPath)) {
          if (!existsSync(toAbsolute(dir, file))) {
            failures.push({ file, reason: '清单列出的文件不存在' })
          } else if (!existsSync(cmsSignaturePath(toAbsolute(dir, file)))) {
            failures.push({ file, reason: '清单列出的文件缺少签名' })
          }
        }
      }
    }

    // 孤儿签名: 对应的文件已不存在,同样视为失败
    for (const file of listFiles(dir).filter((item) => item.endsWith('.sig')).sort()) {
      const target = file.slice(0, -'.sig'.length)
      if (!existsSync(toAbsolute(dir, target))) {
        failures.push({ file, reason: '签名对应的文件不存在' })
      }
    }

    console.log('[pki] 目录: ' + display(dir))
    console.log('[pki] 根证书: ' + display(rootCa))
    console.log('[pki] EEC 证书: ' + display(eecPath))
    console.log('[pki] 吊销检查: ' + (checkCrl ? '已启用' : '未启用'))
    console.log('[pki] 已校验 ' + files.length + ' 个签名文件,失败 ' + failures.length + ' 项')
    if (failures.length > 0) {
      console.log('[pki] 失败清单:')
      for (const item of failures) {
        console.log('[pki]   ' + item.file + ' -> ' + item.reason)
      }
      process.exitCode = 1
      return
    }
    console.log('[pki] 全部签名校验通过')
  } finally {
    if (workDir !== null) {
      rmSync(workDir, { recursive: true, force: true })
    }
  }
}

/** 把序列号统一成 index.txt 使用的十六进制大写形式 */
const normalizeSerial = (value) => {
  const text = String(value).trim().replace(/^0x/i, '').replace(/[:\s]/g, '').toUpperCase()
  if (text === '' || !/^[0-9A-F]+$/.test(text)) {
    fail('序列号必须是十六进制: ' + String(value))
  }
  return text.length % 2 === 0 ? text : '0' + text
}

/** index.txt 与 CRL 使用的时间格式: YYMMDDHHMMSSZ */
const utcStamp = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    String(date.getUTCFullYear()).slice(2) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  )
}

/** 被吊销证书的到期时间: CRL 只需要一个晚于吊销时间的占位值,取 2049 年 */
const REVOKED_EXPIRY = '491231235959Z'

const toConfigPath = (target) => target.replace(/\\/g, '/')

/**
 * gen-crl: 用 openssl ca -gencrl 生成 CRL。
 * OpenSSL 3.5 已移除 crl -gen,只能走 ca 子命令;ca 要求 index.txt、serial、crlnumber 齐备,
 * 因此这里自建最小 CA 目录。
 */
const genCrl = (argv) => {
  const { options } = parseOptions(argv, { out: 'value', days: 'value', revoke: 'list', force: 'flag' })
  if (options.help) {
    console.log(USAGES['gen-crl'])
    return
  }
  const outPath = resolve(requireOption(options, 'out'))
  const days = parseDays(options.days, null, '--days')
  if (!options.force && existsSync(outPath)) {
    fail('输出文件已存在: ' + display(outPath) + ',确认覆盖时加 --force')
  }
  const secretPath = requireEnvFile(ROOT_SECRET_ENV)
  const certPath = requireEnvFile(ROOT_CERT_ENV)
  const serials = []
  for (const value of options.revoke === undefined ? [] : options.revoke) {
    const serial = normalizeSerial(value)
    if (!serials.includes(serial)) {
      serials.push(serial)
    }
  }

  const workDir = mkdtempSync(join(tmpdir(), 'dsc-pki-crl-'))
  try {
    const now = utcStamp()
    const indexLines = serials.map((serial) =>
      ['R', REVOKED_EXPIRY, now, serial, 'unknown', '/CN=revoked-' + serial].join('\t')
    )
    writeFileSync(join(workDir, 'index.txt'), indexLines.length === 0 ? '' : indexLines.join('\n') + '\n', 'utf8')
    writeFileSync(join(workDir, 'serial'), '1000\n', 'utf8')
    writeFileSync(join(workDir, 'crlnumber'), '1000\n', 'utf8')
    const configPath = join(workDir, 'openssl.cnf')
    writeFileSync(
      configPath,
      [
        '[ ca ]',
        'default_ca = CA_default',
        '',
        '[ CA_default ]',
        'dir               = ' + toConfigPath(workDir),
        'database          = $dir/index.txt',
        'crlnumber         = $dir/crlnumber',
        'serial            = $dir/serial',
        'certificate       = ' + toConfigPath(certPath),
        'private_key       = ' + toConfigPath(secretPath),
        '# default_md 显式指定 sha512,避免 OpenSSL 默认值漂移',
        'default_md        = sha512',
        'crl_extensions    = crl_ext',
        'default_crl_days  = ' + String(days),
        'unique_subject    = no',
        '',
        '[ crl_ext ]',
        'authorityKeyIdentifier = keyid:always',
        '',
      ].join('\n'),
      'utf8'
    )
    const result = opensslQuiet(['ca', '-gencrl', '-batch', '-config', configPath, '-out', outPath, '-crldays', String(days)])
    if (!result.ok) {
      fail('openssl ca -gencrl 失败: ' + result.text.split('\n').slice(0, 3).join(' '))
    }
    if (!existsSync(outPath)) {
      fail('openssl ca 未生成 CRL: ' + display(outPath))
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }

  const info = opensslQuiet(['crl', '-in', outPath, '-noout', '-text'])
  if (!info.ok) {
    fail('生成的 CRL 无法解析: ' + display(outPath))
  }
  const issuer = (info.text.match(/Issuer:\s*(.+)/) || [])[1]
  const nextUpdate = (info.text.match(/Next Update:\s*(.+)/) || [])[1]
  const revoked = (info.text.match(/Revoked Certificates:/g) || []).length
  console.log('[pki] 已生成 CRL: ' + display(outPath))
  console.log('[pki]   issuer: ' + String(issuer === undefined ? '(未解析)' : issuer.trim()))
  console.log('[pki]   下次更新: ' + String(nextUpdate === undefined ? '(未解析)' : nextUpdate.trim()))
  console.log('[pki]   吊销条目: ' + revoked + ' 条')
  if (serials.length > 0) {
    console.log('[pki]   吊销序列号: ' + serials.join('、'))
  }
}

const COMMANDS = {
  'init-root': initRoot,
  'issue-eec': issueEecCommand,
  'sign-web': signWeb,
  'verify-web': verifyWeb,
  'gen-crl': genCrl,
}

const main = () => {
  const rawArgs = process.argv.slice(2)
  // pnpm 把 -- 之后的参数原样转发时可能带上分隔符本身,这里先剥掉
  let cursor = 0
  while (cursor < rawArgs.length && rawArgs[cursor] === '--') {
    cursor += 1
  }
  const argv = rawArgs.slice(cursor)
  const name = argv[0]
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    console.log(USAGE)
    return
  }
  const command = COMMANDS[name]
  if (command === undefined) {
    fail('未知子命令 ' + name + '\n' + USAGE)
  }
  requireOpenssl()
  command(argv.slice(1))
}

try {
  main()
} catch (error) {
  if (error instanceof PkiError) {
    console.error('[pki] ' + error.message)
    if (error.command !== null) {
      console.error('[pki] 命令: ' + error.command)
    }
  } else {
    console.error('[pki] ' + (error instanceof Error ? error.message : String(error)))
  }
  process.exit(1)
}
