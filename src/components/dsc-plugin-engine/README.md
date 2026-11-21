# dsc-plugin-engine

`dsc-plugin-engine` 是 DeepSeek-Chat-Enhanced 的内置组件,模仿 DeepSeekRuntime(下称 dsh)的插件机制做浏览器内最小实现。它向 `dsc-core` 申请内部接口,再封装成受限能力对象交给插件。

## 目录结构

```
dsc-plugin-engine/
├── index.ts        # 引擎入口：安装、启停、卸载、启动恢复
├── types.ts        # 插件契约（manifest、context、contribution）
├── loader.ts       # 浏览器内加载插件运行时 js 产物
├── capabilities.ts # 能力白名单与受限代理（安全封装层）
├── requestPatch.ts # 请求补丁的白名单、范围裁剪与合并
├── registry.ts     # 插件注册表、依赖与冲突校验、内置 id 集合
├── db.ts           # 安装记录持久化（IndexedDB，不可用时降级为内存）
├── storage.ts      # 旧版 localStorage 记录的读取与清理，仅用于迁移
├── localPackage.ts # 本地离线包解析与校验：zip、tgz、meta.json、签名
├── pluginId.ts     # 插件 id 规则：清单插件名转 id 的唯一实现
├── versionRange.ts # 版本范围规则：单段比较表达式，清单 engines 与离线包 dependencies.dsc 共用
├── signature.ts    # 产物签名校验：合集 CMS 分离验签与作者裸签名,作者公钥按 L2 清单哈希把关
├── builtin.ts      # 内置插件清单与工厂
└── README.md       # 机制说明与 dsh 映射表
```

## 机制

### 清单

| 字段 | 必填 | 说明 |
|:---:|:---:|:---:|
| `id` | 是 | 小写字母开头,允许数字与连字符,3 到 64 字符 |
| `name` | 是 | 展示名称,不得为空 |
| `version` | 是 | `主版本.次版本.修订号` |
| `engines` | 否 | 兼容的 dsc-core 版本范围,只接受单段表达式,支持 `^`、`~`、`>=`、`<=` 与精确版本 |
| `dependencies` | 否 | 依赖的插件 id,安装时须已存在,激活时须已激活 |
| `conflicts` | 否 | 冲突的插件 id,同时安装会被拒绝 |
| `capabilities` | 是 | 申请的能力,必须在核心能力表内且不得重复 |
| `contributions` | 否 | 订阅的贡献点(`session:changed`、`chat:before-request`),必须在贡献点表内且不得重复 |

清单的 `id` 由插件名收敛而来：去掉 `@scope/` 前缀后转小写,非 `[a-z0-9-]` 的字符折叠为连字符,再去掉首尾连字符。收敛结果立即按清单规则 `^[a-z][a-z0-9-]{2,63}$` 校验,字符形态或长度不合规时安装按 `invalid-manifest` 拒绝,原因说明指向插件命名而不是笼统的清单非法。规则只有 `pluginId.ts` 一处实现,离线包、在线安装与插件市场都引用它,同一插件经不同路径得到同一个 id。

清单可以随产物一起导出：`export const manifest = {...}`,也可以挂在 `default` 导出对象上,模块顶层优先。`installFromUrl(url)` 省略清单时使用产物自带的 `manifest`;两者都没有时安装被拒绝,原因为 `invalid-manifest`。

调用方传入清单时以传入的为准,但 `contributions` 允许后补:传入的清单没有该字段(即 `undefined`,不是空数组)时,安装阶段用产物导出清单的 `contributions` 补齐;传入清单已声明该字段(含空数组)时保持原样,产物多出来的贡献点不会越过调用方的声明。插件市场与离线包都由 `meta.json` 推导清单,`meta.json` 可能没写 `contributions`,这条补齐规则让两种渠道装出的插件照样能登记事件处理器与请求前处理器。

`installFromUrl(url, manifest?, source?)` 的 `source` 携带来源类型、来源信任判定与签名材料：`sourceType` 取 `inner`、`awesome`、`outer`、`local` 之一,缺省按 `outer` 处理;`trust` 与 `trustFailure` 是插件市场给出的信任清单判定,只用于界面展示来源是否被官方认可,不参与来源结论。签名材料共五项：`eec` 是信任清单登记的合集 EEC 证书 PEM,`eecUrls` 是来源自带的证书地址列表,按顺序为 `<base>/certs/<合集 id>/<合集 id>-eec.crt`、`<base>/certs/<合集 id>-eec.crt` 与兜底的 `<base>/eec.pem`: 第一档是当前公开发布布局,优先取它;第二档的扁平路径只在旧站点存在,留作兼容;第三档是最早的布局,只作最后兜底;三档都取不到才算拿不到证书。前两档的取舍在于兼容范围: 保留扁平路径是为了不必逼迫旧站点与仓库同时迁移,代价是新旧两种布局都要尝试,新来源只应提供嵌套路径。`eec` 与 `eecUrls` 都有时优先用 `eec`,省一次请求;拿到证书后先用内置根 CA 校验证书链,通过才做合集 CMS 分离验签,链不通过时结论为 `failed` 且不发起 CMS 验签。`sigUrl` 是 `plugin.js.sig` 地址(缺省为 `<url>.sig`);`authorPubUrl` 与 `authorSigUrl` 是作者公钥与作者签名地址(后者缺省为 `<url>.author.sig`),两者齐全时做作者裸签名验签;作者签名是可选材料,缺其中任一项或验签不通过都不阻断安装。安装阶段先校验产物签名,不通过只提示用户,仍照常安装,签名状态标记为 `failed`。

