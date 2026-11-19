/**
 * 合集证书在来源站点的取件路径。
 * 规范布局是 <来源基址>/certs/<合集 id>-eec.crt，合集 id 与该来源在信任清单登记的合集 id 一致；
 * 旧的 <来源基址>/eec.pem 只作兼容兜底，供尚未迁移的第三方来源继续使用。
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

/** 规范取件路径 certs/<合集 id>-eec.crt；id 不合法时返回空串 */
export const collectionCertPath = (id: string): string =>
  ID_PATTERN.test(id) ? COLLECTION_CERT_DIR + '/' + id + COLLECTION_CERT_SUFFIX : ''

/** 依次尝试的取件路径：规范路径优先，旧的 eec.pem 兜底，两条都失败才算拿不到证书 */
export const collectionCertPaths = (id: string): string[] => {
  const canonical = collectionCertPath(id)
  return canonical === '' ? [LEGACY_EEC_FILE] : [canonical, LEGACY_EEC_FILE]
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
