#!/usr/bin/env node
/**
 * 生成 online-data 分支的信任数据。
 * 由 WEB_PRIVATE_KEY 推导 dsc 公钥，为每个合集根目录的 plugin_secret.pub 签发信任签名，
 * 写出 web_public.pem、collections/<合集>/plugin_secret.pub、plugin_set_sign.json 与 index.json
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const PRIVATE_KEY_ENV = 'WEB_PRIVATE_KEY'
/** 合集根目录下的公钥文件；被签名对象 */
const PUB_FILE = 'plugin_secret.pub'
/** 合集信任签名文件名 */
const SET_SIGN_FILE = 'plugin_set_sign.json'
/** dsc 网页签名公钥文件名；内容由私钥推导 */
const WEB_PUB_FILE = 'web_public.pem'
/** 信任清单文件名 */
const INDEX_FILE = 'index.json'
/** 信任签名与信任清单固定的签名者标识 */
const SIGNER = 'dsc'
/** 信任清单结构版本 */
const SCHEMA_VERSION = 1
/** 合集 id 只允许安全字符，避免拼出越界路径 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const USAGE = [
  '用法: node scripts/build-online-data.mjs --out <目录> <合集目录>...',
  '',
  '  --out <目录>      输出目录，不存在时自动创建；已存在的同名文件直接覆盖',
  '  <合集目录>...     一个或多个插件合集根目录，每个目录必须存在 plugin_secret.pub',
  '  --help            打印用法',
  '',
  '环境变量:',
  '  WEB_PRIVATE_KEY   dsc 私钥（PKCS#8 PEM，Ed25519），用于推导公钥与签发信任签名',
  '',
  '在 pnpm 中传递参数时写作: pnpm run build:online-data -- --out <目录> <合集目录>...',
].join('\n')

const fail = (message) => {
  throw new Error(message)
}

/** 解析命令行参数：一个 --out 与至少一个合集目录 */
const parseArgs = (argv) => {
  const options = { out: '', collections: [], help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    // pnpm 传参时会插入一个单独的 -- 分隔符，直接忽略
    if (arg === '--') {
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      const value = arg === '--out' ? argv[index + 1] : arg.slice('--out='.length)
      if (value === undefined || value === '' || value.startsWith('-')) {
        fail('--out 缺少输出目录' + '\n' + USAGE)
      }
      options.out = value
      if (arg === '--out') {
        index += 1
      }
      continue
    }
    if (arg.startsWith('-')) {
      fail('未知选项 ' + arg + '\n' + USAGE)
    }
    options.collections.push(arg)
  }
  return options
}

/** 把路径转成便于阅读的形式：工作目录内的路径用相对路径 */
const display = (target) => {
  const relative = path.relative(process.cwd(), target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return target
  }
  return relative
}

const statOf = async (target) => {
  try {
    return await stat(target)
  } catch {
    return null
  }
}

/** PEM 统一为纯 ASCII 的 LF 文本，且以单个换行结尾 */
const normalizePem = (pem) => pem.replace(/\r\n?/g, '\n').trimEnd() + '\n'

/** 读取 dsc 私钥，确认存在且算法为 Ed25519 */
const readPrivateKey = () => {
  const pem = process.env[PRIVATE_KEY_ENV]
  if (!pem || pem.trim() === '') {
    fail(
      '缺少环境变量 ' +
        PRIVATE_KEY_ENV +
        '（PKCS#8 PEM 格式的 Ed25519 私钥），无法推导 dsc 公钥与签发合集信任签名；' +
        '该私钥属于 dsc，不应下发到合集仓库'
    )
  }
  let privateKey
  try {
    privateKey = createPrivateKey(pem)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    fail(PRIVATE_KEY_ENV + ' 不是有效的 PKCS#8 PEM 私钥：' + reason)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail(
      PRIVATE_KEY_ENV +
        ' 的算法为 ' +
        String(privateKey.asymmetricKeyType) +
        '，需要 Ed25519 私钥'
    )
  }
  return privateKey
}