`source` 还可携带目录数据的三层清单结论：`catalogVerified` 是 L1 清单的结论,`metaVerified` 是该版本 L3 清单的结论,`revisions` 是各层 `revision`,`authorPubSha512` 是 L2 清单登记的 `author_pub.pem` 哈希。前三项只写进安装记录,不参与来源结论;`authorPubSha512` 用于把关作者公钥:引擎拉到的公钥字节与该哈希不一致时不采用该公钥,作者签名按未校验处理,合集 CMS 验签不受影响。

`source` 还可携带两个目录地址：`dataBase` 是该版本目录(`<base>/plugins/<作者>/<插件>/<版本>/`),`pluginBase` 是插件目录(`<base>/plugins/<作者>/<插件>/`)。两者缺省时由 `url` 推导:`deriveDataBase` 去掉最后一段文件名,`derivePluginBase` 再去掉版本号。安装时两个地址一并写入安装记录,后续检查更新直接按 `dataBase` 请求 `versions.json` 与 `meta.json`,不再从来源根目录的 `plugins.json` 反查。

### 生命周期

```
install      → registered
activate     → active     （依赖未激活或抛错、超时则 failed）
deactivate   → inactive   （先调插件 deactivate，再执行 disposers 并清空贡献点）
unload       → 移除记录   （存在已激活的下游依赖时拒绝）
```

### 能力与限流

| 能力 | 时间窗内上限 | 单次超时 | 插件可见形态 |
|:---:|:---:|:---:|:---:|
| `sessions:list` | 30 次 / 10 秒 | 3 秒 | `context.sessions.list` |
| `sessions:read` | 30 次 / 10 秒 | 3 秒 | `context.sessions.read` |
| `sessions:rename` | 5 次 / 10 秒 | 同步调用 | `context.sessions.rename` |
| `events:session` | 5 次 / 10 秒(仅登记) | 同步调用 | `context.events.on` |
| `notify` | 10 次 / 10 秒 | 同步调用 | `context.ui.notify` |
| `settings:locale` | 60 次 / 10 秒 | 3 秒 | `context.settings.locale` |
| `net:fetch` | 10 次 / 10 秒 | 内层 10 秒后中止请求 | `context.net.getText` |
| `net:fetch-post` | 10 次 / 10 秒 | 内层 5 秒后中止请求 | `context.net.postJson` |
| `assets:read` | 20 次 / 10 秒 | 内层 10 秒后中止请求 | `context.assets.readText`、`context.assets.readBytes` |
| `plugins:storage` | 100 次 / 10 秒 | 同步调用 | `context.storage.get`、`set`、`remove` |
| `chat:request` | 10 次 / 10 秒(仅登记) | 同步调用,单次预算 10 毫秒 | `context.chat.onBeforeRequest` |

表里的「同步调用」表示该成员同步返回,没有超时(同步调用不适用超时),策略表因此不给它填超时数值;`events:session` 与 `chat:request` 只登记处理器、不逐次调用,同样没有超时。超时只对异步成员生效。

登记型成员的限流按「登记次数」计:每次 `context.events.on`、每次 `context.chat.onBeforeRequest` 各占一个名额,之后的事件回调与请求前调用由引擎发起,不再占用名额。因此 `events:session` 的 5 次 / 10 秒约束的是注册次数——同一插件在一次激活内最多登记 5 个事件处理器,第 6 次登记在 10 秒窗口内抛 `PluginRateLimitError`,并提示 `pluginCallRateLimited`;窗口滚过之后可以继续登记。`chat:request` 的 10 次 / 10 秒同理。

超限抛 `PluginRateLimitError`,未授予抛 `PluginCapabilityError`,超时抛 `PluginTimeoutError`,取消抛 `PluginAbortError`;限流与超时同时用既有 Toast 提示。

`plugins:data-clear` 是引擎管理专用能力,不在 `CORE_CAPABILITIES` 内,插件清单申请它时按 `unknown-capability` 拒绝,也不会出现在插件上下文中。`net:fetch-post` 同理：它是 `context.net.postJson` 背后的独立能力标识,有自己的限流窗口与超时,插件清单不能申请,只能通过 `net:fetch` 的授予间接使用。`chat:request-source` 是第三个引擎专用标识,只在启动时登记一次补丁来源,同样不进入插件上下文。

