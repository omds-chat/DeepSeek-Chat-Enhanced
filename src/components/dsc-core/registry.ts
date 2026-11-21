import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import { consumeTicket, isCredential, recordBypass, type CoreCall } from './guard.js'
import type {
  CoreCapabilityId,
  CoreEvent,
  CoreFetchResult,
  CorePostResult,
  CoreRequestPatchSource,
  CoreSessionSummary,
  CoreSessionView,
  CoreStorageCall,
} from './types.js'

/**
 * 能力标识到核心实现签名的映射。
 * 只收录在 core 侧有实现的能力标识：chat:request 的登记与调用都在引擎内完成，这里没有对应项。
 */
export type CoreServiceTable = {
  'sessions:list': () => Promise<CoreSessionSummary[]>
  'sessions:read': (id: string) => Promise<CoreSessionView | null>
  'sessions:rename': (id: string, title: string) => boolean
  'events:session': (listener: (event: CoreEvent) => void) => () => void
  notify: (key: TranslationKey, params?: TranslationParams) => void
  'settings:locale': () => 'zh-CN' | 'en-US'
  'net:fetch': (url: string, signal?: AbortSignal) => Promise<CoreFetchResult>
  'net:fetch-post': (url: string, body: unknown, signal?: AbortSignal) => Promise<CorePostResult>
  'plugins:storage': (call: CoreStorageCall) => unknown
  'plugins:data-clear': (pluginId: string) => void
  'chat:request-source': (source: CoreRequestPatchSource | null) => void
}

const services = new Map<CoreCapabilityId, unknown>()

/** 注册核心实现；由门面在首次打开时调用 */
export const registerCoreService = <K extends keyof CoreServiceTable>(
  id: K,
  service: CoreServiceTable[K]
) => {
  services.set(id, service)
}

/** 取核心实现；凭证或票据不合法时记录绕过并抛出 */
export const requireCoreService = <K extends keyof CoreServiceTable>(
  call: CoreCall,
  id: K
): CoreServiceTable[K] => {
  const credential = (call as CoreCall | null | undefined)?.credential
  if (!isCredential(credential)) {
    recordBypass(id, 'credential')
    throw new Error(`dsc-core: rejected ${id} without engine credential`)
  }
  if (!consumeTicket(call.ticket, id)) {
    recordBypass(id, 'ticket')
    throw new Error(`dsc-core: rejected ${id} without engine ticket`)
  }
  const service = services.get(id)
  if (!service) {
    throw new Error(`dsc-core: service ${id} is not registered`)
  }
  return service as CoreServiceTable[K]
}
