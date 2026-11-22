import type { TranslationKey } from '../../i18n/index.js'

/** 宿主字典的翻译函数；i18n/index.ts 的 useTranslate 与 translate 都是这一形态 */
export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/**
 * 插件文案的解析口径, 与设置表面同法: 键走宿主字典, 直给文案原样显示, 两者都没有时用兜底值。
 * 页面标题与条目名、徽标、动作按钮各有一组字段, 这里按字段收成三个函数, 免得各处重复三元表达式。
 */

/** 页面标题与 list 条目名: titleKey / title, 兜底为页面 id 或条目键 */
export const titledText = (
  source: { readonly titleKey?: string; readonly title?: string },
  fallback: string,
  t: Translate
): string =>
  typeof source.titleKey === 'string'
    ? t(source.titleKey as TranslationKey)
    : (source.title ?? fallback)

/** list 条目徽标: badgeKey / badge, 都没有时为空串(调用方据此不渲染徽标) */
export const badgeText = (
  source: { readonly badgeKey?: string; readonly badge?: string },
  t: Translate
): string =>
  typeof source.badgeKey === 'string' ? t(source.badgeKey as TranslationKey) : (source.badge ?? '')

/** 动作按钮: labelKey / label, 兜底为动作键 */
export const actionText = (
  source: { readonly labelKey?: string; readonly label?: string; readonly key: string },
  t: Translate
): string =>
  typeof source.labelKey === 'string'
    ? t(source.labelKey as TranslationKey)
    : (source.label ?? source.key)