### net:fetch 的可见性

`net:fetch` 只对内置插件开放。引擎启动时把 `builtin.ts` 里的插件 id 登记进注册表;安装校验时若清单申请了 `net:fetch` 而 id 不在集合内,直接返回 `unknown-capability`,第三方插件无法把它与一个不存在的能力区分开。能力调用层会再校验一次,防止绕过安装校验直接拿到 `context.net`。

联网受引擎管控:插件对外取数的通道只有 `context.net`(第三方当前拿不到)与 `context.assets`(只读远端资产)。第三方插件需要网页级联网时由宿主决定是否开放。这条口径是契约约束,不是技术隔离:插件产物与宿主同源运行在页面主线程里,引擎无法从技术上阻止同源代码直接调用浏览器全局的 `fetch`,直接调用属于不合规,不能作为插件可以自行联网的依据。

请求约束全部由 `dsc-core` 的 `net.ts` 落实：只允许 https 与 GET,不发送 Cookie 与自定义请求头(`credentials: 'omit'`),只接受 `text/*` 与 `application/json` 响应,响应体上限 512KB,超时 10 秒并用 `AbortController` 真正中止请求。网络失败与解析失败由插件自行降级,引擎不弹宿主提示。

`context.net.postJson` 面向不计结果的计数请求：只允许 https 与 JSON 请求体,请求体与响应体上限各 4KB,超时 5 秒,不跟随重定向,响应体丢弃只回传状态码。它复用 `net:fetch` 的授予口径,但用自己的限流窗口,避免计数请求挤占读取预算。

### assets:read

`context.assets.readText(url)` 与 `context.assets.readBytes(url)` 共用一个能力标识 `assets:read`,面向需要按地址读取远端资产包的插件(例如 https 地址上的 JSON、图片或其他二进制资产)。它与 `net:fetch` 的差别在授权口径:`assets:read` 对全部插件可见,在清单里申请即可;`net:fetch` 仍只对内置插件开放。两者都不是通用联网通道。

约束全部由 `dsc-core` 的 `assets.ts` 落实：

| 约束 | 规定 |
|:---:|:---:|
| 协议 | 只允许 https;本机回环主机(`localhost`、`127.0.0.1`、`[::1]`)允许 http;重定向后的最终地址同样校验 |
| 凭证 | 不携带 Cookie,不发送自定义请求头;地址内嵌用户名或密码直接拒绝 |
| 方法 | 只允许 GET |
| 响应类型 | 不做限制,由插件判断内容是否可用 |
| 响应体 | 上限 512KB,流式读取中超限立即中止并抛错 |
| 超时 | 10 秒,超时用 `AbortController` 真正中止请求 |

结果按观察到的事实分三态原样交给插件,引擎不猜测:

| `kind` | 含义 | 插件可以据此判断 |
|:---:|:---:|:---:|
| `content` | 取到内容,带最终地址、响应类型与 `text` 或 `bytes` | 正常消费内容 |
| `status` | 拿到明确的 HTTP 状态码,没有内容 | 对方已放行跨域,状态码就是对方给出的结论 |
| `no-status` | 只有网络层失败,没有任何状态码 | 地址无效或对方未开启跨域,两种可能无法在引擎侧区分 |

首次使用某个来源地址时,引擎向用户提示一次 `pluginAssetSourceFirstUse`(普通提示,不带错误图标)。去重键是「插件 + 来源」:同一插件重复读取同一站点只报一次,另一个插件读取同一站点仍各自报一次。提示只说明哪个插件在访问哪个站点,不替用户判断该站点是否可信。首次提示之后不再打扰用户:状态码、无状态码、读取错误与读取超时都只写该插件的插件日志;未授予与限流属于插件用法问题,仍按引擎统一口径提示。

### 请求前补丁

`chat:request` 只服务一个成员：`context.chat.onBeforeRequest(handler)`。插件在激活时登记处理器,引擎在每次发请求前同步调用一次,把处理器返回的补丁交给 `dsc-core` 写进请求参数。登记要求清单同时申请能力 `chat:request` 与贡献点 `chat:before-request`,缺任一项抛 `PluginCapabilityError`;登记与 `events.on` 一样返回释放函数,停用或卸载时由引擎执行。

处理器拿到的切片只有一项：

| 切片字段 | 内容 | 只给这一项的理由 |
|:---:|:---:|:---:|
| `lastUserMessage` | 当前请求里最后一条用户消息的文本 | 补丁一般按本轮提问决定是否生效,给出整段会话等于把裁剪责任移出 core |

补丁字段与收敛规则：越界按边界裁剪,未知字段静默丢弃,空白字符串按未提供处理。