/** 读取并校验合集公钥，返回文件字节；签名对象就是这些字节 */
const readCollectionPublicKey = async (pubPath) => {
  const info = await statOf(pubPath)
  if (info === null || !info.isFile()) {
    fail(
      '未找到 ' +
        display(pubPath) +
        '，合集根目录必须存在该文件（SPKI PEM 格式的 Ed25519 公钥）'
    )
  }
  const bytes = await readFile(pubPath)
  if (bytes.length === 0) {
    fail(display(pubPath) + ' 是空文件，无法作为合集公钥')
  }
  let publicKey
  try {
    publicKey = createPublicKey(bytes)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    fail(display(pubPath) + ' 无法解析为 SPKI 公钥：' + reason)
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail(
      display(pubPath) +
        ' 的算法为 ' +
        String(publicKey.asymmetricKeyType) +
        '，需要 Ed25519 SPKI 公钥'
    )
  }
  return bytes
}

/**
 * 为全部合集签名并自检。
 * 自检不通过时不写出任何文件；自检通过后由调用方统一写盘。
 */
const signCollections = async (privateKey, publicKey, collectionDirs) => {
  const entries = []
  const taken = new Map()
  for (const dir of collectionDirs) {
    const resolved = path.resolve(dir)
    const info = await statOf(resolved)
    if (info === null || !info.isDirectory()) {
      fail('合集目录不存在或不是目录：' + display(resolved))
    }
    const id = path.basename(resolved)
    if (!ID_PATTERN.test(id)) {
      fail(
        '合集目录名 ' +
          id +
          ' 不能作为合集 id：只允许字母、数字、点、下划线与连字符，且不能以符号开头'
      )
    }
    const duplicated = taken.get(id)
    if (duplicated !== undefined) {
      fail(
        '合集 id 重复：' +
          id +
          '，分别来自 ' +
          display(duplicated) +
          ' 与 ' +
          display(resolved) +
          '；合集 id 取自目录名，必须唯一'
      )
    }
    taken.set(id, resolved)
    const pubBytes = await readCollectionPublicKey(path.join(resolved, PUB_FILE))
    const digest = createHash('sha512').update(pubBytes).digest()
    const value = sign(null, digest, privateKey).toString('base64')
    if (!verify(null, digest, publicKey, Buffer.from(value, 'base64'))) {
      fail('合集 ' + id + ' 的信任签名自检未通过，未写出任何文件')
    }
    entries.push({ id, dir: resolved, pubBytes, value })
  }
  return entries
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (options.out === '') {
    fail('缺少 --out 参数' + '\n' + USAGE)
  }
  if (options.collections.length === 0) {
    fail('缺少合集目录参数，至少需要一个' + '\n' + USAGE)
  }

  const privateKey = readPrivateKey()
  const publicKey = createPublicKey(privateKey)
  const webPublicPem = normalizePem(
    publicKey.export({ type: 'spki', format: 'pem' }).toString()
  )

  // 先完成全部签名与自检，再统一写盘，避免失败时留下半套数据
  const entries = await signCollections(privateKey, publicKey, options.collections)

  const outDir = path.resolve(options.out)
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, WEB_PUB_FILE), webPublicPem, 'utf8')

  const collections = []
  for (const entry of entries) {
    const targetDir = path.join(outDir, 'collections', entry.id)
    await mkdir(targetDir, { recursive: true })
    // 公钥按原字节写出：信任签名覆盖的是这些字节，任何重新编码都会让签名失效
    await writeFile(path.join(targetDir, PUB_FILE), entry.pubBytes)
    await writeFile(
      path.join(targetDir, SET_SIGN_FILE),
      JSON.stringify({ sign: [{ value: entry.value, signer: SIGNER }] }, null, 2) + '\n',
      'utf8'
    )
    collections.push({
      id: entry.id,
      publicKey: 'collections/' + entry.id + '/' + PUB_FILE,
      trustSignature: 'collections/' + entry.id + '/' + SET_SIGN_FILE,
    })
  }

  const index = {
    schemaVersion: SCHEMA_VERSION,
    webPublicKey: WEB_PUB_FILE,
    collections,
  }
  await writeFile(path.join(outDir, INDEX_FILE), JSON.stringify(index, null, 2) + '\n', 'utf8')

  console.log('[build-online-data] 输出目录：' + display(outDir))
  console.log('[build-online-data] 已写出：' + WEB_PUB_FILE + '（dsc 公钥，SPKI PEM）')
  for (const entry of entries) {
    console.log(
      '[build-online-data] 合集 ' +
        entry.id +
        '：' +
        entry.pubBytes.length +
        ' 字节公钥，信任签名自检通过'
    )
  }
  console.log('[build-online-data] 已写出：' + INDEX_FILE + '（' + entries.length + ' 个合集）')
}

main().catch((error) => {
  console.error('[build-online-data] ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
})
