import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import { showToast } from '../base/toastState.js'
import { loadSession } from '../../services/chat/db.js'
import { renameSession, useChatStore } from '../../services/chat/store.js'
import type { Message, ReplyBlock, Session, SessionSummary, TextPart } from '../../services/chat/types.js'
import { useSettings, type Locale } from '../../services/settings.js'
import { isCredential, recordBypass, type CoreCredential } from './guard.js'
import { fetchText, postJson } from './net.js'
import {
  clearPluginData,
  readPluginEntry,
  removePluginEntry,
  writePluginEntry,
} from './plugin-data.js'
import { registerCoreService, requireCoreService } from './registry.js'
import {
  CORE_VERSION,
  type CoreApi,
  type CoreAttachmentView,
  type CoreEvent,
  type CoreMessageView,
  type CoreSessionSummary,
  type CoreSessionView,
  type CoreStorageCall,
} from './types.js'

/** 会话标题上限 */
const MAX_TITLE_LENGTH = 120

const toSummary = (session: SessionSummary): CoreSessionSummary => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})

const toAttachmentView = (file: { name: string; size: number; isImage: boolean }): CoreAttachmentView => ({
  name: file.name,
  size: file.size,
  isImage: file.isImage,
})

const isTextPart = (block: ReplyBlock): block is TextPart => block.type === 'text'

const toMessageView = (message: Message): CoreMessageView => ({
  id: message.id,
  role: message.role,
  createdAt: message.createdAt,
  text:
    message.role === 'user'
      ? message.content
      : message.blocks
          .filter(isTextPart)
          .map((block) => block.text)
          .join('\n'),
  attachments: message.role === 'user' ? message.files.map(toAttachmentView) : [],
})

const toSessionView = (session: Session): CoreSessionView => ({
  ...toSummary(session),
  messages: session.messages.map(toMessageView),
})

const listSessions = async (): Promise<CoreSessionSummary[]> =>
  useChatStore.getState().sessions.map(toSummary)

const readSession = async (id: string): Promise<CoreSessionView | null> => {
  const cached = useChatStore.getState().sessionCache
  const session = Object.hasOwn(cached, id) ? cached[id] : await loadSession(id)
  return session ? toSessionView(session) : null
}

const renameSessionTitle = (id: string, title: string): boolean => {
  const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH)
  const exists = useChatStore.getState().sessions.some((session) => session.id === id)
  if (trimmed === '' || !exists) {
    return false
  }
  renameSession(id, trimmed)
  return true
}

const currentLocale = (): Locale => useSettings.getState().locale

const notify = (key: TranslationKey, params?: TranslationParams) => {
  showToast({ key, params })
}

/** 插件数据的三条操作共用一个服务入口，配额与序列化校验都在 plugin-data 内完成 */
const pluginDataService = (call: CoreStorageCall): unknown => {
  if (call.op === 'read') {
    return readPluginEntry(call.pluginId, call.key)
  }
  if (call.op === 'write') {
    writePluginEntry(call.pluginId, call.key, call.value)
    return null
  }
  removePluginEntry(call.pluginId, call.key)
  return null
}

const subscribe = (listener: (event: CoreEvent) => void): (() => void) =>
  useChatStore.subscribe((state, previous) => {
    if (state.activeId !== previous.activeId || state.sessions !== previous.sessions) {
      listener({ type: 'session:changed', activeId: state.activeId })
    }
  })

let opened = false

/** 打开核心门面；只有持凭证的引擎可以调用 */
export const openCore = (credential: CoreCredential): CoreApi => {
  if (!isCredential(credential)) {
    recordBypass('openCore', 'credential')
    throw new Error('dsc-core: openCore requires an engine credential')
  }
  if (!opened) {
    registerCoreService('sessions:list', listSessions)
    registerCoreService('sessions:read', readSession)
    registerCoreService('sessions:rename', renameSessionTitle)
    registerCoreService('events:session', subscribe)
    registerCoreService('notify', notify)
    registerCoreService('settings:locale', currentLocale)
    registerCoreService('net:fetch', fetchText)
    registerCoreService('net:fetch-post', postJson)
    registerCoreService('plugins:storage', pluginDataService)
    registerCoreService('plugins:data-clear', clearPluginData)
    opened = true
  }
  return {
    version: CORE_VERSION,
    listSessions: (call) => requireCoreService(call, 'sessions:list')(),
    readSession: (call, id) => requireCoreService(call, 'sessions:read')(id),
    renameSession: (call, id, title) => requireCoreService(call, 'sessions:rename')(id, title),
    currentLocale: (call) => requireCoreService(call, 'settings:locale')(),
    notify: (call, key, params) => requireCoreService(call, 'notify')(key, params),
    subscribe: (call, listener) => requireCoreService(call, 'events:session')(listener),
    fetchText: (call, url, signal) => requireCoreService(call, 'net:fetch')(url, signal),
    postJson: (call, url, body, signal) =>
      requireCoreService(call, 'net:fetch-post')(url, body, signal),
    readPluginEntry: (call, pluginId, key) =>
      requireCoreService(call, 'plugins:storage')({
        op: 'read',
        pluginId,
        key,
      }) as { value: unknown } | null,
    writePluginEntry: (call, pluginId, key, value) => {
      requireCoreService(call, 'plugins:storage')({ op: 'write', pluginId, key, value })
    },
    removePluginEntry: (call, pluginId, key) => {
      requireCoreService(call, 'plugins:storage')({ op: 'remove', pluginId, key })
    },
    clearPluginData: (call, pluginId) =>
      requireCoreService(call, 'plugins:data-clear')(pluginId),
  }
}

export { CORE_CAPABILITIES, CORE_VERSION } from './types.js'
export type {
  CoreApi,
  CoreAttachmentView,
  CoreCapabilityId,
  CoreEvent,
  CoreFetchResult,
  CoreMessageView,
  CoreSessionSummary,
  CoreSessionView,
  CoreStorageCall,
} from './types.js'
export { PluginFetchError } from './net.js'
export type { FetchRejectReason, FetchTextResult } from './net.js'
export { PluginDataError } from './plugin-data.js'
export type {
  PluginDataRejectReason,
  PluginDataStore,
  PluginDataUsage,
} from './plugin-data.js'
/** 插件数据的宿主侧入口：只给引擎与设置界面的数据管理使用，不经过凭证门面 */
export { clearAllPluginData, clearPluginData, hasPluginData, listPluginData } from './plugin-data.js'
export {
  createCredential,
  issueTicket,
  isCredential,
  readBypassEvents,
  setAlertSink,
} from './guard.js'
export type { BypassEvent, CoreCall, CoreCredential, CoreTicket } from './guard.js'
