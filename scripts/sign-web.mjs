#!/usr/bin/env node
// 构建期逐文件签名：对 dist 下的代码类文件计算 SHA-512 摘要并做 Ed25519 签名，产出 dist/web_sign.json

import { createHash, createPrivateKey, sign } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
// 需要签名的文件扩展名；图片、字体、许可证等不签名
const SIGNED_EXTENSIONS = new Set(['.html', '.js', '.css'])
const SIGN_FILE = 'web_sign.json'
const SIGNER = 'dsc'

const fail = (message) => {
  throw new Error(message)
}

/** 递归列出目录下的文件，返回相对 dist 根目录、使用正斜杠的路径 */
const listFiles = async (dir, prefix = '') => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(dir, entry.name), relative)))
    } else if (entry.isFile()) {
      files.push(relative)
    }
  }
  return files
}

/** 读取 PKCS#8 PEM 私钥，并确认算法为 Ed25519 */
const readPrivateKey = () => {
  const pem = process.env.WEB_PRIVATE_KEY
  if (!pem || pem.trim() === '') {
    fail('缺少环境变量 WEB_PRIVATE_KEY（PKCS#8 PEM 格式的 Ed25519 私钥），无法生成网页签名')
  }
  let privateKey
  try {
    privateKey = createPrivateKey(pem)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    fail('WEB_PRIVATE_KEY 不是有效的 PKCS#8 PEM 私钥：' + reason)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail('WEB_PRIVATE_KEY 的算法为 ' + String(privateKey.asymmetricKeyType) + '，需要 Ed25519 私钥')
  }
  return privateKey
}

/** 确认 dist 目录存在 */
const ensureDist = async () => {
  let exists = false
  try {
    const info = await stat(distDir)
    exists = info.isDirectory()
  } catch {
    exists = false
  }
  if (!exists) {
    fail('未找到产物目录 ' + path.relative(root, distDir) + '，请先执行 pnpm build')
  }
}

const main = async () => {
  const privateKey = readPrivateKey()
  await ensureDist()
  const files = (await listFiles(distDir))
    .filter((file) => SIGNED_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort()
  if (files.length === 0) {
    fail('dist 下没有可签名的 .html/.js/.css 文件，未生成 ' + SIGN_FILE)
  }
  const entries = []
  for (const file of files) {
    const bytes = await readFile(path.join(distDir, ...file.split('/')))
    const digest = createHash('sha512').update(bytes).digest()
    entries.push({
      value: sign(null, digest, privateKey).toString('base64'),
      for: file,
      signer: SIGNER,
    })
  }
  const output = path.join(distDir, SIGN_FILE)
  await writeFile(output, JSON.stringify({ sign: entries }, null, 2) + '\n', 'utf8')
  console.log(
    '[sign-web] 已签名 ' + entries.length + ' 个文件，输出 ' + path.relative(root, output)
  )
}

main().catch((error) => {
  console.error('[sign-web] ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
})