| 字段 | 形态 | 范围 | 落到请求的字段 |
|:---:|:---:|:---:|:---:|
| `temperature` | 数字 | 0 到 2 | `temperature` |
| `topP` | 数字 | 0 到 1 | `top_p` |
| `maxTokens` | 正整数 | 1 到 4096,小数四舍五入 | `max_tokens` |
| `stop` | 字符串数组 | 最多 4 条,每条最多 32 字符 | `stop_sequences` |
| `systemPromptAppend` | 字符串 | 最多 2000 字符 | 追加到 `system` 之后,以换行分隔 |
| `systemPromptReplace` | 字符串 | 最多 8000 字符 | 整体替换 `system`;与追加同时存在时追加落在替换之后 |

多个插件同时登记时按登记顺序合并：标量以后登记者为准,`stop` 取并集并在 4 条处截断,`systemPromptAppend` 按顺序以换行拼接后再按长度截断,`systemPromptReplace` 以后登记者为准。

| 约束 | 规定 |
|:---:|:---:|
| 时机 | 请求参数构造完成后、真正 `fetch` 之前,每个请求一次 |
| 预算 | 全部处理器共用 10 毫秒;调用前与返回后各判一次,单个处理器自身超预算同样按超时处理 |
| 超时或抛错 | 整份补丁作废,请求按原参数发出,不阻断请求 |
| 日志 | 超时、抛错、越界都写引擎日志;抛错同时写该插件的插件日志 |
| 提示 | 超时与越界各按插件第一次出现时提示一次(`pluginCallTimeout`、`pluginRequestPatchClamped`),不逐次打扰 |

同步计算无法中断:10 毫秒是引擎在处理器之间与处理器返回后能判定的边界,不是强制终止;超预算的处理器仍会跑完当前语句,它的返回值被丢弃。

落点在 `dsc-core`:引擎启动时经 `chat:request-source` 登记一个「给切片、返回补丁」的回调,`dsc-core/request-patch.ts` 在发送路径上调用它并写进请求。方向与 `events:session` 的订阅一致——core 在需要时回调引擎,引擎既不缓存请求,也不持有请求对象。

选择「core 在发送前向引擎索取」而不是「引擎把补丁交给 core 的方法」的理由:请求在 `src/services/chat/store.ts` 的发送路径里同步构造并立即发出,同一时刻可能有多个会话并发流式,失败重试还会重新构造一次;若由引擎把补丁预先交给 core,core 必须缓存补丁并按请求归属,而归属信息只在构造点才存在。索取形态不保存任何请求状态,core 侧的落点是一个只做字段写入的纯函数。

### 持久化与启动恢复

安装记录写入 IndexedDB 的 `<APP_NAME>-plugins` 库(版本 1,对象仓库 `plugins`,主键 `id`),与聊天历史库分开建库,互不影响。每条记录包含 `id`、`manifest`、`source_type`、`source_url`、`data_base`、`plugin_base`、`eec`、`eec_anchored`、`sig`、`author_pub`、`author_sig`、`code`、`enabled`、`installed_at`,校验失败的记录另带 `trusted: false`。

`source_type` 取 `inner`(随本体分发)、`awesome`(精选合集)、`outer`(其他在线来源)、`local`(用户上传)之一。

目录地址三个字段的语义:

| 字段 | 内容 | 用途 |
|:---:|:---:|:---:|
| `source_url` | 在线插件的 `plugin.js` 地址 | 只用于检查更新,启动流程不依赖它;`local` 来源留空 |
| `data_base` | 该版本目录,形如 `<base>/plugins/<作者>/<插件>/<版本>/` | 检查更新时直接请求该目录下的 `versions.json`、`meta.json` |
| `plugin_base` | 插件目录,形如 `<base>/plugins/<作者>/<插件>/` | 取 `versions.json` 与 `author_pub.pem` |

两个目录地址由插件市场在安装时随 `InstallSource` 传入;未传时由 `source_url` 推导(去掉文件名即版本目录,再去掉版本号即插件目录)。旧记录缺少这两个字段时,恢复阶段按同一规则推导并随落盘补齐。

签名相关字段的语义:

| 字段 | 内容 | 来源 |
|:---:|:---:|:---:|
| `eec` | 合集 EEC 证书 PEM,CMS 验签用 | 清单已登记时取清单证书,未登记时按来源自带的 `certs/<合集 id>/<合集 id>-eec.crt`、`certs/<合集 id>-eec.crt`、`eec.pem` 三档依次取 |
| `eec_anchored` | 证书链是否已在本机校验通过 | 安装与恢复时按内置根 CA 的链校验结果写入;旧记录按未校验处理,恢复时重新校验并重写 |
| `source_trust` | 信任清单判定(`trusted`、`endorsed`、`untrusted`、`unverified`) | 安装时由插件市场传入,只用于界面展示是否被官方认可;旧记录没有该字段 |
| `trust_failure` | 信任清单给出的失败原因(`missing`、`chain`、`revoked`) | 安装时由插件市场传入,只用于界面展示;来源结论的原因由本机链校验给出 |
| `sig` | `plugin.js.sig` 的 base64(DER 字节) | 版本目录下的 `plugin.js.sig` |
| `author_pub` | 作者公钥 PEM,作者裸签名验签用 | 在线插件取 `plugins/<作者>/author_pub.pem`,离线包取包内 `author_pub.pem` |
| `author_sig` | 作者签名的 base64(原始 64 字节) | `plugin.js.author.sig` |
| `catalog_verified` | 合集根目录数据是否已按 L1 清单校验通过 | 安装时由插件市场传入;旧记录没有该字段 |
| `meta_verified` | 该版本是否已按 L3 清单校验通过 | 安装时由插件市场传入;旧记录没有该字段 |
| `manifest_revisions` | 各层清单 `revision` | 安装时由插件市场传入,重装时用于回退提示 |

