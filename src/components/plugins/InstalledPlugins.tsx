import clsx from 'clsx'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { pluginReasonText } from '../../i18n/pluginReasons.js'
import { isUnlistedTrust, verdictTextKey } from '../../i18n/pluginVerdicts.js'
import {
  market,
  readRecordDataBase,
  toPluginId,
  type CatalogPlugin,
  type ReinstallPlan,
  type UpdateCheck,
} from '../dsc-market/index.js'
import { dependencyStatusMap } from '../dsc-plugin-engine/dependencies.js'
import {
  getPluginEngine,
  type InstallSource,
  type PluginEngine,
  type UnloadResult,
} from '../dsc-plugin-engine/index.js'
import type {
  PluginSourceType,
  PluginState,
  PluginStateView,
} from '../dsc-plugin-engine/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Menu, type MenuOption } from '../base/Menu.js'
import { Modal } from '../base/Modal.js'
import {
  IconDataOutline16,
  IconDownloadOutline16,
  IconEllipsisOutline16,
  IconPluginOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { formatDateTime } from '../../utils/format.js'
import { isLegacyInstall } from './legacyInstall.js'
import { openPluginDetail, setPluginPanelTab } from './pluginPanelState.js'
import { useInternalCatalog } from './usePluginList.js'
import styles from './PluginPanel.module.css'

const stateLabels: Record<PluginState, TranslationKey> = {
  active: 'pluginStateActive',
  inactive: 'pluginStateInactive',
  failed: 'pluginStateFailed',
  registered: 'pluginStateRegistered',
}

/**
 * 状态标签只挂真状态：未启动与启动失败。
 * 启用与停用由开关自己表达，不再额外挂一枚「运行中 / 已停用」的胶囊；
 * 这样卡片刻度与 dsh 的插件行一致，标题行也不会每张卡都多一枚标签。
 */
const stateTagOf = (state: PluginState): TranslationKey | null =>
  state === 'failed' || state === 'registered' ? stateLabels[state] : null

/** 来源类型文案；内置与宿主直接注册的插件另有文案 */
const sourceTypeLabels: Record<PluginSourceType, TranslationKey> = {
  inner: 'pluginSourceSameOrigin',
  awesome: 'pluginSourceAwesome',
  outer: 'pluginSourceOuter',
  local: 'pluginSourceLocal',
}

const sourceLabel = (plugin: PluginStateView): TranslationKey => {
  if (!plugin.source) {
    return 'pluginSourceHost'
  }
  if (plugin.source.kind === 'builtin') {
    return 'pluginSourceBuiltin'
  }
  if (plugin.source.kind === 'local') {
    return 'pluginSourceLocal'
  }
  return sourceTypeLabels[plugin.sourceType]
}

/** 二次确认的保持时间（毫秒），与市场的安装确认同一节奏 */
const CONFIRM_MS = 3000

/** 新装插件高亮环的持续时间（毫秒），与高亮动画同一节奏 */
const HIGHLIGHT_MS = 2400

/** 正在进行的操作；用于卡内控件的忙碌文案与禁用 */
type Busy = {
  id: string
  action: 'toggle' | 'uninstall' | 'update' | 'reinstall' | 'check' | 'install'
}

/** 需要二次确认的操作；3 秒内再次点击同一按钮才真正执行 */
type PendingConfirm = { id: string; kind: 'update' | 'reinstall' }

/** 日志快照：读取时间用于提示日志时效 */
type LogSnapshot = { name: string; lines: readonly string[]; capturedAt: number }

/** 卡内的一行中性补充：来源、签名结论、目录校验、旧安装与内置说明 */
type CardNote = { text: string; danger?: boolean }

/** 内部插件组的一条：所属来源 id、解析出的插件 id 与目录条目本身 */
type InternalEntry = { sourceId: string; id: string; plugin: CatalogPlugin }

/** 已安装插件列表：卡片行为主，状态标记、启停开关与 ⋯ 菜单 */
export const InstalledPlugins = ({
  plugins,
  ready,
  loading,
  highlightId,
  onHighlightShown,
  refresh,
}: {
  plugins: PluginStateView[]
  ready: boolean
  /** 首读未完成：列出骨架行，空态与列表都不渲染 */
  loading: boolean
  /** 刚装上的插件：滚进可视区并挂 2.4s 高亮环 */
  highlightId: string | null
  /** 高亮环到时撤掉 */
  onHighlightShown: () => void
  refresh: () => void
}) => {
  const t = useTranslate()
  const [busy, setBusy] = useState<Busy | null>(null)
  /** 卸载确认的插件 id：卡右端在 3 秒内换成「卸载 + 取消」 */
  const [confirmingUninstall, setConfirmingUninstall] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogSnapshot | null>(null)
  /** 版本更新检查结论；没有条目的插件不显示任何标注 */
  const [updates, setUpdates] = useState<ReadonlyMap<string, UpdateCheck>>(new Map())
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const confirmTimer = useRef(0)
  const uninstallTimer = useRef(0)
  const running = busy !== null
  /** 卡片节点：新装插件按 id 取节点做滚动定位 */
  const cards = useRef(new Map<string, HTMLLIElement>())

  /** 内置内部插件来源的目录条目；市场未就绪或该来源没有运行态时为 null */
  const catalog = useInternalCatalog()
  /** 宿主能力不是插件条目：引擎照常持有它的记录与日志，但任何分组都不列它 */
  const installed = useMemo(
    () => plugins.filter((plugin) => plugin.hostCapability !== true),
    [plugins]
  )
  /** 引擎已有记录的 id；内部插件组据此滤掉已安装的条目 */
  const installedIds = useMemo(() => new Set(plugins.map((plugin) => plugin.id)), [plugins])
  /**
   * 内部插件组：内置内部来源目录里、引擎尚无安装记录的条目。
   * 组内顺序沿用来源目录给出的顺序（市场按插件名排好），不另立排序口径。
   */
  const internal = useMemo<InternalEntry[]>(() => {
    if (catalog === null) {
      return []
    }
    return catalog.plugins
      .map((plugin) => ({
        sourceId: catalog.sourceId,
        id: plugin.manifest?.id ?? toPluginId(plugin.name) ?? plugin.key,
        plugin,
      }))
      .filter((entry) => !installedIds.has(entry.id))
  }, [catalog, installedIds])

  /**
   * 依赖关系状态：徽标与启用开关的可用性都从这里取值。
   * 徽标常驻，随列表刷新重算，不依赖任何一次操作失败。
   */
  const dependency = useMemo(() => dependencyStatusMap(plugins), [plugins])

  /** 更新检查的目标：优先取记录里的数据基址，缺失时由来源地址推导 */
  const targets = useMemo(
    () =>
      plugins.map((plugin) => {
        const dataBase = readRecordDataBase(plugin)
        return {
          id: plugin.id,
          version: plugin.version,
          ...(dataBase === null ? {} : { dataBase }),
          ...(plugin.source?.kind === 'url' ? { sourceUrl: plugin.source.url } : {}),
        }
      }),
    [plugins]
  )

  useEffect(() => {
    const client = market()
    if (!client || targets.length === 0) {
      setUpdates(new Map())
      return
    }
    let cancelled = false
    // 请求超时与失败都在市场内静默处理，无法判断的插件不出现在结果里
    void client
      .checkUpdates(targets)
      .then((report) => {
        if (!cancelled) {
          setUpdates(report)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUpdates(new Map())
        }
      })
    return () => {
      cancelled = true
    }
  }, [targets])

  useEffect(
    () => () => {
      window.clearTimeout(confirmTimer.current)
      window.clearTimeout(uninstallTimer.current)
    },
    []
  )

  /**
   * 新装插件：把卡片滚到可视区中部，并挂上 2.4s 的业务蓝环。
   * 减弱动态下不做平滑滚动（环由样式表改成常驻静态环）。
   */
  useEffect(() => {
    if (highlightId === null) {
      return
    }
    const card = cards.current.get(highlightId)
    if (card) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      card.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    }
    const timer = window.setTimeout(onHighlightShown, HIGHLIGHT_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [highlightId, onHighlightShown])

  /**
   * 置忙执行一次操作，完成后刷新列表。
   * 引擎自己会用 toast 说明启用、停用与卸载被拒的原因；引擎未就绪时返回 null，由调用方决定是否补充提示。
   * 操作本身抛错时同样返回 null，由调用方按失败处理。
   */
  const run = async <T,>(
    id: string,
    action: Busy['action'],
    task: (engine: PluginEngine) => Promise<T>
  ): Promise<T | null> => {
    const engine = getPluginEngine()
    if (!engine) {
      showToast({ type: 'error', key: 'pluginEngineUnavailable' })
      return null
    }
    setBusy({ id, action })
    try {
      return await task(engine)
    } catch {
      return null
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const toggle = async (plugin: PluginStateView) => {
    await run(plugin.id, 'toggle', async (engine) => {
      if (plugin.state === 'active') {
        await engine.deactivate(plugin.id)
        return
      }
      await engine.activate(plugin.id)
    })
  }

  /**
   * 内部插件组的安装：打开开关就安装，不另设「安装」文字按钮。
   * 计划与信任判定都取条目所属的来源，与市场安装走同一条路径；
   * 装完由 refresh 重读引擎列表，条目自己移入「已安装」组。
   */
  const installInternal = async ({ sourceId, id, plugin }: InternalEntry) => {
    const client = market()
    const engine = getPluginEngine()
    if (!client) {
      showToast({ type: 'error', key: 'pluginMarketUnavailable' })
      return
    }
    if (!engine) {
      showToast({ type: 'error', key: 'pluginEngineUnavailable' })
      return
    }
    const plan = client.plan(sourceId, plugin)
    if (!plan) {
      showToast({
        type: 'error',
        key: 'pluginMarketInstallUnavailable',
        params: { id: plugin.name },
      })
      return
    }
    const runtime = client.runtime(sourceId)
    const trustFailure = runtime?.trustFailure ?? null
    setBusy({ id, action: 'install' })
    try {
      // 来源信任判定一并交给引擎，只用于界面展示是否被官方认可
      const result = await engine.installFromUrl(plan.url, plan.manifest, {
        sourceType: plan.sourceType,
        dataBase: plan.dataBase,
        pluginBase: plan.pluginBase,
        ...(plan.eec === undefined ? {} : { eec: plan.eec }),
        ...(plan.eecUrls === undefined ? {} : { eecUrls: plan.eecUrls }),
        sigUrl: plan.sigUrl,
        authorPubUrl: plan.authorPubUrl,
        authorSigUrl: plan.authorSigUrl,
        catalogVerified: plan.catalogVerified,
        metaVerified: plan.metaVerified,
        revisions: plan.revisions,
        ...(plan.authorPubSha512 === undefined ? {} : { authorPubSha512: plan.authorPubSha512 }),
        ...(runtime === null ? {} : { trust: runtime.trust }),
        ...(trustFailure === null ? {} : { trustFailure }),
      })
      if (result.ok) {
        client.countInstall(sourceId, plugin)
        // 自动启用被拒时引擎已经提示原因，这里不再用安装完成盖掉它
        if (result.activation?.ok !== false) {
          showToast({ key: 'pluginInstalled', params: { id: plugin.name } })
        }
        return
      }
      // 失败只走既有气泡：未安装项不新造卡内失败行
      showToast({
        type: 'error',
        key: 'pluginInstallRejected',
        params: { id: plugin.name, reason: pluginReasonText(result.reason, result.detail) },
      })
    } catch {
      showToast({
        type: 'error',
        key: 'pluginInstallRejected',
        params: { id: plugin.name, reason: pluginReasonText('load-failed') },
      })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  /** 已启用且声明依赖该插件的插件；卸载被拒的原因由引擎提示，这里只用来避免重复提示 */
  const dependentsOf = (plugin: PluginStateView) =>
    plugins.filter(
      (other) =>
        other.id !== plugin.id &&
        other.state === 'active' &&
        other.dependencies.includes(plugin.id)
    )

  const uninstall = async (plugin: PluginStateView) => {
    const result = await run<UnloadResult>(plugin.id, 'uninstall', async (engine) => {
      try {
        return await engine.unload(plugin.id)
      } catch {
        return { removed: false, hasLeftoverData: false }
      }
    })
    // 引擎未就绪时已经提示过
    if (result === null) {
      return
    }
    if (result.removed) {
      setConfirmingUninstall(null)
      // 卸载默认保留插件本地数据，遗留数据只在有数据时提示清理入口
      if (result.hasLeftoverData) {
        showToast({ key: 'pluginUninstalledDataKept' })
      }
      return
    }
    // 被依赖时引擎的 toast 已说明原因，再补一条会覆盖它
    if (dependentsOf(plugin).length > 0) {
      return
    }
    showToast({ type: 'error', key: 'pluginUninstallFailed', params: { id: plugin.id } })
  }

  /** 卸载确认：3 秒内再点一次卡片右端的「卸载」才真正执行 */
  const armUninstall = (id: string) => {
    // 同一时刻只保留一种确认态，先撤掉可能还在的更新/重装确认
    setPending(null)
    window.clearTimeout(confirmTimer.current)
    setConfirmingUninstall(id)
    window.clearTimeout(uninstallTimer.current)
    uninstallTimer.current = window.setTimeout(() => setConfirmingUninstall(null), CONFIRM_MS)
  }

  const cancelUninstall = () => {
    window.clearTimeout(uninstallTimer.current)
    setConfirmingUninstall(null)
  }

  /** 撤销更新或重装的确认态 */
  const cancelConfirm = () => {
    window.clearTimeout(confirmTimer.current)
    setPending(null)
  }

  /** 更新与重装按钮的二次确认：3 秒内再次点击才真正执行 */
  const armConfirm = (id: string, kind: PendingConfirm['kind']) => {
    // 同一时刻只保留一种确认态，先撤掉可能还在的卸载确认
    setConfirmingUninstall(null)
    window.clearTimeout(uninstallTimer.current)
    setPending({ id, kind })
    window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setPending(null), CONFIRM_MS)
  }

  /** 菜单项没有禁用态，忙碌期统一由这一道拦住 */
  const guard = (task: () => void) => () => {
    if (!running) {
      task()
    }
  }

  /** 检查更新：结论合并进现有标注，随后让用户从菜单里选更新或重装 */
  const checkNow = async (plugin: PluginStateView) => {
    const client = market()
    const target = targets.find((item) => item.id === plugin.id)
    if (!client) {
      showToast({ type: 'error', key: 'pluginMarketUnavailable' })
      return
    }
    if (!target) {
      showToast({
        type: 'error',
        key: 'pluginUpdateUnavailable',
        params: { name: plugin.name },
      })
      return
    }
    setBusy({ id: plugin.id, action: 'check' })
    try {
      const report = await client.checkUpdates([target])
      const check = report.get(plugin.id)
      setUpdates((current) => {
        const next = new Map(current)
        if (check) {
          next.set(plugin.id, check)
        } else {
          next.delete(plugin.id)
        }
        return next
      })
      if (!check) {
        showToast({
          type: 'error',
          key: 'pluginUpdateUnavailable',
          params: { name: plugin.name },
        })
        return
      }
      showToast({ key: check.status === 'latest' ? 'pluginUpdateLatest' : 'pluginUpdateAvailable' })
    } catch {
      showToast({
        type: 'error',
        key: 'pluginUpdateUnavailable',
        params: { name: plugin.name },
      })
    } finally {
      setBusy(null)
    }
  }

  /** 安装计划转成引擎需要的来源信息；证书与市场安装同一口径，清单证书优先，来源证书地址按序兜底 */
  const installSourceOf = (reinstall: ReinstallPlan): InstallSource => ({
    sourceType: reinstall.plan.sourceType,
    sigUrl: reinstall.plan.sigUrl,
    authorPubUrl: reinstall.plan.authorPubUrl,
    authorSigUrl: reinstall.plan.authorSigUrl,
    ...(reinstall.plan.eec === undefined ? {} : { eec: reinstall.plan.eec }),
    ...(reinstall.plan.eecUrls === undefined ? {} : { eecUrls: reinstall.plan.eecUrls }),
    ...(reinstall.trust === null ? {} : { trust: reinstall.trust }),
    ...(reinstall.trustFailure === null ? {} : { trustFailure: reinstall.trustFailure }),
  })

  /**
   * 按指定版本重建插件：引擎没有覆盖安装的入口，先卸载旧记录再走完整安装流程，
   * 验签、清单校验与落库都与市场安装一致。安装失败时按记录里的版本回滚，避免插件就此消失。
   * 版本更新与旧记录重装共用这一条路径，区别只在目标版本与提示文案。
   */
  const rebuildPlugin = async (
    plugin: PluginStateView,
    version: string,
    kind: PendingConfirm['kind']
  ) => {
    const client = market()
    const engine = getPluginEngine()
    if (!client) {
      showToast({ type: 'error', key: 'pluginMarketUnavailable' })
      return
    }
    if (!engine) {
      showToast({ type: 'error', key: 'pluginEngineUnavailable' })
      return
    }
    const target = targets.find((item) => item.id === plugin.id)
    const next = target ? client.reinstallPlan(target, version) : null
    if (!target || !next) {
      showToast({
        type: 'error',
        key: kind === 'update' ? 'pluginUpdateUnavailable' : 'pluginReinstallUnavailable',
        params: { name: plugin.name },
      })
      return
    }
    setPending(null)
    setBusy({ id: plugin.id, action: kind })
    try {
      if (!(await engine.unload(plugin.id)).removed) {
        showToast({
          type: 'error',
          key: kind === 'update' ? 'pluginUpdateUnloadFailed' : 'pluginReinstallUnloadFailed',
          params: { name: plugin.name },
        })
        return
      }
      const result = await engine.installFromUrl(
        next.plan.url,
        next.plan.manifest,
        installSourceOf(next)
      )
      if (result.ok) {
        // 自动启用被拒时引擎已经提示原因，这里不再用更新完成盖掉它
        if (result.activation?.ok !== false) {
          showToast(
            kind === 'update'
              ? { key: 'pluginUpdated', params: { name: plugin.name, version } }
              : { key: 'pluginReinstalled', params: { name: plugin.name } }
          )
        }
        return
      }
      const previous = client.reinstallPlan(target, plugin.version)
      if (previous) {
        await engine.installFromUrl(
          previous.plan.url,
          previous.plan.manifest,
          installSourceOf(previous)
        )
      }
      showToast({
        type: 'error',
        key: kind === 'update' ? 'pluginUpdateFailed' : 'pluginReinstallFailed',
        params: { name: plugin.name, reason: pluginReasonText(result.reason, result.detail) },
      })
    } catch {
      showToast({
        type: 'error',
        key: kind === 'update' ? 'pluginUpdateFailed' : 'pluginReinstallFailed',
        params: { name: plugin.name, reason: pluginReasonText('load-failed') },
      })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const openLogs = (plugin: PluginStateView) => {
    const engine = getPluginEngine()
    let lines: readonly string[] = []
    try {
      lines = engine ? [...engine.logs(plugin.id)] : []
    } catch {
      lines = []
    }
    setLogs({ name: plugin.name, lines, capturedAt: Date.now() })
  }

  // 首读完成前不落空态：列表还没有内容可读，空态会误报「没有插件」
  if (loading) {
    return <PluginListSkeleton label={t('pluginListLoading')} />
  }
  // 引擎缺失是终态，不是加载中，仍按文案说明原因
  if (!ready) {
    return <div className={styles.empty}>{t('pluginEngineUnavailable')}</div>
  }
  if (installed.length === 0 && internal.length === 0) {
    return (
      <div className={styles.empty}>
        <div>{t('pluginEmptyInstalled')}</div>
        <Button variant="outlined" size="s" onClick={() => setPluginPanelTab('market')}>
          {t('pluginGoToMarket')}
        </Button>
      </div>
    )
  }

  return (
    <>
      {installed.length === 0 ? null : (
        <section className={styles.pluginGroup} aria-label={t('pluginGroupInstalled')}>
          <div className={styles.pluginGroupHead}>
            <div className={styles.pluginGroupTitle}>{t('pluginGroupInstalled')}</div>
          </div>
          <ul className={styles.pluginCards} role="list">
            {installed.map((plugin) => {
              const builtin = plugin.source?.kind === 'builtin'
              const active = plugin.state === 'active'
              const stateTag = stateTagOf(plugin.state)
              const check = updates.get(plugin.id) ?? null
              const legacy = isLegacyInstall(plugin)
              const confirmingUpdate = pending?.id === plugin.id && pending.kind === 'update'
              const confirmingReinstall = pending?.id === plugin.id && pending.kind === 'reinstall'
              const updating = busy?.id === plugin.id && busy.action === 'update'
              const reinstalling = busy?.id === plugin.id && busy.action === 'reinstall'
              const checking = busy?.id === plugin.id && busy.action === 'check'
              const uninstalling = busy?.id === plugin.id && busy.action === 'uninstall'
              const uninstallOpen = confirmingUninstall === plugin.id
              const status = dependency.get(plugin.id)
              const missing = status?.missing ?? []
              // 依赖未满足时启用会被引擎拒绝，开关直接置灰；停用不置灰，被依赖时按拒绝处理
              const enableBlocked = !active && missing.length > 0
              const toggleHint = active
                ? status?.dependentBlocked
                  ? t('pluginBadgeDependentBlockedHint', { id: (status?.dependents ?? []).join(', ') })
                  : undefined
                : enableBlocked
                  ? t('pluginEnableBlockedHint', { id: missing.join(', ') })
                  : undefined

              // 卡片只留名称、版本、状态与徽标在标题行，其余中性补充统一排到描述行下方
              const notes: CardNote[] = [{ text: t(sourceLabel(plugin)) }]
              if (plugin.source !== null && plugin.source.kind !== 'builtin') {
                notes.push({
                  text: t(
                    verdictTextKey(
                      plugin.sourceVerdict,
                      plugin.sourceVerdictReason,
                      plugin.sourceTrustFailure
                    )
                  ),
                  danger: plugin.sourceVerdict === 'failed',
                })
              }
              if (plugin.catalogVerified !== undefined) {
                notes.push({
                  text: t(plugin.catalogVerified ? 'pluginCatalogVerified' : 'pluginCatalogUnverified'),
                })
              }
              if (legacy) {
                notes.push({ text: t('pluginLegacyInstallHint') })
              }
              if (plugin.sourceVerdict === 'confirmed' && isUnlistedTrust(plugin.sourceTrust)) {
                notes.push({ text: t('pluginMarketNotListed') })
              }
              if (builtin) {
                notes.push({ text: t('pluginBuiltinUninstallHint') })
              }

              // 详情 / 日志 / 检查更新常驻；更新与重装只在有结论或旧记录时出现，卸载对内置插件不开放
              const options: MenuOption[] = [
                {
                  key: 'detail',
                  label: t('pluginCardDetails'),
                  icon: <IconSettingsOutline16 />,
                  onSelect: guard(() => openPluginDetail(plugin.id)),
                },
                {
                  key: 'logs',
                  label: t('pluginCardLogs'),
                  icon: <IconDataOutline16 />,
                  onSelect: guard(() => openLogs(plugin)),
                },
                {
                  key: 'check',
                  label: checking ? t('pluginOperationBusy') : t('pluginCardCheckUpdate'),
                  icon: <IconSearchOutline16 />,
                  onSelect: guard(() => void checkNow(plugin)),
                },
              ]
              // 选中只武装确认：真正执行要再点一次卡右端原地换出来的确认按钮
              if (check?.status === 'outdated') {
                options.push({
                  key: 'update',
                  label: updating ? t('pluginOperationBusy') : t('pluginUpdateAvailable'),
                  icon: <IconDownloadOutline16 />,
                  onSelect: guard(() => armConfirm(plugin.id, 'update')),
                })
              }
              if (legacy) {
                options.push({
                  key: 'reinstall',
                  label: reinstalling ? t('pluginOperationBusy') : t('pluginActionReinstall'),
                  icon: <IconRefreshOutline16 />,
                  onSelect: guard(() => armConfirm(plugin.id, 'reinstall')),
                })
              }
              if (!builtin) {
                options.push({
                  key: 'uninstall',
                  label: t('pluginActionUninstall'),
                  icon: <IconTrashOutline16 />,
                  danger: true,
                  onSelect: guard(() => armUninstall(plugin.id)),
                })
              }

              /** 已武装的二次确认：卡右端在 3 秒内换成确认对，超时回归 */
              const armed =
                uninstallOpen
                  ? 'uninstall'
                  : confirmingUpdate && check?.status === 'outdated'
                    ? 'update'
                    : confirmingReinstall && legacy
                      ? 'reinstall'
                      : null

              return (
                <li
                  key={plugin.id}
                  ref={(node) => {
                    if (node) {
                      cards.current.set(plugin.id, node)
                    } else {
                      cards.current.delete(plugin.id)
                    }
                  }}
                  className={styles.pluginCard}
                  role="listitem"
                  aria-busy={busy?.id === plugin.id}
                  data-plugin-highlight={highlightId === plugin.id ? '' : undefined}
                >
                  <div className={styles.pluginCardHead}>
                    {/* 插件的状态视图没有图标字段，统一用插件字形占位 */}
                    <div className={styles.pluginCardIcon} aria-hidden="true">
                      <IconPluginOutline16 />
                    </div>
                    <div className={styles.pluginCardMain}>
                      <div className={styles.pluginCardTitleRow}>
                        <button
                          type="button"
                          className={styles.pluginCardTitle}
                          onClick={() => openPluginDetail(plugin.id)}
                        >
                          {plugin.name}
                        </button>
                        <span className={styles.pluginMetaTag}>{plugin.version}</span>
                        {stateTag === null ? null : (
                          <span className={styles.pluginStatusTag}>{t(stateTag)}</span>
                        )}
                        {status?.dependencyMissing ? (
                          <span
                            className={clsx(styles.dependencyBadge, styles.dependencyBadgeUnmet)}
                            title={t('pluginBadgeDependencyMissingHint', { id: missing.join(', ') })}
                          >
                            {t('pluginBadgeDependencyMissing')}
                          </span>
                        ) : null}
                        {status?.dependentBlocked ? (
                          <span
                            className={styles.dependencyBadge}
                            title={t('pluginBadgeDependentBlockedHint', {
                              id: (status?.dependents ?? []).join(', '),
                            })}
                          >
                            {t('pluginBadgeDependentBlocked')}
                          </span>
                        ) : null}
                        {plugin.sourceType === 'inner' && plugin.source?.kind === 'url' ? (
                          <span className={styles.endorsedBadge}>{t('pluginEndorsedBadge')}</span>
                        ) : null}
                      </div>
                      <div className={styles.pluginCardDesc}>{plugin.id}</div>
                      <div>
                        {notes.map((note, index) => (
                          <Fragment key={index}>
                            {index > 0 ? ' · ' : null}
                            <span className={note.danger ? styles.errorText : styles.caption}>
                              {note.text}
                            </span>
                          </Fragment>
                        ))}
                      </div>
                      {/* 确认态下补一句说明，讲清为什么要再点一次 */}
                      {armed === null ? null : (
                        <div className={styles.caption} role="status">
                          {armed === 'uninstall'
                            ? `${t('pluginUninstallDescription', { name: plugin.name })} ${t('pluginUninstallKeepDataHint')}`
                            : t(armed === 'update' ? 'pluginUpdateHint' : 'pluginReinstallHint')}
                        </div>
                      )}
                    </div>
                    {/* 确认态把开关与菜单原地换成「危险按钮 + 取消」，3 秒后回归 */}
                    <div className={styles.pluginCardEnd}>
                      {armed === 'uninstall' ? (
                        <>
                          <Button
                            variant="danger"
                            size="s"
                            disabled={running}
                            onClick={() => void uninstall(plugin)}
                          >
                            {uninstalling ? t('pluginOperationBusy') : t('pluginActionUninstall')}
                          </Button>
                          <Button
                            variant="outlined"
                            size="s"
                            disabled={running}
                            onClick={cancelUninstall}
                          >
                            {t('cancel')}
                          </Button>
                        </>
                      ) : armed === 'update' && check !== null ? (
                        <>
                          <Button
                            variant="danger"
                            size="s"
                            disabled={running}
                            onClick={() => void rebuildPlugin(plugin, check.latest, 'update')}
                          >
                            {updating ? t('pluginOperationBusy') : t('pluginUpdateConfirm')}
                          </Button>
                          <Button
                            variant="outlined"
                            size="s"
                            disabled={running}
                            onClick={cancelConfirm}
                          >
                            {t('cancel')}
                          </Button>
                        </>
                      ) : armed === 'reinstall' ? (
                        <>
                          <Button
                            variant="danger"
                            size="s"
                            disabled={running}
                            onClick={() => void rebuildPlugin(plugin, plugin.version, 'reinstall')}
                          >
                            {reinstalling ? t('pluginOperationBusy') : t('pluginReinstallConfirm')}
                          </Button>
                          <Button
                            variant="outlined"
                            size="s"
                            disabled={running}
                            onClick={cancelConfirm}
                          >
                            {t('cancel')}
                          </Button>
                        </>
                      ) : (
                        <>
                          {/* 开关自己承担 switch 语义，轨道与圆钮由 .pluginSwitch 画 */}
                          <button
                            type="button"
                            role="switch"
                            aria-checked={active}
                            aria-label={t('pluginActionEnable')}
                            className={styles.pluginSwitch}
                            disabled={running || enableBlocked}
                            title={toggleHint}
                            onClick={() => void toggle(plugin)}
                          />
                          <Menu options={options}>
                            {({ toggle: toggleMenu }) => (
                              <IconButton
                                icon={<IconEllipsisOutline16 />}
                                aria-label={t('more')}
                                onClick={toggleMenu}
                              />
                            )}
                          </Menu>
                        </>
                      )}
                    </div>
                  </div>
                  {plugin.error ? (
                    <div className={styles.pluginCardReason}>{pluginReasonText(plugin.error)}</div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {internal.length === 0 ? null : (
        <section className={styles.pluginGroup} aria-label={t('pluginGroupInternal')}>
          <div className={styles.pluginGroupHead}>
            <div className={styles.pluginGroupTitle}>{t('pluginGroupInternal')}</div>
          </div>
          <ul className={styles.pluginCards} role="list">
            {internal.map((entry) => {
              const { id, plugin, sourceId } = entry
              const installing = busy?.id === id && busy.action === 'install'
              return (
                <li
                  key={sourceId + '/' + plugin.key}
                  className={styles.pluginCard}
                  role="listitem"
                  aria-busy={installing}
                >
                  <div className={styles.pluginCardHead}>
                    <div className={styles.pluginCardIcon} aria-hidden="true">
                      <IconPluginOutline16 />
                    </div>
                    <div className={styles.pluginCardMain}>
                      <div className={styles.pluginCardTitleRow}>
                        {/* 未安装项没有可打开的详情页，名称只是文字 */}
                        <span className={styles.pluginCardTitleText}>
                          {plugin.meta?.name ?? plugin.name}
                        </span>
                        {plugin.latest === null ? null : (
                          <span className={styles.pluginMetaTag}>{plugin.latest}</span>
                        )}
                        <span className={clsx(styles.pluginStatusTag, styles.pluginTagNeutral)}>
                          {t('pluginTagUninstalled')}
                        </span>
                      </div>
                      <div className={styles.pluginCardDesc}>{id}</div>
                    </div>
                    <div className={styles.pluginCardEnd}>
                      {/* 打开开关即安装：装完由 refresh 把条目移进上一组 */}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={false}
                        aria-label={installing ? t('pluginInstalling') : t('pluginActionInstall')}
                        className={styles.pluginSwitch}
                        disabled={running}
                        onClick={() => void installInternal(entry)}
                      />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {logs ? (
        <Modal
          title={t('pluginLogsTitle', { name: logs.name })}
          closable
          onClose={() => setLogs(null)}
        >
          <div className={styles.caption}>
            {t('pluginLogsCapturedAt', { time: formatDateTime(logs.capturedAt) ?? '' })}
          </div>
          {logs.lines.length === 0 ? (
            <div className={styles.empty}>{t('pluginLogsEmpty')}</div>
          ) : (
            <div className={styles.logList}>
              {logs.lines.map((line, index) => (
                <div key={index} className={styles.logLine}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </Modal>
      ) : null}
    </>
  )
}

/**
 * 首读占位：与卡片同刻度的四行骨架。
 * 行盒高度取真实文字行的行高（组标题 14/22、卡标题 14/20、卡描述 13/18），
 * 图标位沿用 48 的卡图标盒，右端预留开关 36 + 间距 8 + 图标钮 28。
 */
const PluginListSkeleton = ({ label }: { label: string }) => (
  <div className={styles.pluginGroup} role="status" aria-label={label}>
    <div className={styles.pluginGroupHead} aria-hidden="true">
      <span className={clsx(styles.skeletonText, styles.skeletonHeading)}>
        <span className={clsx(styles.skeletonFill, styles.skeletonBar)} />
      </span>
    </div>
    <ul className={styles.pluginCards} aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <li key={row} className={styles.pluginCard}>
          <div className={styles.pluginCardHead}>
            <span
              className={clsx(styles.pluginCardIcon, styles.skeletonFill, styles.skeletonIcon)}
            />
            <div className={styles.pluginCardMain}>
              <span className={clsx(styles.skeletonText, styles.skeletonTitle)}>
                <span className={clsx(styles.skeletonFill, styles.skeletonBar)} />
              </span>
              <span className={clsx(styles.skeletonText, styles.skeletonDesc)}>
                <span className={clsx(styles.skeletonFill, styles.skeletonBar)} />
              </span>
            </div>
            <div className={styles.skeletonActions} />
          </div>
        </li>
      ))}
    </ul>
  </div>
)