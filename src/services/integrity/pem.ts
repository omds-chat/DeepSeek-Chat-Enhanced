/**
 * 从 PEM 文本取出 DER 字节。
 * label 是 PEM 头里的类型名（如 CERTIFICATE）；头尾缺失或 base64 非法时返回 null。
 */
export const pemToDer = (pem: string, label: string): Uint8Array<ArrayBuffer> | null => {
  const pattern = new RegExp('-----BEGIN ' + label + '-----([\\s\\S]*?)-----END ' + label + '-----')
  const match = pattern.exec(pem)
  if (!match) {
    return null
  }
  try {
    const binary = atob(match[1].replace(/\s+/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

/** 比较两段字节是否完全一致 */
export const derEquals = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }
  return true
}