缺失某个字段表示这条记录没有对应的签名材料,启动校验按未校验处理。旧版的 `pub` 与 `sign` 字段(JSON 信任签名方案)不再读取,升级后已安装插件显示为未校验,重新安装即可拿到新字段。没有任何一项校验字段的记录视为旧版本安装,已安装列表在来源结论旁提示重新安装,并在操作列给出「重新安装」入口,按记录的同一版本走一次完整安装流程。

`code` 保存插件代码文本,在线与本地插件都写:在线插件在安装阶段下载 `plugin.js` 后按 UTF-8 文本存入,本地插件取离线包内的 `plugin.js`。启动恢复只用它重建 Blob URL 再 `import()`,不再为启动拉取网络;网络不可达时插件照常启动。写入前已确认代码文本可以还原成原始字节,签名针对原始字节计算,因此重建后的字节与验签时一致。单个插件代码上限 2 MB(见 `types.ts` 的 `MAX_PLUGIN_CODE_BYTES`),在线与本地共用这一上限,超限时拒绝安装并给出原因。

安装、卸载、启用与停用都立即落盘;落盘失败只写入 `engineLogs()`,不影响内存状态。IndexedDB 不可用时降级为内存存储,同样只记引擎日志,不抛错。

旧版 localStorage 键 `<APP_NAME>:plugins` 在首次启动时迁移一次：`source.kind === 'url'` 的记录转为 `outer` 并保留地址,`builtin` 转为 `inner`,`eec`、`sig` 与作者材料全部留空;迁移成功后删除旧键,失败只记日志、不阻断启动。

`installPluginEngine()` 保持同步返回,恢复在内部异步进行,不阻塞首屏渲染：

```
installPluginEngine()   # 同步：建凭证、打开核心、登记内置 id、返回实例
  └── restore()         # 异步：读取安装记录并完成旧版迁移
      ├── 先装载 builtin.ts 的内置插件（首次出现默认启用）
      ├── 再按存储顺序恢复外部插件:按存储的 code 重建模块,启动阶段不访问网络
      ├── 带签名材料时对存储的代码字节验签,不通过的记录标记不可信但仍激活
      └── 加载失败则标记 failed 并在 list() 中可见
```

宿主通过 `install()` 直接注册的插件没有可恢复来源,不写入安装记录。恢复失败的占位记录没有插件实例,`activate()` 会拒绝并提示 `pluginRestoreFailed`,但允许重新安装覆盖。

卸载插件只移除注册表与安装记录,该插件的 `plugins:storage` 数据保留:`unload()` 返回 `hasLeftoverData` 供界面提示,清理入口在设置的数据管理中。

### 运行时加载与跨源

`installFromUrl()` 先 `fetch` 产物字节,再按 UTF-8 文本存进安装记录,然后用 `loadPluginModuleFromCode()` 建 Blob URL 加载模块;安装阶段与启动阶段走同一条加载路径,启动阶段不再请求网络。`fetch` 跨源时浏览器要求托管方返回 `Access-Control-Allow-Origin`,缺失时字节拉不到,引擎按 `artifact-unreachable` 拒绝安装,原始错误只写入 `engineLogs()`。`loader.ts` 只判定协议与主机,不介入 CORS;`installFromUrl` 在拉取前用同一判定拒绝非 https 且非本机回环的地址。

### 签名校验

签名体系由两部分组成,约定见 [信任链与 PKI 签名](../../../docs/user/develop/basic/trust-chain.md):

| 签名 | 签发方 | 材料 | 验签入口 |
|:---:|:---:|:---:|:---:|
| 合集 CMS 分离签名 | 合集 EEC 证书 | `plugin.js.sig` | `src/services/integrity/cms.ts` 的 `verifyDetachedCms` |
| 作者裸签名 | 插件作者 | `plugin.js.author.sig`、`author_pub.pem` | `src/services/integrity/ed25519.ts` 的 `verifyDetachedSignature` |
| 三层清单签名 | 合集 EEC 证书 | 每层的 `manifest.json.sig` | `src/services/integrity/manifest.ts` 的 `verifyManifest`,由插件市场调用 |

