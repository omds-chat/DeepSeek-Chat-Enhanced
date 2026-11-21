# dsc-core

`dsc-core` 是 DeepSeek-Chat-Enhanced 内核的逻辑归属与唯一出口。它不物理搬迁既有文件,而是用薄门面把内核能力收敛成少量内部接口,只交给 `dsc-plugin-engine` 使用。

## 归属边界

以下既有目录与模块在逻辑上属于 dsc-core,代码位置保持不变,仍由既有入口加载：

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

不物理搬迁的理由：rspack 入口固定为 `./src/main.tsx`,全仓普遍使用相对导入与 CSS Modules,搬迁会破坏导入路径、样式引用与产物路径。

## 目录结构

```
dsc-core/
├── index.ts       # 唯一对外门面，只给 dsc-plugin-engine 使用
├── types.ts       # 核心接口与能力类型
├── registry.ts    # 核心服务注册表
├── request-patch.ts # 请求补丁的落点：取切片、向引擎索取、写进请求
├── guard.ts       # 调用凭证与绕过检测
├── net.ts         # net:fetch 的唯一实现：https GET 读文本与受限 POST、体积与超时约束
├── assets.ts      # assets:read 的唯一实现：按地址取文本或字节、三态结果、体积与超时约束
├── source-catalog.ts # 供应端点能力标识表、描述校验与基址规范化、端点路径推导（纯数据模块）
├── sources.ts     # source:run 的唯一实现：按端点描述组装请求、解析回流
├── plugin-data.ts # plugins:storage 的唯一实现：localStorage 与 64KB 配额
└── README.md      # 归属边界与接口说明
```

## 内部接口

`openCore(credential)` 返回 `CoreApi`。每个方法都要带上引擎签发的 `CoreCall`,其中包含凭证与单次调用票据：

| 能力标识 | 方法 | 说明 | 权限级别 |
|:---:|:---:|:---:|:---:|
| `sessions:list` | `listSessions` | 会话摘要列表,不含消息 | 可开放 |
| `sessions:read` | `readSession` | 单个会话只读视图,附件只保留名称、大小与是否为图片 | 需脱敏 |
| `sessions:rename` | `renameSession` | 改名,标题裁剪到 120 字符,空标题拒绝 | 需限流 |
| `events:session` | `subscribe` | 订阅 `session:changed`,只带 `activeId` | 可开放 |
| `notify` | `notify` | 复用既有 Toast 与 i18n 文案键 | 需限流 |
| `settings:locale` | `currentLocale` | 只读当前语言 | 可开放 |
| `net:fetch` | `fetchText` | 读取外源文本资源,只有 https 与 GET | 需限流 |
| `net:fetch-post` | `postJson` | 发送一次 JSON POST,响应体丢弃,只回传状态码 | 仅引擎 |
| `assets:read` | `readAssetText`、`readAssetBytes` | 按地址取远端文本或字节,三态结果原样返回,只有 https 与本机回环 | 需限流 |
| `plugins:storage` | `readPluginEntry`、`writePluginEntry`、`removePluginEntry` | 插件自身的键值数据,单插件 64KB | 需限流 |
| `plugins:data-clear` | `clearPluginData` | 清除单个插件的全部数据,只供宿主设置的数据管理调用 | 仅宿主 |
| `chat:request-source` | `setRequestPatchSource` | 登记请求补丁来源,登记与撤销都只由引擎发起 | 仅引擎 |
| `source:run` | `executeSource` | 按供应端点描述执行一次能力调用,描述与凭证都由引擎在执行时给出 | 仅引擎 |

`chat:request` 是插件可见能力,但它在 core 侧没有对应方法:登记与调用都在引擎内完成,core 只在发送路径上向引擎索取一次补丁。同一份补丁的字段白名单与范围裁剪也只由引擎实现,core 不重复判定。`provider:source` 同理:插件用它声明可提供的供应端点,登记与合并都在引擎的注册表里,core 侧不留空实现;真正的执行走 `source:run`,插件拿不到那个标识。

