import type { TranslationKey, TranslationParams } from '../../i18n/index.js'

/** 凭证令牌；只在 dsc-core 内部持有 */
const TOKEN = Symbol('dsc-core-credential')
/** 票据有效期（毫秒）；超时未消费按绕过处理 */
const TICKET_TTL = 5000
/** 保留的绕过事件条数 */
const MAX_EVENTS = 50
/** 两次告警的最小间隔（毫秒） */
const ALERT_INTERVAL = 3000

/** 调用凭证；仅引擎持有 */
export type CoreCredential = { readonly token: symbol; readonly owner: string }

/** 单次调用票据；引擎每次转发签发一张，核心消费后作废 */
export type CoreTicket = { readonly id: number; readonly capability: string; readonly issuedAt: number }

/** 一次核心调用携带的凭据 */
export type CoreCall = { readonly credential: CoreCredential; readonly ticket: CoreTicket }

/** 绕过检测记录 */
export type BypassEvent = { readonly at: number; readonly capability: string; readonly reason: string }

/** 告警出口；由引擎注册 */
export type AlertSink = (message: { key: TranslationKey; params?: TranslationParams }) => void

let nextTicketId = 1
const tickets = new Map<number, CoreTicket>()
const events: BypassEvent[] = []
let alertSink: AlertSink | null = null
let lastAlertAt = 0

/** 签发调用票据 */
export const issueTicket = (capability: string): CoreTicket => {
  const ticket: CoreTicket = { id: nextTicketId, capability, issuedAt: Date.now() }
  nextTicketId += 1
  tickets.set(ticket.id, ticket)
  return ticket
}

/** 消费票据；缺失、过期或能力不匹配时返回 false */
export const consumeTicket = (ticket: unknown, capability: string): boolean => {
  if (typeof ticket !== 'object' || ticket === null) {
    return false
  }
  const id = (ticket as { id?: unknown }).id
  if (typeof id !== 'number') {
    return false
  }
  const stored = tickets.get(id)
  if (!stored) {
    return false
  }
  tickets.delete(id)
  return stored.capability === capability && Date.now() - stored.issuedAt <= TICKET_TTL
}

/** 创建凭证；只有引擎调用 */
export const createCredential = (owner: string): CoreCredential => ({ token: TOKEN, owner })

/** 凭证校验 */
export const isCredential = (value: unknown): value is CoreCredential =>
  typeof value === 'object' && value !== null && (value as { token?: unknown }).token === TOKEN

/** 注册告警出口 */
export const setAlertSink = (sink: AlertSink | null) => {
  alertSink = sink
}

/** 记录绕过并通知引擎；告警按最小间隔合并 */
export const recordBypass = (capability: string, reason: string) => {
  events.push({ at: Date.now(), capability, reason })
  if (events.length > MAX_EVENTS) {
    events.shift()
  }
  const now = Date.now()
  if (alertSink && now - lastAlertAt >= ALERT_INTERVAL) {
    lastAlertAt = now
    alertSink({ key: 'pluginBypassDetected', params: { capability } })
  }
}

/** 读取绕过记录 */
export const readBypassEvents = (): readonly BypassEvent[] => events
