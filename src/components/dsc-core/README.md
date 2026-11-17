# dsc-core

`dsc-core` 是 DeepSeek-Chat-Enhanced（下称 dsc）内核的逻辑归属与唯一出口。它不物理搬迁既有文件，而是用薄门面把内核能力收敛成少量内部接口，只交给 `dsc-plugin-engine` 使用。

## 归属边界

以下既有目录与模块在逻辑上属于 dsc-core，代码位置保持不变，仍由既有入口加载：

| 归属范围 | 职责 | 对插件可见性 |
|:---:|:---:|:---:|
| `src/app/` | 应用壳、主题、视口 | 禁止 |
| `src/components/base/` | Button、Modal、Toast、Tooltip 等基础组件 | 仅 Toast 经 `notify` 间接可见 |
| `src/components/chatInput/`、`files/`、`markdown/`、`messages/`、`search/`、`session/`、`settings/`、`sider/` | 业务 UI | 禁止 |
| `src/services/chat/` | 会话读写、分支、草稿、IndexedDB 持久化、历史导入导出 | 仅摘要与只读视图可见 |
| `src/services/api/` | API 客户端、SSE、错误分类 | 禁止 |
| `src/services/settings.ts` | 本机设置与 API Key | 仅语言可见 |
| `src/services/attachments.ts` | 附件校验与上传 | 禁止 |
| `src/services/markdown/`、`speech/`、`location.ts`、`locationData.ts`、`uploadExts.ts` | 渲染、朗读、位置、扩展名清单 | 禁止 |
| `src/i18n/` | 文案与语言切换 | 仅经 `notify` 与引擎告警使用 |
| `src/utils/`、`src/brand.ts` | 工具函数、品牌常量 | 禁止 |
| `src/main.tsx`、`src/app/App.tsx`、`rspack.config.ts` | 入口与构建 | 禁止 |

不物理搬迁的理由：rspack 入口固定为 `./src/main.tsx`，全仓 200 余文件使用相对导入与 CSS Modules，搬迁会破坏导入路径、样式引用与产物路径。

## 目录结构

```
dsc-core/
├── index.ts       # 唯一对外门面，只给 dsc-plugin-engine 使用
├── types.ts       # 核心接口与能力类型
├── registry.ts    # 核心服务注册表
├── guard.ts       # 调用凭证与绕过检测
├── net.ts         # net:fetch 的唯一实现：https GET、体积与超时约束
├── plugin-data.ts # plugins:storage 的唯一实现：localStorage 与 64KB 配额
└── README.md      # 归属边界与接口说明
```

## 内部接口

`openCore(credential)` 返回 `CoreApi`。每个方法都要带上引擎签发的 `CoreCall`，其中包含凭证与单次调用票据：

| 能力标识 | 方法 | 说明 | 权限级别 |
|:---:|:---:|:---:|:---:|
| `sessions:list` | `listSessions` | 会话摘要列表，不含消息 | 可开放 |
| `sessions:read` | `readSession` | 单个会话只读视图，附件只保留名称、大小与是否为图片 | 需脱敏 |
| `sessions:rename` | `renameSession` | 改名，标题裁剪到 120 字符，空标题拒绝 | 需限流 |
| `events:session` | `subscribe` | 订阅 `session:changed`，只带 `activeId` | 可开放 |
| `notify` | `notify` | 复用既有 Toast 与 i18n 文案键 | 需限流 |
| `settings:locale` | `currentLocale` | 只读当前语言 | 可开放 |
| `net:fetch` | `fetchText` | 读取外源文本资源，只有 https 与 GET | 需限流 |
| `plugins:storage` | `readPluginEntry`、`writePluginEntry`、`removePluginEntry` | 插件自身的键值数据，单插件 64KB | 需限流 |
| `plugins:data-clear` | `clearPluginData` | 清除单个插件的全部数据，只供引擎卸载时调用 | 仅引擎 |

永久不开放：API Key、`zustand` store 原始句柄、IndexedDB 句柄与事务、附件上传与原件、任意网络请求（`net:fetch` 是唯一例外，且只对内置插件开放）、任意 DOM 操作。

## 外源请求约束

`net.ts` 把 `net:fetch` 的全部约束收敛在一处，调用方无法放宽：

| 约束 | 规定 |
|:---:|:---:|
| 协议 | 只允许 `https:`，重定向后的最终地址同样校验 |
| 方法 | 只允许 GET |
| 请求头 | 不发送自定义请求头，`credentials` 固定 `omit`，不携带 Cookie |
| 响应类型 | 只接受 `text/*` 与 `application/json`，其余直接拒绝 |
| 响应体 | 上限 512KB，流式读取中超限立即中止并抛错 |
| 超时 | 10 秒，超时用 `AbortController` 真正中止请求 |

失败统一抛 `PluginFetchError`，`reason` 取值为 `url`、`protocol`、`timeout`、`aborted`、`status`、`content-type`、`too-large`、`network`。

## 插件数据约束

`plugin-data.ts` 为每个插件维护一个键值对象，键为 `<APP_NAME>:plugin-data:<插件 id>`：

| 约束 | 规定 |
|:---:|:---:|
| 操作 | 读取、写入、删除三种，另有引擎专用的整体清除 |
| 总量 | 单插件上限 64KB，按序列化后的 UTF-8 字节数计算 |
| 值 | 必须可 JSON 序列化，含函数、`undefined` 或循环引用时抛错 |
| 插件 id | 必须符合清单 id 规则，避免拼出跨插件的键 |
| 失败 | 统一抛 `PluginDataError`，`reason` 取值为 `invalid`、`quota`、`serialize`、`storage` |

数据保存在浏览器 localStorage，随站点数据清除而丢失，不作为可靠存储。卸载插件时引擎清除该插件的全部数据。

## 凭证与绕过检测

```
引擎 installPluginEngine()
  └── createCredential('dsc-plugin-engine')   # 唯一凭证
  └── openCore(credential)                    # 注册核心服务并拿到 CoreApi
  └── 每次转发能力调用：issueTicket(capability)
核心 requireCoreService(call, capability)
  └── 凭证不匹配 → recordBypass(capability, 'credential') → 抛错
  └── 票据缺失、过期（5 秒）或能力不符 → recordBypass(capability, 'ticket') → 抛错
  └── 通过 → 消费票据并返回实现
```

绕过事件保留最近 50 条，经引擎注册的告警出口用既有 Toast 与 `pluginBypassDetected` 文案提示，3 秒内多次触发合并为一次。绕过 dsc-plugin-engine 直接交互 dsc-core 会被识别并告警，调用同时被拒绝。