永久不开放：API Key、`zustand` store 原始句柄、IndexedDB 句柄与事务、附件上传与原件、任意网络请求(`net:fetch` 与 `assets:read` 是两条受限例外:前者只对内置插件开放,后者只按地址读取资产且仅 https 与本机回环)、任意 DOM 操作。

## 按供应端点执行

`sources.ts` 是 `source:run` 的唯一实现。core 按能力维度执行,不认识厂商:调用方给一份供应端点描述(provider endpoint,与插件安装来源不是一回事)、一个能力标识与载荷,内部按描述的 `format` 组装请求、按 `format` 解析回流。

描述字段见 `source-catalog.ts`:`id`、`label`、`format`、`baseUrl`、`capabilities`,以及按能力覆盖端点路径的 `endpoints`。端点路径缺省按 `format` 推导:`anthropic-messages` 用 `/anthropic/v1/messages` 与 `/models`,`openai-chat` 用 `/v1/chat/completions` 与 `/v1/models`。

基址由 `normalizeSourceBaseUrl` 规范化后再用于比对与拼接:去首尾空白、主机转小写、去默认端口、去尾斜杠,带 query、hash 或内嵌用户名密码的地址直接拒绝。执行入口对传入的基址再规范化一次,因此调用方给的字符串与注册表里的值不会分叉成两个地址。

| 能力标识 | 形态 | 已落地 | 说明 |
|:---:|:---:|:---:|:---:|
| `text.generate` | 流式回流 | 是 | 组装一轮对话请求;回流折成文本、思考、标题与结束四类事件 |
| `models.list` | 一次性结果 | 是 | 读模型清单,只取 `id` |
| `reasoning.think` | 流式回流 | 否 | 思考过程单独成能力 |
| `vision.image` | 流式回流 | 否 | 图片输入与文本回流 |
| `document.read` | 一次性结果 | 否 | 文档输入转文本 |
| `audio.asr` | 一次性结果 | 否 | 音频转文本 |
| `audio.tts` | 二进制回流 | 否 | 文本转音频 |
| `tool.web-search` | 一次性结果 | 否 | 一次查询与结果条目 |
| `tool.read-url` | 一次性结果 | 否 | 按地址取回正文 |

`text.generate` 的请求体与既有发送路径逐字段一致:安全审核固定开启,阅读链接始终声明,联网搜索与标题生成按载荷开关声明,温度、核采样、输出上限与停止词只在载荷给出时出现。两条已落地能力都打到既有 DeepSeek 端点,请求头与流式解析沿用 `services/api/client.ts` 的同一份实现。

失败按 `CoreSourceError` 抛出,`reason` 取值为 `capability`(描述没有声明这项能力)、`credential`(凭证为空)、`endpoint`(基址不可用)与 `unsupported`(能力尚未落地)。凭证随调用给出,只在这一次调用里使用,不落盘,也不进入任何回流事件。

## 外源请求约束

`net.ts` 把 `net:fetch` 的全部约束收敛在一处,调用方无法放宽：

| 约束 | 规定 |
|:---:|:---:|
| 协议 | 只允许 `https:`,重定向后的最终地址同样校验 |
| 方法 | 只允许 GET |
| 请求头 | 不发送自定义请求头,`credentials` 固定 `omit`,不携带 Cookie |
| 响应类型 | 只接受 `text/*` 与 `application/json`,其余直接拒绝 |
| 响应体 | 上限 512KB,流式读取中超限立即中止并抛错 |
| 超时 | 10 秒,超时用 `AbortController` 真正中止请求 |

### 计数请求的额外约束

`postJson` 是 `net:fetch-post` 的唯一实现,与 GET 分开注册,插件仍只申请 `net:fetch`：

