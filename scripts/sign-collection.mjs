#!/usr/bin/env node
/**
 * 合集信任签名：对合集根目录 plugin_secret.pub 的文件字节做 SHA-512 摘要，
 * 再用 dsc 私钥（WEB_PRIVATE_KEY）做 Ed25519 签名，产出 plugin_set_sign.json
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const PUB_FILE = 'plugin_secret.pub'
const SIGN_FILE = 'plugin_set_sign.json'
const SIGNER = 'dsc'
const PRIVATE_KEY_ENV = 'WEB_PRIVATE_KEY'

const USAGE = [
  '用法: node scripts/sign-collection.mjs <合集目录> [--out <输出路径>] [--force]',
  '',
  '  <合集目录>     插件合集根目录，其中必须存在 plugin_secret.pub',
  '  --out <路径>   签名输出路径，默认 <合集目录>/plugin_set_sign.json',
  '  --force        目标文件已存在时覆盖旧签名，默认拒绝覆盖',
  '',
  '在 pnpm 中传递参数时写作: pnpm run sign:collection -- <合集目录> [--out <路径>] [--force]',
].join('\n')

const fail = (message) => {
  throw new Error(message)
}

/** 解析命令行参数，位置参数只接受一个合集目录 */
const parseArgs = (argv) => {
  const options = { collectionDir: '', out: '', force: false, help: false }
  const positional = []
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
    if (arg === '--force') {
      options.force = true
      continue
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      const value = arg === '--out' ? argv[index + 1] : arg.slice('--out='.length)
      if (value === undefined || value === '' || value.startsWith('-')) {
        fail('--out 缺少输出路径' + '\n' + USAGE)
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
    positional.push(arg)
  }
  if (positional.length > 1) {
    fail('只接受一个合集目录，实际收到 ' + positional.length + ' 个位置参数' + '\n' + USAGE)
  }
  options.collectionDir = positional.length === 1 ? positional[0] : ''
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

const isFile = async (target) => {
  try {
    return (await stat(target)).isFile()
  } catch {
    return false
  }
}

/** 读取 dsc 私钥，确认存在且算法为 Ed25519 */
const readPrivateKey = () => {
  const pem = process.env[PRIVATE_KEY_ENV]
  if (!pem || pem.trim() === '') {
    fail(
      '缺少环境变量 ' +
        PRIVATE_KEY_ENV +
        '（PKCS#8 PEM 格式的 Ed25519 私钥），无法签发合集信任签名；' +
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

/** 读取并校验合集公钥，返回文件字节用于摘要 */
const readCollectionPublicKey = async (pubPath) => {
  if (!(await isFile(pubPath))) {
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

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (options.collectionDir === '') {
    fail('缺少合集目录参数' + '\n' + USAGE)
  }

  const collectionDir = path.resolve(options.collectionDir)
  let collectionInfo = null
  try {
    collectionInfo = await stat(collectionDir)
  } catch {
    collectionInfo = null
  }
  if (collectionInfo === null || !collectionInfo.isDirectory()) {
    fail('合集目录不存在或不是目录：' + display(collectionDir))
  }

  const pubPath = path.join(collectionDir, PUB_FILE)
  const pubBytes = await readCollectionPublicKey(pubPath)
  const privateKey = readPrivateKey()

  const outputPath = options.out === '' ? path.join(collectionDir, SIGN_FILE) : path.resolve(options.out)
  if (outputPath === pubPath) {
    fail('输出路径不能是 ' + PUB_FILE + ' 本身，合集公钥不会被修改')
  }
  const outputDir = path.dirname(outputPath)
  let outputDirInfo = null
  try {
    outputDirInfo = await stat(outputDir)
  } catch {
    outputDirInfo = null
  }
  if (outputDirInfo === null || !outputDirInfo.isDirectory()) {
    fail('输出目录不存在：' + display(outputDir) + '，请先创建该目录')
  }
  const existed = await isFile(outputPath)
  if (existed && !options.force) {
    fail(
      '目标文件已存在：' +
        display(outputPath) +
        '，默认不覆盖；确认要替换旧签名时加 --force'
    )
  }

  const digest = createHash('sha512').update(pubBytes).digest()
  const value = sign(null, digest, privateKey).toString('base64')
  const publicKey = createPublicKey(privateKey)
  if (!verify(null, digest, publicKey, Buffer.from(value, 'base64'))) {
    fail('签名自检未通过，未写出 ' + SIGN_FILE)
  }

  await writeFile(outputPath, JSON.stringify({ sign: [{ value, signer: SIGNER }] }, null, 2) + '\n', 'utf8')

  if (existed) {
    console.log('[sign-collection] 旧签名已被替换：' + display(outputPath))
  }
  console.log('[sign-collection] 合集目录：' + display(collectionDir))
  console.log('[sign-collection] 被签名对象：' + PUB_FILE + '（' + pubBytes.length + ' 字节，SHA-512 摘要）')
  console.log('[sign-collection] 签名者：' + SIGNER)
  console.log('[sign-collection] 已写出：' + display(outputPath))
}

main().catch((error) => {
  console.error('[sign-collection] ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
})
