import type { CreateMessageRequest, MessageParam } from '../../services/api/types.js'
import type { CoreRequestPatch, CoreRequestPatchSource, CoreRequestPreview } from './types.js'

/**
 * 请求补丁的落点：core 侧只做两件事，取切片交给引擎，把引擎收敛过的补丁写进请求。
 * 白名单、范围收敛与合并全部在引擎侧完成，这里不再重复判定，也不缓存任何请求状态。
 */
let source: CoreRequestPatchSource | null = null

/** 登记来源；引擎启动时登记一次，重复登记以最后一次为准 */
export const registerRequestPatchSource = (next: CoreRequestPatchSource | null): void => {
  source = next
}

/** 取最后一条用户消息的文本；没有用户消息时为空串 */
export const readRequestPreview = (messages: readonly MessageParam[]): CoreRequestPreview => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.role === 'user') {
      return {
        lastUserMessage:
          typeof message.content === 'string'
            ? message.content
            : message.content
                .map((block) => (block.type === 'text' ? block.text : ''))
                .join('\n'),
      }
    }
  }
  return { lastUserMessage: '' }
}

/** 向已登记的来源索取一次补丁；没有来源或来源返回空时得到 null */
export const collectRequestPatch = (preview: CoreRequestPreview): CoreRequestPatch | null => {
  if (!source) {
    return null
  }
  return source(preview)
}

const applyPatch = (
  message: CreateMessageRequest,
  patch: CoreRequestPatch
): CreateMessageRequest => {
  const next: CreateMessageRequest = { ...message }
  if (patch.temperature !== undefined) {
    next.temperature = patch.temperature
  }
  if (patch.topP !== undefined) {
    next.top_p = patch.topP
  }
  if (patch.maxTokens !== undefined) {
    next.max_tokens = patch.maxTokens
  }
  if (patch.stop !== undefined) {
    next.stop_sequences = [...patch.stop]
  }
  // 先整体替换再加尾巴，两者都给时追加内容落在替换后的提示词之后
  if (patch.systemPromptReplace !== undefined) {
    next.system = patch.systemPromptReplace
  }
  if (patch.systemPromptAppend !== undefined) {
    next.system = next.system === '' ? patch.systemPromptAppend : next.system + '\n' + patch.systemPromptAppend
  }
  return next
}

/** 把一份补丁写进请求；补丁为空时原样返回 */
export const applyRequestPatch = (
  message: CreateMessageRequest,
  patch: CoreRequestPatch | null
): CreateMessageRequest => (patch ? applyPatch(message, patch) : message)

/**
 * 发送前的唯一入口：取切片、向引擎索取补丁、写进请求。
 * 请求参数只有这一条路径被改动，补丁为空时返回同一个对象。
 */
export const patchRequestForSend = (message: CreateMessageRequest): CreateMessageRequest =>
  applyRequestPatch(message, collectRequestPatch(readRequestPreview(message.messages)))