| 约束 | 规定 |
|:---:|:---:|
| 协议 | 只允许 `https:` |
| 方法 | 只允许 POST,请求体固定 JSON,`Content-Type` 固定 `application/json` |
| 请求头 | 不发送自定义请求头,`credentials` 固定 `omit` |
| 重定向 | 不跟随,出现 3xx 或 `opaqueredirect` 直接拒绝 |
| 请求体 | 上限 4KB,超出直接拒绝 |
| 响应体 | 上限 4KB,读到上限即停止并丢弃,不交给调用方 |
| 超时 | 5 秒,超时用 `AbortController` 真正中止请求 |

失败统一抛 `PluginFetchError`,`reason` 取值为 `url`、`protocol`、`timeout`、`aborted`、`status`、`content-type`、`too-large`、`body`、`redirect`、`network`。

## 资产读取约束

`assets.ts` 是 `assets:read` 的唯一实现,为需要按地址读取远端资产包的插件提供只读通道。它与 `net:fetch` 共用约束思路,但授权口径不同:`assets:read` 对全部插件可见,`net:fetch` 只对内置插件开放,因此两者分开实现、分开限流。

| 约束 | 规定 |
|:---:|:---:|
| 协议 | 只允许 `https:`;本机回环主机(`localhost`、`127.0.0.1`、`[::1]`)允许 `http:`;重定向后的最终地址按同一规则再校验 |
| 凭证 | 不携带 Cookie(`credentials: 'omit'`),不发送自定义请求头;地址里内嵌用户名或密码时直接拒绝 |
| 方法 | 只允许 GET |
| 响应类型 | 不做限制,内容是否可用由插件判断 |
| 响应体 | 上限 512KB,流式读取中超限立即中止并抛错 |
| 超时 | 10 秒,超时用 `AbortController` 真正中止请求 |

### 三态结果

失败原因在半途无法归类,因此读取结果按观察到的事实分三态原样返回,引擎不做二次归类:

| 形态 | 含义 | 典型成因 |
|:---:|:---:|:---:|
| `content` | 取到内容,带最终地址、响应类型与文本或字节 | 对方放行跨域且返回 2xx |
| `status` | 拿到明确的 HTTP 状态码,没有内容 | 对方放行跨域但返回非 2xx;或响应头已到达而读体中断 |
| `no-status` | 只有网络层失败,没有任何状态码 | 地址无效、连接失败,或对方未放行跨域 |

`status` 与 `no-status` 的分界是“有没有拿到状态码”:拿到状态码说明对方已放行跨域,没有状态码时既可能是地址无效,也可能是对方未开启跨域;引擎不猜是哪一种,把两种可能原样交给插件。引擎侧能够确定的拒绝(地址不是绝对地址、协议不符、地址内嵌凭证、体积超限、超时、取消)统一抛 `PluginAssetError`,`reason` 取值为 `url`、`protocol`、`credential`、`too-large`、`timeout`、`aborted`。

## 插件数据约束

`plugin-data.ts` 为每个插件维护一个键值对象,键为 `<APP_NAME>:plugin-data:<插件 id>`：

| 约束 | 规定 |
|:---:|:---:|
| 操作 | 读取、写入、删除三种,另有引擎专用的整体清除 |
| 总量 | 单插件上限 64KB,按序列化后的 UTF-8 字节数计算 |
| 值 | 必须可 JSON 序列化,含函数、`undefined` 或循环引用时抛错 |
| 插件 id | 必须符合清单 id 规则,避免拼出跨插件的键 |
| 失败 | 统一抛 `PluginDataError`,`reason` 取值为 `invalid`、`quota`、`serialize`、`storage` |

数据保存在浏览器 localStorage,随站点数据清除而丢失,不作为可靠存储。卸载插件不清除该插件的全部数据,清理入口在宿主设置的数据管理中。

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

绕过事件保留最近 50 条,经引擎注册的告警出口用既有 Toast 与 `pluginBypassDetected` 文案提示,3 秒内多次触发合并为一次。绕过 dsc-plugin-engine 直接交互 dsc-core 会被识别并告警,调用同时被拒绝。
