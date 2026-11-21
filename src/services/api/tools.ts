import type { CreateMessageRequest } from './types.js'

/**
 * 服务端工具声明：阅读链接始终开启，智能搜索（含边想边搜）按调用方开关另行声明。
 * 发送路径与按来源执行的组装共用这一处，避免两份声明各自漂移。
 */
export const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}
