/**
 * 合集证书在来源站点的取件路径。
 * 公开发布布局是 <来源基址>/certs/<合集 id>/<合集 id>-eec.crt，目录名与合集 id 一致，
 * 与该来源在信任清单登记的合集 id 相同；
 * 旧站点仍在用的扁平路径 <来源基址>/certs/<合集 id>-eec.crt 只作兼容，
 * 最旧的 <来源基址>/eec.pem 排在最后兜底。
 */

/** 合集证书目录 */
export const COLLECTION_CERT_DIR = 'certs'

/** 合集证书文件名后缀；规范文件名为 <合集 id><后缀> */
export const COLLECTION_CERT_SUFFIX = '-eec.crt'

/** 旧布局的证书文件名；仅作兼容兜底，不再作为规范路径 */
export const LEGACY_EEC_FILE = 'eec.pem'

/** 合集 id 允许的字符；与信任清单对合集 id 的要求一致 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 站点名归一化成合集 id：小写，非字母数字折叠成单个连字符，去掉首尾连字符 */
export const normalizeCollectionId = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** 公开发布布局 certs/<合集 id>/<合集 id>-eec.crt；id 不合法时返回空串 */
export const collectionCertPath = (id: string): string =>
  ID_PATTERN.test(id)
    ? COLLECTION_CERT_DIR + '/' + id + '/' + id + COLLECTION_CERT_SUFFIX
    : ''

/**
 * 旧站点的扁平布局 certs/<合集 id>-eec.crt；id 不合法时返回空串。
 * 仅用于兼容尚未迁移到公开发布布局的来源，新来源不应依赖它。
 */
export const flatCertPath = (id: string): string =>
  ID_PATTERN.test(id) ? COLLECTION_CERT_DIR + '/' + id + COLLECTION_CERT_SUFFIX : ''

/**
 * 依次尝试的取件路径：公开发布布局优先，旧站点的扁平布局兼容，旧的 eec.pem 最后兜底。
 * 三档都取不到才算拿不到证书；id 不合法时只剩 eec.pem 一档。
 */
export const collectionCertPaths = (id: string): string[] => {
  const canonical = collectionCertPath(id)
  if (canonical === '') {
    return [LEGACY_EEC_FILE]
  }
  return [canonical, flatCertPath(id), LEGACY_EEC_FILE]
}

/** 信任清单里一条合集的标识；dir 是清单登记路径里的合集目录名 */
export type ListedCollection = { id: string; dir: string }

/** 合集 id：清单登记的 id 优先，其次清单登记的目录名，最后用站点名归一化 */
export const collectionIdOf = (listed: ListedCollection | null, name: string): string => {
  const listedId = listed === null ? '' : listed.id.trim()
  if (ID_PATTERN.test(listedId)) {
    return listedId
  }
  const listedDir = listed === null ? '' : listed.dir.trim()
  if (ID_PATTERN.test(listedDir)) {
    return listedDir
  }
  return normalizeCollectionId(name)
}