只发布整站签名的来源(下称整站模型)不需要引擎侧的额外分支:它的 `plugin.js` 同样带一份 `plugin.js.sig`,签名者是来源的整站签名证书,引擎按 `eec` 与 `eecUrls` 取证书、校链、再验签,与合集的 CMS 验签走同一条通道。整站模型常见把证书放在来源根目录的 `eec.pem`,正好落在三档取件的第三档。整站模型没有 L2 清单,`authorPubSha512` 缺省,作者公钥不做哈希把关,作者签名仍按 `plugin.js.author.sig` 与 `author_pub.pem` 校验,失败只提示、不阻断安装。

CMS 签名是逐字节语义,验签对象是 `plugin.js` 的原始字节,签名者为该来源的 EEC 证书;作者签名是 Ed25519 裸签名,同样直接对原始字节验签,不做摘要预处理。`verifyDetachedCms` 要求同时传入签名者证书与根证书,函数内部先用根证书校验证书链,未通过直接返回 false,未校验链的证书不会进入验签。`signature.ts` 负责把两种签名收拢成一个 `verified`、`failed`、`unverified` 结论:合集证书先过链校验,链不通过时不发起 CMS 验签;两种材料都有时须同时通过,只有一种材料时只校验该种,都没有时为 `unverified`。证书链与 CMS 校验模块按需动态加载,未启用签名校验的构建不会把 `pkijs` 带进首屏代码。

来源结论另按四态给出,判定只看本机结论: 证书链通过且 CMS 验签通过才算已确认。

| 结论 | 含义 | 触发条件 |
|:---:|:---:|:---:|
| `confirmed` | 来源已确认 | 证书链在本机校验通过,且 CMS 验签通过 |
| `failed` | 校验未通过 | 证书链不通过(过期、非本根签发、被吊销),或拿不到证书、验签不通过 |
| `unknown` | 无法确认来源 | 完全没有来源信息 |
| `local` | 本地安装 | 用户上传的离线包,没有来源,不参与来源判定 |

目录数据的签名材料与产物签名相互独立：`plugin.js` 只按 `plugin.js.sig` 验签,目录材料缺失或验签失败只让「目录数据是否已校验」为否,不改变产物结论,也不改变来源结论。目录材料在合集模型下是三层清单,在只发布整站签名的来源下是 `web_files.json` 与逐文件签名;两种模型都只通过安装来源里的 `catalogVerified`、`metaVerified` 表达结论,引擎不需要区分模型,整站模型的 `manifest_revisions` 为空。安装记录另存 `catalog_verified`、`meta_verified` 与 `manifest_revisions`,界面按 `catalogVerified` 展示「目录数据已校验」或「目录数据未校验」;同一插件重装时若某层 `revision` 小于记录值,引擎日志记一条并给一次提示,不阻断安装。

验签证书优先取信任清单登记的那张,清单未登记时按 `eecUrls` 的顺序取来源自带的嵌套路径 `certs/<合集 id>/<合集 id>-eec.crt`、旧站点的扁平路径 `certs/<合集 id>-eec.crt` 与兜底的 `eec.pem`;三档都必须先用内置根 CA 校验证书链,链不通过时结论为 `failed`(原因 `chain` 或 `revoked`),不会发起 CMS 验签,引擎日志记一条 `certificate chain ..., cms skipped`。拿不到证书或验签不通过同样记为 `failed`(原因 `other`),其中信任清单登记了证书而证书文件缺失的情形界面单列「来源证书缺失」;只有完全没有来源信息才是 `unknown`。安装记录用 `eec_anchored` 标记证书链是否已在本机校验通过,用 `source_trust`、`trust_failure` 保存信任清单判定;启动恢复按存储的证书重新做链校验并重写标记,只有链通过且验签通过的记录才算 `confirmed`。信任清单的结论只用于界面展示,未登记时在「来源已确认」旁补一条「未在官方清单登记」的中性标注。

- 安装阶段:`installFromUrl` 按 `InstallSource` 收集材料后对刚下载的产物字节验签,不通过只提示用户,仍照常安装,记录标记为 `failed`。
- 本地安装:`inspectLocalPackage` 在预检阶段对包内 `plugin.js` 字节校验作者签名,不通过只标记 `failed` 并提示,仍可确认安装;包内没有签名材料时按 `unverified` 安装。合集签名不随离线包分发,离线包只认作者签名。
- 启动阶段:`restore()` 对每条带签名材料的记录用存储的 `code` 重建字节并验签,不发起网络请求;代码缺失时按 `no-plugin-instance` 标记失败。
- 校验不通过:仍然加载并激活该插件,记录标记为不可信(`trusted: false`)与 `failed`,提示用户「插件签名校验未通过,请自行判断是否继续使用」,记录保留在 `list()` 中供用户查看或卸载。
- 安装阶段字节拉取失败:分不清网络问题与篡改,按 `artifact-unreachable` 拒绝安装,不标记不可信。
- 安装阶段的拉取使用 `cache: 'no-store'`,避免命中旧缓存得出错误的通过结论。

