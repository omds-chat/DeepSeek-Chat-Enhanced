import type { PluginStateView } from '../dsc-plugin-engine/types.js'

/**
 * 是否为升级前的旧安装记录：安装记录里没有任何一项校验字段。
 * 这类记录拿不到合集证书与签名材料，来源结论只能是「来源未确认」，
 * 界面据此补一条提示并给出重新安装入口；重新安装后按现有流程写入完整字段。
 */
export const isLegacyInstall = (plugin: PluginStateView): boolean =>
  plugin.verificationMissing === true && plugin.source !== null && plugin.source.kind !== 'builtin'
