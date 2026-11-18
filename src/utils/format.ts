const pad = (value: number, length = 2): string => String(value).padStart(length, '0')

const toDate = (value: string | number | Date): Date | null => {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export const formatDate = (
  value: string | number | Date,
  separator: '/' | '-' = '-'
): string | null => {
  const date = toDate(value)
  if (!date) {
    return null
  }
  return [pad(date.getFullYear(), 4), pad(date.getMonth() + 1), pad(date.getDate())].join(separator)
}

/** 字节数转人类可读：小于 1 KB 用 B，其余按 KB / MB 保留一位小数 */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const monthKey = (value: string | number | Date): string | null => {
  const date = toDate(value)
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}` : null
}

/** 完整时间：yyyy-MM-dd HH:mm:ss+HH:mm，时区取本地偏移 */
export const formatDateTime = (value: string | number | Date): string | null => {
  const date = toDate(value)
  if (!date) {
    return null
  }
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const minutes = Math.abs(offset)
  const zone = `${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`
}