### 本地安装与离线包

`inspectLocalPackage(file)` 做预检,`installFromLocalFile(file)` 是预检加提交的组合入口。二次确认在界面层完成:预检只读文件并校验,返回待安装信息与提交函数,提交前不改动注册表与安装记录,也不把 `File` 放进引擎状态。

| 包格式 | 产物位置 | 说明 |
|:---:|:---:|:---:|
| zip | 包根目录 | 根目录直接放 `meta.json`、`plugin.js`,可选作者签名 `plugin.js.author.sig` 与 `author_pub.pem`;子目录内容忽略 |
| tgz(npm 包) | `package/dist/` | 只取该目录下的文件,`package/` 下的其他内容一律忽略 |

zip 用 `fflate` 的 `unzipSync` 解压;tgz 用 `gunzipSync` 解压后交给最小 tar 读取器 `readTarEntries`,它只收普通文件条目,pax 头、GNU 长名头与目录条目跳过。两者都不新增依赖。

预检的校验顺序与失败原因:

| 检查 | 失败原因 |
|:---:|:---:|
| 扩展名为 `.zip` 或 `.tgz` | `unsupported-package` |
| 压缩包可解压 | `corrupt-package` |
| 存在 `meta.json` | `missing-meta` |
| 存在 `plugin.js` | `missing-plugin` |
| `plugin.js` 不超过 2 MB | `package-too-large` |
| `meta.json` 可解码为合法 UTF-8 | `invalid-meta` |
| `meta.json` 可解析,`name`、`version`、`author` 非空,`version` 为三段数字,`dependencies.dsc` 为单段版本范围 | `invalid-meta` |
| `plugin.js` 是可还原的 UTF-8 文本 | `corrupt-package` |
| 同时有 `plugin.js.author.sig` 与 `author_pub.pem` 时,作者签名不通过 | 不拒绝,记录标记为 `failed` |
| 只有作者签名或只有作者公钥 | 不拒绝,按 `unverified` 安装 |

`meta.json` 的 `dependencies.dsc` 会直接成为清单的 `engines`,预检与清单两侧共用 `versionRange.ts` 的单段表达式判定;失败原因的具体说明指向该字段。

只有一半签名材料时,引擎日志会记一条说明。预检通过后返回待安装信息,包含 id、名称、版本、作者、许可证、签名状态与「是否已安装同 id」;同 id 已存在时提交返回 `duplicate`,不覆盖已有记录。

提交阶段用包内代码建 Blob URL 加载模块。清单优先由 `meta.json` 的 `capabilities` 推导(与插件市场同一 id 规则),缺该字段时用产物导出的 `manifest`,两者都没有时按 `invalid-manifest` 拒绝;`meta.json` 没写 `contributions` 时,用产物导出清单的贡献点补齐,规则与在线安装一致。安装记录写入 `source_type: "local"`、留空 `source_url`、`data_base` 与 `plugin_base`,按包内材料填 `author_pub` 与 `author_sig`,并保存 `code`;离线包不写 `eec` 与 `sig`。

### 内置插件

内置插件的清单、工厂与 id 集合统一在 `builtin.ts` 维护,新增内置插件只需在该文件追加一条。当前内置插件为 `dsc-market`,源码见 `src/components/dsc-market/`,负责拉取外源插件索引并对外提供查询。

### 隔离与降级

- `activate` 与 `deactivate` 各自有超时,抛错只把该插件标记为 `failed`,引擎与其他插件继续工作;激活中途失败会先撤销已注册的贡献点与释放函数,再标记失败。
- 事件分发逐个插件、逐个处理器隔离,同步抛错与异步拒绝都只写入该插件日志。
- 请求前处理器同样逐个插件隔离:超时与抛错只让本次补丁作废,请求按原参数发出,引擎与其他插件继续工作。
- 能力调用失败不会破坏核心状态：核心侧只做只读视图转换或既有 store 方法调用。
- 插件日志按插件保存在内存,上限 100 条,经 `engine.logs(id)` 读取,不写控制台;引擎自身日志经 `engine.engineLogs()` 读取。
- 启动恢复逐个插件隔离,单个插件加载失败不影响其余插件与宿主渲染。

## dsh 映射表

