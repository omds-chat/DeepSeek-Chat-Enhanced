import type { CoreRequestPatch } from '../dsc-core/index.js'

/**
 * 请求补丁的收敛规则：白名单、范围裁剪与合并都只在这里实现。
 * core 侧只按字段写进请求，不再判定，因此规则改动的唯一落点是本文件。
 */
export const PATCH_LIMITS = {
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  maxTokens: { min: 1, max: 4096 },
  stop: { maxItems: 4, maxLength: 32 },
  systemPromptAppend: { maxLength: 2000 },
  systemPromptReplace: { maxLength: 8000 },
} as const

/** 单次收集的时间预算（毫秒）；一次请求的全部处理器共用这一份预算 */
export const REQUEST_PATCH_BUDGET_MS = 10

/** 收敛结果；clamped 表示有值被裁剪过，用于提示插件作者 */
export type ConvergedPatch = { patch: CoreRequestPatch; clamped: boolean }

const clampNumber = (
  value: number,
  min: number,
  max: number,
  integer: boolean
): { value: number; clamped: boolean } => {
  const base = integer ? Math.round(value) : value
  const bounded = Math.min(max, Math.max(min, base))
  return { value: bounded, clamped: bounded !== value }
}

/** 字符串字段：去掉首尾空白后为空按未提供处理，超长按长度截断 */
const readText = (
  value: unknown,
  maxLength: number
): { text: string; clamped: boolean } | null => {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    return null
  }
  return trimmed.length > maxLength
    ? { text: trimmed.slice(0, maxLength), clamped: true }
    : { text: trimmed, clamped: false }
}

/** 停止词：只收字符串项，空串与非字符串项丢弃，超出条数截断 */
const readStop = (
  value: unknown
): { stop: string[]; clamped: boolean } | null => {
  if (!Array.isArray(value)) {
    return null
  }
  const stop: string[] = []
  let clamped = false
  for (const item of value) {
    if (typeof item !== 'string') {
      clamped = true
      continue
    }
    const trimmed = item.trim()
    if (trimmed === '') {
      clamped = true
      continue
    }
    const text =
      trimmed.length > PATCH_LIMITS.stop.maxLength
        ? trimmed.slice(0, PATCH_LIMITS.stop.maxLength)
        : trimmed
    clamped ||= text !== trimmed
    if (stop.includes(text)) {
      continue
    }
    if (stop.length >= PATCH_LIMITS.stop.maxItems) {
      clamped = true
      continue
    }
    stop.push(text)
  }
  return stop.length === 0 ? null : { stop, clamped }
}

/**
 * 收敛一份补丁：只认识六个白名单字段，其余字段静默丢弃。
 * 返回 null 表示没有可用字段，与「插件不打算改请求」等价。
 */
export const convergePatch = (value: unknown): ConvergedPatch | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  const patch: CoreRequestPatch = {}
  let clamped = false

  if (typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)) {
    const result = clampNumber(
      raw.temperature,
      PATCH_LIMITS.temperature.min,
      PATCH_LIMITS.temperature.max,
      false
    )
    patch.temperature = result.value
    clamped ||= result.clamped
  }
  if (typeof raw.topP === 'number' && Number.isFinite(raw.topP)) {
    const result = clampNumber(raw.topP, PATCH_LIMITS.topP.min, PATCH_LIMITS.topP.max, false)
    patch.topP = result.value
    clamped ||= result.clamped
  }
  if (typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens)) {
    const result = clampNumber(
      raw.maxTokens,
      PATCH_LIMITS.maxTokens.min,
      PATCH_LIMITS.maxTokens.max,
      true
    )
    patch.maxTokens = result.value
    clamped ||= result.clamped
  }
  const stop = readStop(raw.stop)
  if (stop) {
    patch.stop = stop.stop
    clamped ||= stop.clamped
  }
  const append = readText(raw.systemPromptAppend, PATCH_LIMITS.systemPromptAppend.maxLength)
  if (append) {
    patch.systemPromptAppend = append.text
    clamped ||= append.clamped
  }
  const replace = readText(raw.systemPromptReplace, PATCH_LIMITS.systemPromptReplace.maxLength)
  if (replace) {
    patch.systemPromptReplace = replace.text
    clamped ||= replace.clamped
  }
  return Object.keys(patch).length === 0 ? null : { patch, clamped }
}

/**
 * 合并两份已收敛的补丁：标量以后一份为准，停止词取并集，追加提示词按顺序拼接。
 * 追加提示词拼接后仍受长度上限约束，超出部分截断。
 */
export const mergePatch = (base: CoreRequestPatch, next: CoreRequestPatch): CoreRequestPatch => {
  const merged: CoreRequestPatch = { ...base }
  if (next.temperature !== undefined) {
    merged.temperature = next.temperature
  }
  if (next.topP !== undefined) {
    merged.topP = next.topP
  }
  if (next.maxTokens !== undefined) {
    merged.maxTokens = next.maxTokens
  }
  if (next.systemPromptReplace !== undefined) {
    merged.systemPromptReplace = next.systemPromptReplace
  }
  if (next.stop !== undefined) {
    const stop = [...(merged.stop ?? [])]
    for (const item of next.stop) {
      if (stop.length >= PATCH_LIMITS.stop.maxItems) {
        break
      }
      if (!stop.includes(item)) {
        stop.push(item)
      }
    }
    merged.stop = stop
  }
  if (next.systemPromptAppend !== undefined) {
    const text =
      merged.systemPromptAppend === undefined
        ? next.systemPromptAppend
        : merged.systemPromptAppend + '\n' + next.systemPromptAppend
    merged.systemPromptAppend =
      text.length > PATCH_LIMITS.systemPromptAppend.maxLength
        ? text.slice(0, PATCH_LIMITS.systemPromptAppend.maxLength)
        : text
  }
  return merged
}
