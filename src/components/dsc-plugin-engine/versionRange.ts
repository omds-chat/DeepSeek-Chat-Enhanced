/**
 * 版本范围规则：只接受单段比较表达式，如 ^1.0.0、~1.2.0、>=1.0.0、<=1.0.0、=1.0.0 或 1.0.0。
 * 清单的 engines 与离线包 meta.json 的 dependencies.dsc 共用这一处规则，组合范围不合法。
 */
export const RANGE_PATTERN = /^(\^|~|>=|<=|=)?(\d+\.\d+\.\d+)$/

/** 版本范围是否只含单段比较表达式；空串与 * 视为不限制 */
export const isSingleRangeExpression = (range: string): boolean => {
  const trimmed = range.trim()
  return trimmed === '' || trimmed === '*' || RANGE_PATTERN.test(trimmed)
}