| dsh 概念 | dsh 侧参考 | dsc 最小对应实现 | 落地文件 |
|:---:|:---:|:---:|:---:|
| 插件声明与清单 | 包 `package.json` 的 `dsh` 字段、`cordis.yml` 条目、配置目录 | `PluginManifest` 内联声明,安装时校验 | `types.ts`、`registry.ts` |
| 注册与加载 | `plugin-manager` 的安装操作、`cordis-plugin-loader`、`client/modules` 的懒注册表 | `install()` 注册实例;`installFromUrl()` 运行时 `import` | `index.ts`、`loader.ts` |
| 生命周期 | Cordis fiber 的挂载、激活与 `ctx.effect` 释放 | `registered` / `active` / `inactive` / `failed`,停用时执行 disposers | `index.ts`、`registry.ts` |
| 服务与依赖注入 | `ctx.<key>` 服务与 `inject` 依赖 | `PluginContext` 能力对象与 `dependencies` 校验 | `capabilities.ts`、`registry.ts` |
| 能力/贡献点注册 | `ui-slots` 的 slot 注册、`ctx.effect` 可逆副作用 | `events.on(point, handler)` 注册贡献点并返回释放函数 | `capabilities.ts` |
| 权限与沙箱边界 | profile patch 的沙箱与审批、插件在宿主进程内运行 | 能力白名单、凭证与票据、限流与超时、内置 id 白名单;联网只经 `context.net`(第三方插件不可用)与 `context.assets`(只读远端资产);插件拿不到 `CoreApi` 与 store 句柄 | `../dsc-core/guard.ts`、`capabilities.ts`、`registry.ts` |
| 错误隔离与降级 | 单条目失败只影响自身,其余插件照常运行 | 生命周期超时与 try/catch、事件逐个隔离、恢复失败标记、失败标记与 Toast | `index.ts` |
| 配置持久化 | `cordis.yml` 与配置目录 | 安装记录写 IndexedDB `<APP_NAME>-plugins` 的 `plugins` 仓库,插件配置走 `plugins:storage` 写 `<APP_NAME>:plugin-data:<id>` | `db.ts`、`../dsc-core/plugin-data.ts` |
| 内置插件 | dsh 自带插件包与内置 bundle | `builtin.ts` 清单,启动时先于外部插件装载 | `builtin.ts` |
| 热重载 | `dsh-hmr` | 未实现,刷新页面重新加载 | 无 |

只取能在浏览器里落地的最小集合：不引入 Node 内置模块、不做后端、不新增依赖,插件产物按普通 ESM 在页面内加载。

## 接入方式

引擎在 `src/main.tsx` 注册一次：

```ts
installPluginEngine()
```

之后通过 `getPluginEngine()` 取实例,用 `install`、`installFromUrl`、`inspectLocalPackage`、`installFromLocalFile`、`activate`、`deactivate`、`unload`、`list` 管理插件,用 `logs(id)`、`engineLogs()`、`bypassEvents()` 排查问题。`installFromUrl(url, manifest?, source?)` 的清单可以省略,省略时取产物自带的 `manifest` 导出;`source` 省略时来源记为 `outer` 且不校验签名。`install()` 直接注册的宿主内联插件不写安装记录。

## 示例

```ts
import { getPluginEngine } from './components/dsc-plugin-engine/index.js'

const engine = getPluginEngine()
engine?.install(
  {
    id: 'demo-plugin',
    name: 'Demo',
    version: '1.0.0',
    engines: '^1.0.0',
    capabilities: ['sessions:list', 'events:session'],
    contributions: ['session:changed'],
  },
  {
    activate(context) {
      context.events.on('session:changed', (event) => {
        context.log('active session: ' + String(event.activeId ?? 'none'))
      })
    },
  }
)
await engine?.activate('demo-plugin')

// 请求前补丁：申请 chat:request 并声明贡献点 chat:before-request
engine?.install(
  {
    id: 'demo-patch',
    name: 'Demo Patch',
    version: '1.0.0',
    engines: '^1.0.0',
    capabilities: ['chat:request'],
    contributions: ['chat:before-request'],
  },
  {
    activate(context) {
      context.chat.onBeforeRequest((preview) => {
        if (!preview.lastUserMessage.includes('简短')) {
          return null
        }
        return { maxTokens: 256, systemPromptAppend: '请尽量简短。' }
      })
    },
  }
)
await engine?.activate('demo-patch')

// 运行时安装：清单由产物自带的 manifest 导出提供
await engine?.installFromUrl('https://example.com/demo-plugin.js')

// 也可以显式传入清单，此时以传入的为准
await engine?.installFromUrl('https://example.com/demo-plugin.js', {
  id: 'demo-plugin',
  name: 'Demo',
  version: '1.0.0',
  capabilities: ['notify'],
})

// 带来源与签名材料：安装阶段先验签，不通过只提示，仍继续安装
await engine?.installFromUrl('https://example.com/demo-plugin.js', undefined, {
  sourceType: 'awesome',
  eec: collectionEecPem,
  sigUrl: 'https://example.com/demo-plugin.js.sig',
  authorPubUrl: 'https://example.com/author_pub.pem',
  authorSigUrl: 'https://example.com/demo-plugin.js.author.sig',
})

// 本地离线包:先预检,界面确认后再提交
const inspected = await engine?.inspectLocalPackage(file)
if (inspected?.ok) {
  console.log(inspected.info.name, inspected.info.version, inspected.info.signatureVerified)
  if (!inspected.info.installed) {
    await inspected.commit()
  }
}

// 不需要界面确认时也可以一次完成预检与提交
await engine?.installFromLocalFile(file)
```
