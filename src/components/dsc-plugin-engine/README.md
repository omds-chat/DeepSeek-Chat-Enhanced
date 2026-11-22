# dsc-plugin-engine

`dsc-plugin-engine` 是 DeepSeek-Chat-Enhanced 的内置组件,模仿 DeepSeekRuntime(下称 dsh)的插件机制做浏览器内最小实现。它向 `dsc-core` 申请内部接口,再封装成受限能力对象交给插件。

## 目录结构

```
dsc-plugin-engine/
├── index.ts        # 引擎入口：安装、启停、卸载、启动恢复
├── types.ts        # 插件契约（manifest、context、mount）
├── loader.ts       # 浏览器内加载插件运行时 js 产物
├── capabilities.ts # 能力白名单与受限代理（安全封装层）
├── assetDownload.ts # assets:download 的清单 assets 块校验与引擎代取下载器
├── downloadCard.ts # 下载卡片状态：按插件一卡的进度登记与取消出口（宿主组件订阅渲染）
├── requestPatch.ts # 请求补丁的白名单、范围裁剪与合并
├── registry.ts     # 插件注册表、安装与启用校验、内置 id 集合
├── dependencies.ts # 依赖关系判定：停用前置检查、依赖未满足与被依赖阻塞两种状态
├── installConflicts.ts # 安装期冲突检出：正反两个方向，与启用期同口径，检出后按对方启用状态处置
├── sources.ts      # 供应端点注册表：声明合并（能力并集）、定义比对与能力矩阵
├── pluginSettings.ts # 插件设置表面：字段描述校验、注册表与值读写门面（secret 走凭证库）
├── pluginSlots.ts   # 插件 UI 槽位：槽位枚举与白名单校验、按槽位分流的描述校验、登记表（含变更订阅）与动作、数据处理器
├── credentials.ts  # 供应端点凭证存取（IndexedDB，键为端点 id + 基址，插件不可见）
├── providerRun.ts  # 按端点执行：选端点、读凭证、调 source:run、错误归类
├── db.ts           # 安装记录与待决定冲突组的持久化（IndexedDB，不可用时降级为内存）
├── pendingConflicts.ts # 待决定冲突组：形态收敛、合并与按卸载清理
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

挂载点是插件声明要挂到宿主哪个回调位置：清单只用 `mounts` 列出位置名，具体处理器在激活时登记。

| 字段 | 必填 | 说明 |
|:---:|:---:|:---:|
| `id` | 是 | 小写字母开头,允许数字与连字符,3 到 64 字符 |
| `name` | 是 | 展示名称,不得为空 |
| `version` | 是 | `主版本.次版本.修订号` |
| `engines` | 否 | 兼容的 dsc-core 版本范围,只接受单段表达式,支持 `^`、`~`、`>=`、`<=` 与精确版本 |
| `dependencies` | 否 | 依赖的插件 id,安装、启用、停用、卸载四处都生效:安装时须已存在,激活时须已激活,停用与卸载时不得有已启用的依赖方 |
| `conflicts` | 否 | 冲突的插件 id,安装期与启用期都生效,两个方向都算:安装时任一方声明排斥另一方都检出,但不拒绝安装——对方在启用中时新插件保持停用并写入待决定记录,对方全部停用时仅警告;启用时只算 `active` 记录,冲突则停用双方并写入待决定记录,由用户选择保留哪一个 |
| `capabilities` | 是 | 申请的能力,必须在核心能力表内且不得重复 |
| `mounts` | 否 | 声明的挂载点(`session:changed`、`chat:before-request`),必须在挂载点表内且不得重复 |
| `slots` | 否 | 申请的 UI 槽位白名单(`nav.panel`、`conversation.tabs`、`settings.page`、`session.panel.section`、`nav.side`、`composer.toolbar`、`composer.notice`、`overlay.notice`、`message.actions`、`menu.item`),申请能力 `ui:slot` 后只允许登记这里逐个声明的槽位;槽位名必须在槽位枚举内且不得重复,枚举之外的槽位按 `unknown-slot` 拒绝 |
| `assets` | 否 | 声明的可下载资产,字段形状见「assets:download」一节;只允许出现在申请了能力 `assets:download` 的清单里,缺块、空块、字段不合格或 `id` 重复按 `invalid-manifest` 拒绝,出现在未申请该能力的清单里同样按 `invalid-manifest` 拒绝(二选一取「拒绝」,与槽位白名单缺失同口径) |

清单的 `id` 由插件名收敛而来：去掉 `@scope/` 前缀后转小写,非 `[a-z0-9-]` 的字符折叠为连字符,再去掉首尾连字符。收敛结果立即按清单规则 `^[a-z][a-z0-9-]{2,63}$` 校验,字符形态或长度不合规时安装按 `invalid-manifest` 拒绝,原因说明指向插件命名而不是笼统的清单非法。规则只有 `pluginId.ts` 一处实现,离线包、在线安装与插件市场都引用它,同一插件经不同路径得到同一个 id。

清单可以随产物一起导出：`export const manifest = {...}`,也可以挂在 `default` 导出对象上,模块顶层优先。`installFromUrl(url)` 省略清单时使用产物自带的 `manifest`;两者都没有时安装被拒绝,原因为 `invalid-manifest`。

调用方传入清单时以传入的为准,但 `mounts` 允许后补:传入的清单没有该字段(即 `undefined`,不是空数组)时,安装阶段用产物导出清单的 `mounts` 补齐;传入清单已声明该字段(含空数组)时保持原样,产物多出来的挂载点不会越过调用方的声明。插件市场与离线包都由 `meta.json` 推导清单,`meta.json` 可能没写 `mounts`,这条补齐规则让两种渠道装出的插件照样能登记事件处理器与请求前处理器。

`installFromUrl(url, manifest?, source?)` 的 `source` 携带来源类型、来源信任判定与签名材料：`sourceType` 取 `inner`、`awesome`、`outer`、`local` 之一,缺省按 `outer` 处理;`trust` 与 `trustFailure` 是插件市场给出的信任清单判定,只用于界面展示来源是否被官方认可,不参与来源结论。签名材料共五项：`eec` 是信任清单登记的合集 EEC 证书 PEM,`eecUrls` 是来源自带的证书地址列表,按顺序为 `<base>/certs/<合集 id>/<合集 id>-eec.crt`、`<base>/certs/<合集 id>-eec.crt` 与兜底的 `<base>/eec.pem`: 第一档是当前公开发布布局,优先取它;第二档的扁平路径只在旧站点存在,留作兼容;第三档是最早的布局,只作最后兜底;三档都取不到才算拿不到证书。前两档的取舍在于兼容范围: 保留扁平路径是为了不必逼迫旧站点与仓库同时迁移,代价是新旧两种布局都要尝试,新来源只应提供嵌套路径。`eec` 与 `eecUrls` 都有时优先用 `eec`,省一次请求;拿到证书后先用内置根 CA 校验证书链,通过才做合集 CMS 分离验签,链不通过时结论为 `failed` 且不发起 CMS 验签。`sigUrl` 是 `plugin.js.sig` 地址(缺省为 `<url>.sig`);`authorPubUrl` 与 `authorSigUrl` 是作者公钥与作者签名地址(后者缺省为 `<url>.author.sig`),两者齐全时做作者裸签名验签;作者签名是可选材料,缺其中任一项或验签不通过都不阻断安装。安装阶段先校验产物签名,不通过只提示用户,仍照常安装,签名状态标记为 `failed`。

`source` 还可携带目录数据的三层清单结论：`catalogVerified` 是 L1 清单的结论,`metaVerified` 是该版本 L3 清单的结论,`revisions` 是各层 `revision`,`authorPubSha512` 是 L2 清单登记的 `author_pub.pem` 哈希。前三项只写进安装记录,不参与来源结论;`authorPubSha512` 用于把关作者公钥:引擎拉到的公钥字节与该哈希不一致时不采用该公钥,作者签名按未校验处理,合集 CMS 验签不受影响。

`source` 还可携带两个目录地址：`dataBase` 是该版本目录(`<base>/plugins/<作者>/<插件>/<版本>/`),`pluginBase` 是插件目录(`<base>/plugins/<作者>/<插件>/`)。两者缺省时由 `url` 推导:`deriveDataBase` 去掉最后一段文件名,`derivePluginBase` 再去掉版本号。安装时两个地址一并写入安装记录,后续检查更新直接按 `dataBase` 请求 `versions.json` 与 `meta.json`,不再从来源根目录的 `plugins.json` 反查。

### 安装期校验

在线安装(`installFromUrl`)、离线包安装(`commitLocalPackage`)与宿主注册(`install`)都先经过 `checkInstallable`,校验顺序与拒绝原因如下:

| 校验 | 判定 | 拒绝原因 |
|:---:|:---:|:---:|
| 清单形态 | `id`、`name`、`version` 合规,能力与挂载点去重后都在表内 | `invalid-manifest`、`unknown-capability`、`unknown-mount` |
| 重名 | 已有同 id 且带插件实例的记录 | `duplicate` |
| 版本兼容 | `engines` 覆盖 `CORE_VERSION` | `incompatible-version` |
| 冲突 | 两个方向都检出,见下;不拒绝安装 | —(发警告气泡并按对方启用状态处置,冲突对随安装结果带回) |
| 依赖 | `dependencies` 都已登记 | `missing-dependency` |

冲突判定落在 `installConflicts.ts`,与启用期的 `activationConflicts` 同口径:本插件的 `conflicts` 命中已安装记录是正向,已安装记录的 `conflicts` 命中本插件是反向,两边互相声明合并成一条 `mutual`。检出结果里 `conflicts` 带回全部冲突对(`kind`、`declarer`、`target`),冲突对同时写进引擎日志。安装不因冲突被拒绝,处置由引擎的 `settleInstallConflicts` 按对方的启用状态决定:存在处于 `active` 的对方时,新插件保持停用、不发自动启用,涉及 `active` 对方的冲突对写入待决定记录,并发停用警告;对方全部不处于 `active` 时仅发一条冲突警告,双方状态不变,新插件照常自动启用。

两个时机的口径不同,区别在「处置的对象」:

| 时机 | 参与判定的记录 | 处置 |
|:---:|:---:|:---:|
| 安装期 | 全部安装记录,含已停用与启动失败的占位记录 | 不拒绝安装:对方在启用中时停用还没运行的新插件并写入待决定记录;对方全部停用时仅警告,新插件照常自动启用 |
| 启用期 | 只算 `active` 记录 | 同时运行:冲突涉及的启用插件全部停用并写入待决定记录 |

两个时机都不留下「都跑着」的状态:安装期把还没运行的冲突方(新插件)停掉,启用期把正在运行的冲突方停掉;判定口径一致,处置看对方记录的启用状态。

### 生命周期

```
install      → registered
activate     → active     （依赖未激活时按已停用落盘并提示;与运行中的插件冲突时停用冲突双方并等待用户决定;抛错、超时则 failed）
deactivate   → inactive   （存在已启用的依赖方时拒绝;先调插件 deactivate，再执行 disposers 并清空挂载点）
unload       → 移除记录   （存在已启用的依赖方时拒绝）
```

启用前除了检查依赖，还检查清单的 `conflicts`：声明里的某个插件只要处于 `active`，就按保守策略处置——先把冲突双方全部停用，再写入待决定记录，由用户选择保留哪一个；反向声明同样生效，正在运行的插件声明排斥本插件时也按同一策略处置。两边互相声明时合并为一条双向冲突，其余按单向冲突处理。`activate()` 的结构化结果保持不变：冲突时为 `{ ok: false, reason: 'conflict', conflicts: [...] }`，每个 `ActivationConflict` 带 `kind`（`single` 或 `mutual`）、`declarer` 与 `target`，调用方仍能拿到完整的冲突描述。

### 冲突的保守处理

冲突不留给用户「都跑着」的中间态，也不由引擎替用户选边：启用期检测到冲突时先把涉及的全部插件停下来，再把整组冲突记成待决定状态，等用户在插件页选择。安装期检出冲突时新插件本就还没运行,引擎保持它停用并把冲突写进同一条待决定记录（见「安装期校验」），正在运行的一方不被停用；本节的处置流程只针对启用期。

```
启用请求命中冲突
  1. 停用本次冲突涉及的全部启用插件（含正在运行的一方）
  2. 停用后依赖它们的插件按依赖未满足的既有口径自动停用
  3. 把整组冲突写入待决定记录（引擎自己的库）
  4. 发一条警告：冲突双方、声明方向、本次被停用的插件
  5. 用户选择保留哪一个：删除该组记录，按选择启用保留的那一个，其余保持停用
```

| 环节 | 行为 | 位置 |
|:---:|:---:|:---:|
| 检测 | 声明方声明排斥目标方（单向），或两边互相声明（双向） | `registry.ts` 的 `activationConflicts` |
| 停用 | 涉及的已启用插件全部停用，`enabled` 一并置为 false | `index.ts` 的 `suspendForConflict` |
| 记录 | 冲突组：涉及插件 id、冲突对（含方向与声明方）、检测时间 | `pendingConflicts.ts`、`db.ts` |
| 警告 | 单向与双向两条成对文案，带冲突双方与被停用的插件列表 | `i18n/zh.ts`、`i18n/en.ts` |
| 选择 | 删除该组记录，启用保留的一个，其余保持停用，不连带启用依赖方 | `index.ts` 的 `resolvePendingConflict` |
| 启动 | 记录涉及的插件一律不自动启用；记录里的插件已卸载时清理该条记录 | `index.ts` 的 `autoActivate`、`prunePending` |

待决定记录的形态：

| 字段 | 内容 |
|:---:|:---:|
| `id` | 按字典序拼接涉及插件 id，同一组插件再次触发时覆盖同一条 |
| `plugins` | 涉及的全部插件 id，按字典序；由冲突对推导，读回时重建 |
| `pairs` | 全部冲突对，每对带 `kind`（`single` 或 `mutual`）、`declarer` 与 `target` |
| `at` | 检测时间（毫秒时间戳） |

待决定记录落在引擎自己的库里（`<APP_NAME>-plugins` 版本 2 的 `conflict-groups` 仓库），不混进插件存储。与已有记录有交集的冲突并入同一条：一次待决定对应一个连通的冲突组，用户只选一个保留，其余保持停用。

界面入口在插件页「已安装」列表顶部，独立成块，不改动列表的表格结构。理由：冲突双方都在同一个列表里，选完能立刻看到状态从「已停用」变成「运行中」；冲突只影响启用状态，与插件市场无关。逐条冲突默认全部列出，冲突对超过 5 条时先给汇总句与条数，点开才展开逐条详情（双方插件名、声明方向与原因）；某条冲突对涉及已卸载插件时整对略过，记录随之清理。

引擎门面新增两个入口：`pendingConflicts()` 返回待决定记录的快照（已按卸载清理），`resolvePendingConflict(groupId, keepId)` 完成一次选择并返回结构化的 `ConflictDecisionResult`。

### 依赖的四处生效

依赖在安装、启用、停用、卸载四处都生效，判定共用同一份清单字段与注册表状态：

| 时机 | 判定 | 不满足时 |
|:---:|:---:|:---:|
| 安装 | 依赖已登记 | 拒绝安装，原因 `missing-dependency` |
| 启用 | 依赖处于 `active` | 不启用：记录直接标记为 `inactive`，错误字段写入 `missing-dependency:<id>`，并提示缺哪个 id；不会停在「已启用但启动失败」 |
| 停用 | 没有处于 `active` 的依赖方 | 拒绝停用，提示「以下插件正在使用它，请先停用对方」并列出这些插件 |
| 卸载 | 同停用 | 拒绝卸载，原因 `depended-on` |

停用被拒时 `deactivate()` 返回 `{ ok: false, reason: 'depended-on', dependents: [...] }`，成功返回 `{ ok: true }`，记录本就不处于启用状态时返回 `{ ok: false, reason: 'not-active' }`。第二个参数 `options.force` 表示用户明确要求强行停用，结论同样是拒绝：引擎不连带停用依赖方，关联停用由用户先停用对方后再做。

反方向由引擎自动收敛：插件被停用、卸载或启动失败后，依赖它的已启用插件不再满足依赖，引擎按 `inactive` 自动停用它们并逐个提示（`pluginDependencyAutoStopped`），错误字段同样写入 `missing-dependency:<id>`。停用、卸载、启用失败与启动恢复收尾都会执行这次收敛，因此不存在「正在运行但依赖不可用」的记录。

已安装列表的两种徽标由 `dependencies.ts` 算出，与上表共用同一份判定：`dependencyMissing`（依赖未满足，启用按钮据此置灰并在悬停说明缺哪个 id）与 `dependentBlocked`（被依赖阻塞，意味着停用与卸载都会被拒绝）。

### 能力与限流

| 能力 | 时间窗内上限 | 单次超时 | 插件可见形态 |
|:---:|:---:|:---:|:---:|
| `sessions:list` | 30 次 / 10 秒 | 3 秒 | `context.sessions.list` |
| `sessions:read` | 30 次 / 10 秒 | 3 秒 | `context.sessions.read` |
| `sessions:rename` | 5 次 / 10 秒 | 同步调用 | `context.sessions.rename` |
| `events:session` | 5 次 / 10 秒(仅登记) | 同步调用 | `context.events.on` |
| `notify` | 10 次 / 10 秒 | 同步调用 | `context.ui.notify` |
| `settings:locale` | 60 次 / 10 秒 | 3 秒 | `context.settings.locale` |
| `settings:surface` | 60 次 / 10 秒 | 3 秒(仅 `overrides`) | `context.settings.register`、`context.settings.values`、`context.settings.overrides`、`context.settings.onChange` |
| `ui:slot` | 20 次 / 10 秒(仅登记) | 同步调用 | `context.ui.registerSlot`、`context.ui.onSlotAction`、`context.ui.onSlotData` |
| `net:fetch` | 10 次 / 10 秒 | 内层 10 秒后中止请求 | `context.net.getText` |
| `net:fetch-post` | 10 次 / 10 秒 | 内层 5 秒后中止请求 | `context.net.postJson` |
| `assets:read` | 120 次 / 10 秒 | 内层 10 秒后中止请求 | `context.assets.readText`、`context.assets.readBytes` |
| `assets:download` | 3 次 / 10 秒, 总流量 512 MB / 10 秒(数值可调, 见 `assetDownload.ts` 的 `ASSET_DOWNLOAD_LIMIT`) | 不设单次超时, 传输慢不等于失败; 取消即真正中止 | `context.assets.download`(仅受信来源插件) |
| `plugins:storage` | 100 次 / 10 秒 | 同步调用 | `context.storage.get`、`set`、`remove` |
| `chat:request` | 10 次 / 10 秒(仅登记) | 同步调用,单次预算 10 毫秒 | `context.chat.onBeforeRequest` |
| `provider:source` | 50 次 / 10 秒(仅登记) | 同步调用 | `context.provider.registerSource` |
| `provider:run` | 10 次 / 10 秒 | 15 秒(只覆盖建立调用) | `context.provider.run` |

`provider:source` 的上限按「声明次数」计:每次 `context.provider.registerSource` 占一个名额,一个插件可能声明多条端点,因此上限取 50。声明集中在激活阶段,超过上限抛 `PluginRateLimitError`,整次激活失败并按失败路径撤销该插件的全部声明。

表里的「同步调用」表示该成员同步返回,没有超时(同步调用不适用超时),策略表因此不给它填超时数值;`events:session`、`chat:request` 与 `ui:slot` 只登记、不逐次执行耗时操作,同样没有超时。超时只对异步成员生效:`settings:surface` 的 3 秒只落在异步成员 `overrides` 上,登记、读值与订阅登记都是同步成员,不受影响。

登记型成员的限流按「登记次数」计:每次 `context.events.on`、每次 `context.chat.onBeforeRequest`、每次 `context.settings.onChange`,以及每次 `context.ui.registerSlot`、`context.ui.onSlotAction`、`context.ui.onSlotData` 各占一个名额,之后的事件回调、请求前调用、设置变更回调、槽位动作回调与页面数据索取都由引擎发起,不再占用名额。因此 `events:session` 的 5 次 / 10 秒约束的是注册次数——同一插件在一次激活内最多登记 5 个事件处理器,第 6 次登记在 10 秒窗口内抛 `PluginRateLimitError`,并提示 `pluginCallRateLimited`;窗口滚过之后可以继续登记。`chat:request` 的 10 次 / 10 秒同理。

超限抛 `PluginRateLimitError`,未授予抛 `PluginCapabilityError`,超时抛 `PluginTimeoutError`,取消抛 `PluginAbortError`;限流与超时同时用既有 Toast 提示。

`plugins:data-clear` 是引擎管理专用能力,不在 `CORE_CAPABILITIES` 内,插件清单申请它时按 `unknown-capability` 拒绝,也不会出现在插件上下文中。`net:fetch-post` 同理：它是 `context.net.postJson` 背后的独立能力标识,有自己的限流窗口与超时,插件清单不能申请,只能通过 `net:fetch` 的授予间接使用。`chat:request-source` 只在启动时登记一次补丁来源,`source:run` 只由引擎按端点描述发起一次执行,两者同样是引擎专用标识,不进入插件上下文;插件侧要发起这类执行时走 `provider:run`,那条标识在可见集合内。

`provider:source` 与 `chat:request` 同类：它在 `CORE_CAPABILITIES` 内、插件可以申请,但 core 侧没有对应实现,登记与合并都在引擎内完成。区别是它约束的是「能不能声明供应端点」,不约束「能不能执行」。执行另有一条插件可见能力 `provider:run`,背后落到引擎专用的 `source:run`;插件拿不到 `source:run` 这个标识,也拿不到端点描述以外的任何凭证。两条能力分开的理由:声明是交描述,执行会花用户填的 Key 与端点额度,授权单位不该相同。

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
| 协议 | 只允许 https;回环主机(`localhost`、`127.0.0.1`、`[::1]`)允许 http;重定向后的最终地址同样校验 |
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

### assets:download

`context.assets.download(assetId)` 按资产标识发起一次引擎代取,面向需要大体积二进制资产(模型权重、字库、音色包等)并长期留存的插件。它与 `assets:read` 的分工见仓库规范 `asset-download-capability.md`,判据一句话:能用 `assets:read` 取到、并且不打算长期留存的,就不要用 `assets:download`。

清单新增可选 `assets` 块,只在申请能力 `assets:download` 时允许出现:

| 字段 | 类型 | 规定 |
|:---:|:---:|:---:|
| `id` | 字符串 | 插件内唯一,小写字母开头,只含小写字母、数字与连字符;调用时用它指定资产 |
| `url` | 字符串 | 绝对地址,只允许 https,回环主机允许 http;不携带内嵌凭证与一次性签名参数 |
| `sha512` | 字符串 | 128 位小写十六进制,不带前缀;与资产市场逐文件比对的写法一致 |
| `bytes` | 整数 | 声明体积,用于进度总量与提前拒绝;实际字节数与声明不符即失败 |
| `version` | 字符串 | 三段数字;同一 `id` 换版本必须换地址或换哈希,不允许原地覆盖 |

授予条件只有一条:来源是内置插件合集 `dsc-inner-plugin` 或社区插件合集 `awesome-dsc-plugin`,且本地来源结论为「已确认」(`confirmed`)。宿主直接注册、本地离线包与自建来源的插件一律不在该层级内;不满足时安装按 `unknown-capability` 拒绝,与能力不存在不可区分。安装与恢复分别判一次,调用阶段再与清单块复核一次。

引擎行为(取件实现在 `assetDownload.ts`):

| 环节 | 行为 |
|:---:|:---:|
| 提示 | 每次传输前发一条气泡(`pluginAssetDownloadStarted`)并铺一张悬浮卡片,说明插件名、资产标识、声明体积与来源地址;不用原生确认框,不用模态遮罩,不阻塞调用 |
| 请求 | GET,不带 Cookie 与自定义请求头(`credentials: 'omit'`),只接受清单里声明的地址,不接受调用参数传地址;重定向跟随,跳转后的最终地址按同一协议口径复核且不跨主机(跨主机 CDN 的现实需求出现前保持收紧) |
| 流式读取 | 按响应流边读边累计字节数,超声明字节数立即中止并按 `too-large` 失败;摘要在读取结束后整体终算,与字节数一并按清单校验,任一不符即 `hash-mismatch`,已读内容整体丢弃 |
| 取消 | 卡片上的取消按钮经引擎侧出口 `AbortController.abort()`,请求真正中止,`aborted` 交给调用方,引擎不重试;插件卸载时活跃传输一并中止,卡片随收尾收起 |
| 卡片 | 右下角悬浮卡片显示已收字节与声明体积,完成后自动收起;同一插件同一时刻只显示一张卡片,多资产复用 |
| 合并 | 同一「插件 + 资产 id + sha512」的并发请求合并为一次传输,其余等待同一结果;失败同样合并,等待者拿到同一个失败 |
| 限流 | 与 `assets:read` 分开计数,按传输次数与总流量分别计,数值集中在 `assetDownload.ts` 的 `ASSET_DOWNLOAD_LIMIT`(3 次 / 10 秒与 512 MB / 10 秒,保守默认值,等第一个真实消费者出现后按实测调整) |
| 缓存 | 第一阶段不落盘、不设持久缓存;校验通过的字节交给插件后引擎即释放 |

失败一律抛 `PluginAssetDownloadError`,`reason` 取闭集之一:

| `reason` | 含义 |
|:---:|:---:|
| `protocol` | 标识不在清单块内、最终地址协议不合规 |
| `status` | 非 2xx 状态码,或请求在拿到响应前失败 |
| `timeout` | 读取流中断或超时 |
| `too-large` | 已收字节超过清单声明的体积 |
| `hash-mismatch` | 摘要与字节数任一与清单不符,或环境没有 WebCrypto 可用 |
| `aborted` | 用户取消 |

除取消外失败只写该插件的插件日志,不弹宿主提示;失败已经交给调用方,由插件自己降级(小模型、精简功能或明示不可用)。插件侧职责(命中即不下载、自存 IndexedDB、版本替换、配额处理、卸载清理)见仓库规范 3.4 节,引擎不代管插件存储。

### 请求前补丁

`chat:request` 只服务一个成员：`context.chat.onBeforeRequest(handler)`。插件在激活时登记处理器,引擎在每次发请求前同步调用一次,把处理器返回的补丁交给 `dsc-core` 写进请求参数。登记要求清单同时申请能力 `chat:request` 与挂载点 `chat:before-request`,缺任一项抛 `PluginCapabilityError`;登记与 `events.on` 一样返回释放函数,停用或卸载时由引擎执行。

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

### 插件设置表面

第三方插件可以在清单里申请能力 `settings:surface`,在激活期用 `context.settings.register(descriptor)` 登记一份字段描述,宿主据此渲染设置表单。插件只交描述、不交控件:控件形态、样式与 i18n 全部归宿主,这是与 dsh(插件自带 React 组件)的关键差异,也是能力白名单模型的自然结论。

登记与校验实现在 `pluginSettings.ts`,与供应端点声明同法:只登记描述、不执行;描述非法(重复 key、未知类型、非法 default、非法 labelKey、编译不过的 pattern、超规模)时整份注册失败,抛 `PluginSettingsError`,`code` 是结构化的问题码,同时提示 `pluginSettingsRejected`。登记返回释放函数,进入插件的 disposer 集合,停用随引擎清理(激活中途失败同样撤销);同一插件再次登记时替换前一份,页面 id 就是插件 id,不允许自定义,避免跨插件抢占。

字段描述的形态:

| 字段 | 必填 | 说明 |
|:---:|:---:|:---:|
| `key` | 是 | `^[a-z][a-z0-9-]{0,63}$`,同一份描述内不得重复,也是设置存储的键 |
| `type` | 是 | `switch`、`select`、`number`、`text`、`secret` 五种之一,未知类型整份拒绝 |
| `labelKey` / `label` | 是 | 二选一:`labelKey` 必须是宿主 i18n 字典里的键,`label` 是插件直给的文案(1 到 40 字符) |
| `default` | 非 secret 必填 | 默认值;必须通过该字段自己的取值校验;secret 字段不得有默认值 |
| `min` / `max` / `step` | 否 | number 的取值范围与步进;步进只影响控件交互,不参与校验 |
| `maxLength` / `pattern` | 否 | text 的长度上限与形态约束;pattern 必须能通过 `new RegExp` 编译 |
| `options` | select 必填 | 2 到 32 个选项,每项 `{ value, labelKey 或 label }`,value 不得重复 |

规模上限:最多 32 个字段,描述序列化后不超过 8 KB,超限按 `too-many-fields` / `descriptor-too-large` 拒绝。

值的语义分两层:默认层来自描述的 `default`,用户覆盖层落在 dsc-core 的设置命名空间(`<APP_NAME>:plugin-settings:<pluginId>`,概念上是 `settings/<pluginId>/<fieldKey>`),与 `plugins:storage` 的插件数据(`<APP_NAME>:plugin-data:<id>`)完全分开——插件用 `storage.set` 写不到这张表,写侧只有引擎的门面,写入前按描述校验,无法绕过。覆盖值不落盘默认值:单插件覆盖层上限 16 KB。覆盖的判定是「覆盖层里有没有这个键」,与生效值是否等于登记默认值无关:用户把字段改成与默认值完全相同的值同样算覆盖,详情页的「已修改」徽标与插件侧的覆盖状态都按这个口径。

| 通道 | 位置 | 说明 |
|:---:|:---:|:---:|
| 插件读自身值 | `context.settings.values()` | 只读自身命名空间:覆盖值优先,否则默认值;其他插件的设置不可见,secret 字段不返回任何值 |
| 插件读覆盖状态 | `context.settings.overrides()` | 只读自身命名空间,逐字段回答用户是否覆盖(`overridden`),口径与详情页的「已修改」徽标一致;secret 字段没有默认值,`overridden` 恒为 `false`,只回答是否已配置(`secretConfigured`),不返回值。读凭证库要等一次异步查询,因此这个成员是异步的 |
| 插件订阅变更 | `context.settings.onChange(handler)` | 返回释放函数,进入插件的 disposer 集合;回调由引擎在落盘后发起,不占插件的限流名额;停用之后不再回调 |
| 宿主读写 | `engine.pluginSettings(pluginId)` | 门面:`descriptor()`、`values()`(逐字段的生效值与覆盖状态)、`set(key, value)`、`reset(key)`、`resetAll()`;写前校验,失败返回结构化问题码;三个写入口各自成功落盘后发一条变更通知 |
| 秘密值 | `credentials.ts` | `secret` 字段复用供应端点凭证库:同一张表、同一套内存镜像与降级口径,键的 source_id 带 `plugin-secret:` 前缀(含冒号,与端点 id 词表不相交);只写不读,读侧只回答「是否已配置」 |

变更通知的载荷:

| 字段 | 说明 |
|:---:|:---:|
| `pluginId` | 本次变更所属的插件 |
| `keys` | 本次变化的字段键,与 `changes` 同序 |
| `changes` | 逐字段的 `{ key, kind, overridden, secretConfigured? }`,顺序是字段在描述里的顺序 |

`kind` 三值区分变化种类:`added` 是该字段第一次有覆盖值(此前一直取默认值),`changed` 是已有覆盖值被改写,`reset` 是覆盖被撤销、回到默认值。secret 字段按同一套三值表达「从没配置到已配置」「重新填写」「清除」,载荷里只有状态、没有值。`overridden` 与 `secretConfigured` 是变化之后的状态,插件据此直接重估,不必再拉一次 `overrides()` 或 `values()`。

| 约束 | 规定 |
|:---:|:---:|
| 时机 | `set`、`reset` 各自成功落盘后立刻发一条,回调在这次调用返回之前同步跑完;`resetAll` 只发一条,载荷含全部降回默认值的字段 |
| 无净变化不通知 | 写入与当前覆盖值相同的值、重置本来没有覆盖值的字段、清除未配置的秘密值,落盘动作成功但状态没变,不发事件 |
| 合并不跨调用 | 一次门面调用就是一轮:同一字段在一次调用里最多出现一次(`resetAll` 逐字段各一次),字段级合并没有发生场景;跨调用攒批不做,因为门面看不到宿主的保存循环,只能按微任务或定时器猜边界,而那段延迟里插件读到的状态可能已经比事件新,逐次通知让事件顺序与落盘顺序一致。宿主保存多字段表单时逐字段调用门面,插件因此收到多条事件,每条各自带键与新状态 |
| 限流 | `onChange` 的登记按 `settings:surface` 计一次名额,之后的回调由引擎发起、不占名额;`overrides()` 与 `values()` 共用同一个读取窗口 |
| 撤销 | 释放函数进入插件的 disposer 集合,停用随引擎清理,撤销之后不再回调;同一轮的其余订阅者不受影响 |
| 抛错 | 单个订阅者抛错只写该插件的插件日志(`settings change handler failed: ...`),其余订阅者照常收到事件;已经落盘的值不会因此回滚 |

宿主 UI:已安装列表点插件名进详情页(不做路由,返回即回列表),详情页由宿主按描述渲染表单。脏值生命周期照抄 dsh:改动即脏、保存才落盘、字段级非法阻塞保存、保存失败保留草稿、离开页面丢弃草稿;每个字段带覆盖徽标(已修改)与「重置为默认」按钮。没有登记描述的插件(未激活、或没有可配置项)显示「本插件没有可配置项」。

卸载清理:登记随停用撤销;覆盖值、秘密值与变更订阅由引擎管理,卸载时一并清除,不在遗留数据区出现。

### 插件 UI 槽位（ui:slot）

第三方插件可以在清单里申请能力 `ui:slot`,用清单的 `slots` 白名单逐个声明要登记的槽位,在激活期用 `context.ui.registerSlot(descriptor)` 登记一份声明式描述,宿主按描述的 `slot` 把内容渲染到对应落点。能力只有一个,位置不止一个:槽位名是引擎侧的封闭枚举(`SLOT_NAMES`),新增落点只扩枚举与宿主渲染,不新增能力标识——位置数量与能力数量解耦,对齐 dsh「一个注册 API 覆盖全部位置」的取舍。本版开放十个槽位,按描述形态分两类:五个页面型(带区块模型,宿主渲染整页、设置里的一页、会话右栏的一段或右栏的一个标签页)与五个位置型(不带区块,宿主渲染成工具条按钮、通知条、消息操作行或菜单项)。语义与落点:

| 槽位 | 类型 | 落点 | 语义 |
|:---:|:---:|:---:|:---:|
| `nav.panel` | 页面型 | 侧边栏会话分组之上的导航行区域 + 主区整页 | 登记一项 = 导航行区域里的一行(图标 + 标题),点击即切换到该插件页面;与静态的插件面板行同区排列,是 dsh `sidebar.panellist` + `main` 的描述式对应物 |
| `conversation.tabs` | 页面型 | 会话视图标签栏 + 主区整页 | 登记一项 = 标签栏里的一个标签,选中后主区整块换成该插件页面;标签切换不改会话上下文,是 dsh `conversation.view` 的描述式对应物 |
| `settings.page` | 页面型 | 系统设置的「插件」分组 | 登记一项 = 设置页里的一个入口(页面标题 + 插件名),点击后在同一分组内渲染该页面;分组只在有登记项时出现,是 dsh `settings.section` 的描述式对应物 |
| `session.panel.section` | 页面型 | 会话视图右侧面板的默认页(段落页) | 登记一项 = 该页里带标题的一段:标题由宿主画,其下按声明顺序渲染区块;多项按 order 逐段排下来,是 dsh `conversation.session.panel.section` 的描述式对应物 |
| `nav.side` | 页面型 | 会话视图右侧面板的标签栏 | 登记一项 = 右栏标签栏里的一个可切换标签(标题,可带图标键),选中后右栏内容换成该登记项的区块;标签只在右栏内切换,不改主区、不改会话上下文,是 dsh `sidebar.right.pane.tab` 的描述式对应物 |
| `composer.toolbar` | 位置型 | 输入框下方的工具条 | 登记一项 = 工具条里的一个按钮(与宿主的深度思考、智能搜索同排),点击经 `ui:slot-action` 回调,载荷的 `actionId` 是描述里的 `actionKey`,是 dsh `conversation.input.left`/`.right` 的描述式对应物 |
| `composer.notice` | 位置型 | 输入框上方 | 登记一项 = 输入卡顶部的一条通知条,左侧色条随 `tone` 取蓝/琥珀/红,是 dsh `conversation.input.dock` 的受限版 |
| `overlay.notice` | 位置型 | 右上角的全局面板通知栈 | 同一插件的多条通知合并成一张悬浮卡片(按插件分组),卡片头部是插件名,逐条通知按 `level` 着色;不拦截页面点击,是 dsh `shell.overlay` 的受限版 |
| `message.actions` | 位置型 | 助手消息底部的操作行 | 登记一项 = 操作行里的一组按钮(排在复制、朗读、重新生成之后),点击经 `ui:slot-action` 回调,载荷的 `actionId` 是条目键、`itemKey` 是消息 id,是 dsh `conversation.chat.assistant-actions` 的描述式对应物 |
| `menu.item` | 位置型 | 会话行与消息的右键菜单 | 登记一项 = 右键菜单里的一项(排在宿主项之后),`target` 决定挂在会话行还是消息上;点击经 `ui:slot-action` 回调,载荷的 `actionId` 是 `actionKey`、`itemKey` 是会话 id 或消息 id,与 dsh `ctx.contextMenus.register` 同构 |

这是可选项——插件不登记就没有任何入口,界面保持既有行为:没有 `nav.panel` 登记时导航行区域只有插件面板一行,没有 `conversation.tabs` 登记时标签栏整块不渲染,其余槽位同理(没有登记时对应的工具条按钮、通知条、通知卡片、消息按钮与菜单项都不出现,设置里也没有「插件」分组)。会话右栏的两个槽位同样可选:两者都没有登记时右栏整块不存在,会话页头、消息区与输入区与现在完全一致。与 `settings:surface` 同法,插件只交描述、不交控件:控件形态、样式与 i18n 全部归宿主,这是插件没有 React 能力时的页面形态。消费场景是插件需要一块自己的展示与管理界面(例如资产市场的来源管理与安装入口),或只需要在既有界面里加一个动作、一条提示。

登记与校验实现在 `pluginSlots.ts`,与设置表面同法:只登记描述、不执行;校验即拒绝,槽位不在枚举(`unknown-slot`)、槽位未写入清单 `slots` 白名单(`slot-not-granted`)、同槽位内 id 与其他插件重复(`duplicate-id`)、非法 id、非法文案、非法图标键、非法排序、非法动作键(`invalid-action-key`)、非法 `tone`(`invalid-tone`)/`level`(`invalid-level`)、非法 `target`(`invalid-target`)、空区块、超过 64 个区块、重复区块 id、未知区块类型、非法条目、非法动作、非法说明文字、非法表单字段、跨区块重复字段键、超规模都让整份注册失败,抛 `PluginSlotError`,`code` 是结构化的问题码,同时提示 `pluginSlotRejected`(白名单缺失另提示 `pluginSlotNotGranted`)。清单层面的校验在安装期完成:`slots` 里出现枚举之外的槽位名按 `unknown-slot` 拒绝安装。登记返回带槽位名与页面 id 的句柄,释放函数进入插件的 disposer 集合,停用随引擎清理(激活中途失败同样撤销);同一插件重复登记同 id 槽位时替换前一份。

页面型槽位(`nav.panel`、`conversation.tabs`、`settings.page`、`session.panel.section`、`nav.side`)的描述形态(五个槽位共用同一份字段,只是落点不同):

| 字段 | 必填 | 说明 |
|:---:|:---:|:---:|
| `slot` | 是 | 槽位名,必须在 `SLOT_NAMES` 枚举内且已写入清单 `slots` 白名单 |
| `id` | 是 | `^[a-z][a-z0-9-]{0,63}$`,同一槽位内跨插件唯一(先登记者占位),与插件 id 共同构成页面入口的键 |
| `titleKey` / `title` | 是 | 二选一:`titleKey` 必须是宿主 i18n 字典里的键,`title` 是插件直给的文案(1 到 40 字符);导航行、标签、设置入口、右栏段落标题与右栏标签页的名字都用它 |
| `iconKey` | 否 | 图标键,由宿主图标查表解析(当前登记的键:`browse`、`data`、`globe`、`plugin`、`settings`),未命中时宿主用通用插件图标;校验只看形态(1 到 64 字符),不进 i18n 词表。导航行、收起态入口与 `nav.side` 的标签会画这个图标;`session.panel.section` 的段落只有标题,不画图标 |
| `order` | 否 | 同槽位内的排序键:升序,同值按登记顺序,未给按 0 |
| `blocks` | 是 | 区块数组,1 到 64 个,按声明顺序渲染 |

区块四种:

| 区块 | 字段 | 说明 |
|:---:|:---:|:---:|
| `text` | `text` | 静态说明文字,1 到 2000 字符 |
| `list` | `items`、`itemAction?` | 条目数组(至多 200 条),每条 `{ key, titleKey 或 title, description?, badgeKey 或 badge }`;条目键不得重复,`description` 是 1 到 200 字符的直给文案,标题与徽标复用设置字段标签的文案口径(`titleKey` / `title`、`badgeKey` / `badge` 各自二选一);`itemAction` 是可选的逐条动作 `{ key, labelKey 或 label }` |
| `form` | `fields` | 复用 `settings:surface` 的五种字段描述与宿主控件,字段键在同一页面内不得重复(跨区块同键同样拒绝) |
| `actions` | `items` | 按钮组(至多 8 个),每项 `{ key, labelKey 或 label }`,键不得重复 |

规模上限:最多 64 个区块,描述序列化后不超过 8 KB,超限按 `too-many-blocks` / `descriptor-too-large` 拒绝。

位置型槽位的描述形态(都不带 `blocks`;共同字段是 `id` 与可选的 `order`,校验口径与页面型一致):

| 槽位 | 字段 | 说明 |
|:---:|:---:|:---:|
| `composer.toolbar` | `labelKey` 或 `label`、`actionKey` | 按钮文案与动作键;`actionKey` 走键词表 `^[a-z][a-z0-9-]{0,63}$`,回调时作为 `actionId` |
| `composer.notice` | `tone`、`textKey` 或 `text` | `tone` 取 `info`/`warning`/`error`(闭集);正文二选一,`textKey` 必须是宿主字典里的键,`text` 是 1 到 2000 字符的直给文案 |
| `overlay.notice` | `level`、`textKey` 或 `text` | `level` 取 `info`/`warning`/`error`(与 `tone` 同一套取值,字段名沿用通知栈的语义);正文口径同上 |
| `message.actions` | `items` | 1 到 8 个条目,每条 `{ key, labelKey 或 label }` 与 actions 区块同形;键不得重复,回调时条目键作为 `actionId` |
| `menu.item` | `target`、`labelKey` 或 `label`、`actionKey` | `target` 取 `message`/`session`,决定挂到消息右键还是会话行右键;`actionKey` 口径同工具条 |

两个回调处理器,登记时要求清单申请能力 `ui:slot` 且把对应槽位写入 `slots` 白名单(槽位白名单取代旧版按挂载点声明的前置条件,缺任一项抛 `PluginCapabilityError` 或 `PluginSlotError`):

| 处理器 | 登记 | 回调时机 |
|:---:|:---:|:---:|
| `ui:slot-action` | `context.ui.onSlotAction(slot, handler)` | 用户点击该槽位上的动作按钮、工具条按钮或菜单项时,引擎同步回调一次,载荷 `{ slot, id, actionId, itemKey?, form? }`;`slot` 一定出现(同一份回调可服务多个槽位),`itemKey` 在 list 逐条动作、消息操作行(消息 id)与菜单项(会话 id 或消息 id)上出现,`form` 是宿主收集的页面表单区块当前草稿值,页面没有表单区块时不出现 |
| `ui:slot-data` | `context.ui.onSlotData(slot, handler)` | 宿主进入页面或动作返回刷新指示时,引擎同步索取当前模型,传槽位名与页面 id;处理器同步返回页面描述,返回 null 表示沿用登记时的描述;只有页面型槽位有页面模型,位置型槽位的刷新指示不产生额外索取 |

回调的约定:

- 动作处理器同步返回 `{ refresh: true }` 时,宿主重新向插件索取页面模型;返回其他值或什么都不返回时页面保持原样。异步工作(如安装资产)由插件自行发起,完成后用 `context.ui.notify` 提示,页面数据等用户下次进入或下一次刷新指示再更新。
- 两个处理器的回调由引擎发起,不占插件的限流名额;`ui:slot` 的限流按登记次数计,`registerSlot`、`onSlotAction`、`onSlotData` 每次各占一个名额,20 次 / 10 秒。
- 数据处理器返回的模型按登记期同一份校验收敛:非法、抛错或 slot/id 与所请求页面不一致时回落到登记时的缺省模型,返回 null 表示沿用登记描述,原因写插件日志;未实现 `ui:slot-data` 的插件页面静态显示。
- 页面表单的值只活在宿主侧的脏值生命周期里(改动即脏、字段级非法给出问题文案、可重置为默认),没有落盘动作;用户点击动作按钮时,宿主把当前草稿值随载荷交给插件。

宿主 UI:页面型槽位不在插件面板里。主区面板收敛为单一命名空间 `activePanelId: null | 'plugins' | { slot, pluginId, id }`(null 是会话,与 dsh 的 `MainPanelId | null` 同构);选中会话一律回到 null,落点在会话库的 `selectSession` 与 `newChat`。侧边栏在会话分组之上有一条独立的导航行区域:静态的插件面板行在前,其后是全部 `nav.panel` 登记项(图标加标题,按 order 升序、同值按登记顺序);侧边栏底部没有插件开关按钮,面板不是开关语义,点击即切换到该面板,再次点击当前面板行不切回会话。会话视图顶部有标签栏:默认项「对话」在前,其余为 `conversation.tabs` 登记项;选中插件标签时主区整块换成该插件页面,标签切换不改会话上下文,再次点「对话」回到会话。系统设置的「插件」分组只在有 `settings.page` 登记项时出现,列出全部登记项(页面标题 + 插件名),点进去在同一分组内渲染该页面并有「返回插件列表」。会话视图右侧面板是另外两个页面型槽位的落点:右栏默认展开,页头右侧有一个开关(图标是左栏面板图标的水平镜像),收起后页头只留该开关、右栏不占宽。有 `session.panel.section` 登记时右栏有一个默认页,全部登记项按 order 逐段排下来,每段由宿主画标题、其下按区块顺序渲染;有 `nav.side` 登记时页头出现标签栏,标签多于一个才画标签栏(只有一个标签时直接显示该标签的标题),默认页的标签文案是「会话面板」。右栏换标签不改主区(不写 `activePanelId`)、不改会话上下文,与主区面板是两套状态;窄屏没有右栏的位置,两个右栏槽位在窄屏不渲染。页面顶部是回到会话的面包屑;侧边栏收起态逐面板保留一个图标入口(悬停提示面板标题),与 dsh 收起 rail 的逐面板图标一致。五个页面型槽位共用同一份区块渲染器(`PluginPageBlocks.tsx`):主区整页、设置里的插件页、右栏段落与右栏标签页只是外壳不同,控件、脏值生命周期与刷新语义完全一致;右栏段落与标签页各自持一份页面模型与表单草稿,互不影响。页面主体按区块顺序渲染,表单区块复用设置详情页的控件与样式 token;动作按钮触发引擎回调,返回刷新指示时立即重新索取模型。

位置型槽位的宿主落点:`composer.toolbar` 的按钮排在输入框下方工具条内宿主开关(深度思考、智能搜索)之后;没有登记时工具条保持原样。`composer.notice` 的通知条在输入卡顶部、附件轨之上,左侧色条随 `tone` 着色,正文为空串的登记不渲染。`overlay.notice` 是右上角的通知栈:同一插件的多条通知合并成一张悬浮卡片,卡片头部是插件名,逐条按 `level` 着色,栈本身不拦截页面点击(卡片可点)。`message.actions` 的按钮排在助手消息的复制、朗读、重新生成之后,每条消息都渲染同一组按钮。`menu.item` 排在会话行与消息右键菜单的宿主项之后;宿主右键菜单是跟随光标的悬浮卡片(点外部或 Esc 关闭),不是原生菜单。不做路由、不做模态遮罩,遵守界面交互禁令(只用气泡通知与悬浮卡片)。

撤销语义:停用撤销该插件的全部槽位登记与两个处理器;卸载时引擎再兜底清一次,避免未激活过的插件留下残留。登记表的每次变更都经订阅通知宿主界面,宿主据此增删导航行、标签栏、设置入口、工具条按钮、通知条、通知卡片、消息按钮、菜单项与会话右栏的段落和标签页;正停在被撤销页面上的视图(主区或设置里的插件页)自动退回会话/插件列表,并用一次气泡说明,不留空白主区。右栏跟随登记表重渲染:停留的标签被撤销时落到第一个可用标签,右栏再没有登记项时整块消失、页头开关一并退出,不留空白右栏。

### 供应端点能力与注册表

插件可以声明它能提供哪些供应端点（provider endpoint，下称端点），但只交描述、不交执行代码：装配请求与解析回流的实现在 `dsc-core`，凭证由引擎在执行时取用，插件两头都碰不到。这里的「端点」与插件安装来源（`inner`、`outer` 等）不是同一个概念，文档与界面不用「来源」指代它。

| 环节 | 位置 | 说明 |
|:---:|:---:|:---:|
| 能力 | `provider:source`、`provider:run` | 前者管声明、后者管执行；未申请时调用对应成员抛 `PluginCapabilityError` |
| 注册接口 | `context.provider.registerSource(descriptor)` | 登记一份端点描述；只登记，不执行，不发起网络请求 |
| 注册表 | `sources.ts` | 合并全部插件的声明，能力清单按端点 id 取并集；另有 `selectedSource` 给出当前选中的端点 |
| 凭证 | `credentials.ts` | 按「端点 id + 规范化后的基址」存 IndexedDB，只在执行时读取；不从引擎门面导出 |
| 执行入口 | `context.provider.run(capability, payload)` | 清单申请 `provider:run` 后可用；引擎选端点、读凭证，失败按错误码抛出 |
| 执行 | `dsc-core` 的 `source:run` | 引擎专用标识，插件不可达；按能力标识分派 |

端点描述的字段：

| 字段 | 必填 | 说明 |
|:---:|:---:|:---:|
| `id` | 是 | 小写字母开头，允许数字、点、下划线与连字符，3 到 64 字符；注册表按它合并与判冲突 |
| `label` | 是 | 展示名称，最多 40 字符；只用于展示，不参与冲突判定 |
| `format` | 是 | `anthropic-messages` 或 `openai-chat`；只描述线上协议，不指厂商 |
| `baseUrl` | 是 | 端点基址；登记前规范化，见下表 |
| `capabilities` | 是 | 该端点能提供的能力，取自九个端点能力标识，不得为空、不得重复 |
| `endpoints` | 否 | 按能力覆盖端点路径，只允许站内绝对路径；缺省按 `format` 推导 |

基址在登记前统一规范化，注册表的比对与执行期的地址拼接都只用规范化后的值：

| 处理 | 规则 |
|:---:|:---:|
| 去空白 | 首尾空白一律去掉，否则校验能过、执行期却拼出非法地址 |
| 主机 | 转小写 |
| 端口 | 去掉默认端口（https 的 443、http 的 80） |
| 路径 | 去掉尾斜杠 |
| 拒绝 | 带 query、hash 或内嵌用户名密码的地址直接拒绝；非 https 且非回环地址的 http 默认拒绝，宿主打开「允许局域网 http 供应端点」后放行 |

合并与冲突：

| 情形 | 结论 |
|:---:|:---:|
| 端点 id 不同 | 各自入表 |
| 端点 id 相同、定义一致 | 能力清单取并集，声明方都记进 `owners` |
| 端点 id 相同、定义不一致 | 先声明的那份临时生效，后声明的不生效，记一条 `SourceConflict` |

`SourceConflict` 带端点 id、冲突字段、临时生效与被拒绝的两份描述，以及双方的插件 id。定义比对只看 `format`、规范化后的 `baseUrl` 与 `endpoints` 三项：这三项决定请求发到哪里、按什么协议组装；`label` 只是展示名，差异不算冲突，展示名取先声明方；能力清单按并集合并，也不参与判定。

未决期先声明的那份临时生效，代价写在文档里而不是藏起来：后声明方的插件会看到 id 在表里，但执行期只认先声明方的基址；冲突方声明的能力不进能力矩阵；冲突只体现在注册表视图与引擎日志里，界面必须主动展示；先声明方退出后，下一份声明重新成为唯一定义。`owners` 把冲突方也记进去，因此「谁还声明过这个 id」在冲突期也查得到。

`engine.sourceRegistry()` 返回合并后的端点描述、端点 id 到声明方的 `owners`、能力矩阵与冲突列表，供设置界面展示。能力矩阵对九个端点能力逐项给出提供它的端点 id，没有端点提供时为空数组。停用或卸载插件时撤销该插件的全部声明。

`credentials.ts` 只给引擎的执行路径使用：读 `readSourceCredential(sourceId, baseUrl, policy?)`、写 `writeSourceCredential(sourceId, baseUrl, apiKey, policy?)`，基址规范化与声明期同源——引擎传入宿主的局域网 http 开关，夹具不传时保持默认的严格口径——与安装记录分库（`<APP_NAME>-plugin-sources`），键是「端点 id + 规范化后的基址」，IndexedDB 不可用时降级为内存镜像。读取结论有三态：`ok` 可用；`missing` 没有记录；`stale` 同一端点 id 还存在别的基址的记录，说明端点换过主机，必须重新填写，不能把旧 Key 发到新主机。它不从引擎门面再导出，插件既拿不到读写入口，也拿不到任何凭证值。

示例只声明一条端点，不执行：

```ts
export const manifest = {
  id: 'dsc-demo-source',
  name: 'Demo Source',
  version: '1.0.0',
  engines: '^1.0.0',
  capabilities: ['provider:source'],
}

export const activate = (context) => {
  context.provider.registerSource({
    id: 'demo-deepseek',
    label: 'Demo DeepSeek',
    format: 'anthropic-messages',
    baseUrl: 'https://api.deepseek.com',
    capabilities: ['text.generate', 'models.list'],
  })
}
```

端点能力标识是另一条标识轴，共九个：`text.generate`、`reasoning.think`、`vision.image`、`document.read`、`audio.asr`、`audio.tts`、`tool.web-search`、`tool.read-url`、`models.list`。它们不出现在插件清单里，只出现在端点描述的能力清单里；本轮只有 `text.generate` 与 `models.list` 接通，其余七项在执行前按 `capability-unimplemented` 拒绝（core 侧的拒绝原因是 `unsupported`）。

### 按端点执行

`context.provider.run(capability, payload, options?)` 是插件侧唯一的执行入口，清单要另外申请 `provider:run`。两条能力分开：`provider:source` 管「能不能声明」，`provider:run` 管「能不能在自己的端点上发起一次调用」。执行链路固定四段：

| 步骤 | 位置 | 做的事 |
|:---:|:---:|:---:|
| 选端点 | `sources.ts` 的 `selectedSource` | 取该能力在注册表里的第一个端点；本版不做用户选择 |
| 读凭证 | `credentials.ts` 的 `readSourceCredential` | 按「端点 id + 规范化后的基址」读取，基址按宿主的局域网 http 开关规范化，读到 `stale` 直接拒绝 |
| 执行 | `dsc-core` 的 `source:run` | 带描述、能力标识、载荷与凭证调用一次；凭证只用于这一次 |
| 归类 | `providerRun.ts` | 回流原样透传；失败换成可判定的错误码再抛出 |

选端点只看注册表，与凭证是否已填无关：缺凭证按 `credential-missing` 报错，不会悄悄换到下一个端点。端点按声明顺序入表，同一声明序列下选中的端点稳定可复现；冲突期由先声明的那份继续生效，选中结果与 `engine.sourceRegistry()` 看到的一致。选中端点以后要交给用户选择时，只需把 `selectedSource` 换成查「某项能力选哪个端点」，调用方接口不变。

本版只接通 `text.generate` 与 `models.list`：其余七项能力在执行前就拒绝，既不读凭证也不发请求。返回形态按能力区分：

| 能力 | 形态 | 说明 |
|:---:|:---:|:---:|
| `text.generate` | `{ kind: 'stream', events }` | `events` 是异步可迭代物，逐条产出 `text`、`thinking`、`title` 与 `end` 四类事件；鉴权与网络失败要到第一次迭代时才抛出 |
| `models.list` | `{ kind: 'models', models }` | 一次性返回，`models` 每项只有 `id` |

失败一律抛 `PluginProviderRunError`，判定依据是 `code`；原始失败文本只进 `detail`，不回传协议细节：

| `code` | 含义 | 调用方可以做什么 |
|:---:|:---:|:---:|
| `credential-missing` | 没有该「端点 id + 基址」的凭证记录，或凭证存储读不出来 | 提示用户填写凭证后重试 |
| `credential-stale` | 同一端点 id 存在别的基址的记录，端点换过主机 | 要求用户重新填写，不能复用旧 Key |
| `credential-rejected` | 端点以 401 或 403 拒绝凭证 | 提示用户核对凭证 |
| `capability-unavailable` | 没有端点提供该能力，或选中的端点未声明它 | 检查端点声明与注册表视图 |
| `capability-unimplemented` | 端点声明了该能力，本版尚未接通 | 重试没有意义，只能等内核落地 |
| `endpoint-unreachable` | 请求没有拿到响应：网络层失败，或端点基址不可用 | 提示网络或端点地址问题，可重试 |
| `protocol-error` | 拿到响应但不符合协议：非 2xx、非流式响应、JSON 不合法、流提前结束 | 视为端点实现问题，按 `detail` 排查 |

错误对象另带 `capability` 与 `sourceId`（还没选出端点时为 `null`）。凭证既不出现在错误里，也不出现在结果或回流事件里。引擎不为这类失败弹宿主提示：失败已经交给调用方，由插件自己决定提示还是降级。

示例：在上一节的声明之上申请 `provider:run`，再消费回流。

```ts
export const manifest = {
  id: 'dsc-demo-source',
  name: 'Demo Source',
  version: '1.0.0',
  engines: '^1.0.0',
  capabilities: ['provider:source', 'provider:run'],
}

export const activate = (context) => {
  context.provider.registerSource({
    id: 'demo-deepseek',
    label: 'Demo DeepSeek',
    format: 'anthropic-messages',
    baseUrl: 'https://api.deepseek.com',
    capabilities: ['text.generate', 'models.list'],
  })
}

// 由插件自己的交互触发；端点、凭证与请求组装都不在插件侧
export const generate = async (context) => {
  try {
    const result = await context.provider.run('text.generate', {
      model: 'deepseek-flash',
      system: '你是助手',
      messages: [{ role: 'user', content: '你好' }],
    })
    if (result.kind !== 'stream') {
      return
    }
    for await (const event of result.events) {
      if (event.type === 'text') {
        context.log(event.text)
      } else if (event.type === 'end') {
        context.log('stop: ' + String(event.stopReason ?? 'null'))
      }
    }
  } catch (error) {
    // 失败不吞：按 code 决定提示还是降级，再抛给调用方或就地记录
    if (error.code === 'credential-missing' || error.code === 'credential-stale') {
      context.log('凭证需要重新填写: ' + error.code)
    }
    throw error
  }
}

// 一次性结果同理：载荷为空对象，返回的 kind 为 models
export const listModels = async (context) => {
  const result = await context.provider.run('models.list', {})
  if (result.kind === 'models') {
    context.log(result.models.map((model) => model.id).join(','))
  }
}
```

限流 10 次 / 10 秒，单次超时 15 秒。超时只覆盖「建立调用」这一段：`text.generate` 的回流在调用返回后惰性产出，占的是调用方的迭代时间，不占这个预算；要中断就在 `options.signal` 上取消。

后续计划：

- 端点选择交给用户。注册表、凭证与执行入口都已按端点 id 与基址组织，界面只需记录「某项能力选哪个端点」，`selectedSource` 改为查这份选择即可，插件侧的调用形态不变。
- 端点归属尚未收紧。当前选中是全局的：拿到 `provider:run` 的插件可以在别的插件声明的端点上发起调用，用的是用户为那个端点填的 Key。用户选择落地时一并解决：要么按插件限定可选集合，要么由用户在界面上明确「这次用哪个端点」。
- 其余七项能力的接通顺序与 `dsc-core` 的落地顺序一致：先在内核补齐载荷与回流解析，再放开 `provider:run` 的判定，插件不需要改调用形态。
- 失败回退尚未决定。当前不做静默换端点：插件声明了某个端点，就应该知道请求打到了哪里；自动回退会让「谁在生效」重新变成隐式状态。

### 持久化与启动恢复

安装记录写入 IndexedDB 的 `<APP_NAME>-plugins` 库(版本 2,对象仓库 `plugins`,主键 `id`),与聊天历史库分开建库,互不影响;版本 2 只是多建一个 `conflict-groups` 仓库用来存待决定冲突组,不改动已有的安装记录。每条记录包含 `id`、`manifest`、`source_type`、`source_url`、`data_base`、`plugin_base`、`eec`、`eec_anchored`、`sig`、`author_pub`、`author_sig`、`code`、`enabled`、`installed_at`,校验失败的记录另带 `trusted: false`。

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
| `eec_anchored` | 证书链是否已在本地校验通过 | 安装与恢复时按内置根 CA 的链校验结果写入;旧记录按未校验处理,恢复时重新校验并重写 |
| `source_trust` | 信任清单判定(`trusted`、`endorsed`、`untrusted`、`unverified`) | 安装时由插件市场传入,只用于界面展示是否被官方认可;旧记录没有该字段 |
| `trust_failure` | 信任清单给出的失败原因(`missing`、`chain`、`revoked`) | 安装时由插件市场传入,只用于界面展示;来源结论的原因由本地链校验给出 |
| `sig` | `plugin.js.sig` 的 base64(DER 字节) | 版本目录下的 `plugin.js.sig` |
| `author_pub` | 作者公钥 PEM,作者裸签名验签用 | 在线插件取 `plugins/<作者>/author_pub.pem`,离线包取包内 `author_pub.pem` |
| `author_sig` | 作者签名的 base64(原始 64 字节) | `plugin.js.author.sig` |
| `catalog_verified` | 合集根目录数据是否已按 L1 清单校验通过 | 安装时由插件市场传入;旧记录没有该字段 |
| `meta_verified` | 该版本是否已按 L3 清单校验通过 | 安装时由插件市场传入;旧记录没有该字段 |
| `manifest_revisions` | 各层清单 `revision` | 安装时由插件市场传入,重装时用于回退提示 |

缺失某个字段表示这条记录没有对应的签名材料,启动校验按未校验处理。旧版的 `pub` 与 `sign` 字段(JSON 信任签名方案)不再读取,升级后已安装插件显示为未校验,重新安装即可拿到新字段。没有任何一项校验字段的记录视为旧版本安装,已安装列表在来源结论旁提示重新安装,并在操作列给出「重新安装」入口,按记录的同一版本走一次完整安装流程。

`code` 保存插件代码文本,在线与本地插件都写:在线插件在安装阶段下载 `plugin.js` 后按 UTF-8 文本存入,本地插件取离线包内的 `plugin.js`。启动恢复只用它重建 Blob URL 再 `import()`,不再为启动拉取网络;网络不可达时插件照常启动。写入前已确认代码文本可以还原成原始字节,签名针对原始字节计算,因此重建后的字节与验签时一致。单个插件代码上限 2 MB(见 `types.ts` 的 `MAX_PLUGIN_CODE_BYTES`),在线与本地共用这一上限,超限时拒绝安装并给出原因。

安装、卸载、启用与停用都立即落盘;依赖未满足导致的自动停用同样落盘。落盘失败只写入 `engineLogs()`,不影响内存状态。IndexedDB 不可用时降级为内存存储,同样只记引擎日志,不抛错。

待决定冲突组单独落在同一库的 `conflict-groups` 仓库(主键 `id`),每次变更整体覆盖写入,由引擎在检测到冲突、用户做出选择、插件卸载与启动恢复四处同步;读取时按冲突对重建组 id 与插件清单,单条损坏只丢弃该条,两条指向同一组时保留检测时间较新的一条。引擎内存里保留一份副本,界面用 `engine.pendingConflicts()` 直接读取,不必等待 IndexedDB。

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

`installFromUrl()` 先 `fetch` 产物字节,再按 UTF-8 文本存进安装记录,然后用 `loadPluginModuleFromCode()` 建 Blob URL 加载模块;安装阶段与启动阶段走同一条加载路径,启动阶段不再请求网络。安装成功后自动启用:与已安装插件的冲突不再在安装期拒绝,检出时发警告,对方在启用中时新插件保持停用、不发自动启用,冲突写入待决定记录;其余情形照常自动启用,若启用被依赖拒绝,安装本身仍成功,结果里的 `activation` 记录启用的结构化结论,供界面避免用「安装完成」覆盖启用被拒的提示。`fetch` 跨源时浏览器要求托管方返回 `Access-Control-Allow-Origin`,缺失时字节拉不到,引擎按 `artifact-unreachable` 拒绝安装,原始错误只写入 `engineLogs()`。`loader.ts` 只判定协议与主机,不介入 CORS;`installFromUrl` 在拉取前用同一判定拒绝非 https 且非回环的地址。

### 签名校验

签名体系由两部分组成,约定见 [信任链与 PKI 签名](../../../docs/user/develop/basic/trust-chain.md):

| 签名 | 签发方 | 材料 | 验签入口 |
|:---:|:---:|:---:|:---:|
| 合集 CMS 分离签名 | 合集 EEC 证书 | `plugin.js.sig` | `src/services/integrity/cms.ts` 的 `verifyDetachedCms` |
| 作者裸签名 | 插件作者 | `plugin.js.author.sig`、`author_pub.pem` | `src/services/integrity/ed25519.ts` 的 `verifyDetachedSignature` |
| 三层清单签名 | 合集 EEC 证书 | 每层的 `manifest.json.sig` | `src/services/integrity/manifest.ts` 的 `verifyManifest`,由插件市场调用 |

只发布整站签名的来源(下称整站模型)不需要引擎侧的额外分支:它的 `plugin.js` 同样带一份 `plugin.js.sig`,签名者是来源的整站签名证书,引擎按 `eec` 与 `eecUrls` 取证书、校链、再验签,与合集的 CMS 验签走同一条通道。整站模型常见把证书放在来源根目录的 `eec.pem`,正好落在三档取件的第三档。整站模型没有 L2 清单,`authorPubSha512` 缺省,作者公钥不做哈希把关,作者签名仍按 `plugin.js.author.sig` 与 `author_pub.pem` 校验,失败只提示、不阻断安装。

CMS 签名是逐字节语义,验签对象是 `plugin.js` 的原始字节,签名者为该来源的 EEC 证书;作者签名是 Ed25519 裸签名,同样直接对原始字节验签,不做摘要预处理。`verifyDetachedCms` 要求同时传入签名者证书与根证书,函数内部先用根证书校验证书链,未通过直接返回 false,未校验链的证书不会进入验签。`signature.ts` 负责把两种签名收拢成一个 `verified`、`failed`、`unverified` 结论:合集证书先过链校验,链不通过时不发起 CMS 验签;两种材料都有时须同时通过,只有一种材料时只校验该种,都没有时为 `unverified`。证书链与 CMS 校验模块按需动态加载,未启用签名校验的构建不会把 `pkijs` 带进首屏代码。

来源结论另按四态给出,判定只看本地结论: 证书链通过且 CMS 验签通过才算已确认。

| 结论 | 含义 | 触发条件 |
|:---:|:---:|:---:|
| `confirmed` | 来源已确认 | 证书链在本地校验通过,且 CMS 验签通过 |
| `failed` | 校验未通过 | 证书链不通过(过期、非本根签发、被吊销),或拿不到证书、验签不通过 |
| `unknown` | 无法确认来源 | 完全没有来源信息 |
| `local` | 本地安装 | 用户上传的离线包,没有来源,不参与来源判定 |

目录数据的签名材料与产物签名相互独立：`plugin.js` 只按 `plugin.js.sig` 验签,目录材料缺失或验签失败只让「目录数据是否已校验」为否,不改变产物结论,也不改变来源结论。目录材料在合集模型下是三层清单,在只发布整站签名的来源下是 `web_files.json` 与逐文件签名;两种模型都只通过安装来源里的 `catalogVerified`、`metaVerified` 表达结论,引擎不需要区分模型,整站模型的 `manifest_revisions` 为空。安装记录另存 `catalog_verified`、`meta_verified` 与 `manifest_revisions`,界面按 `catalogVerified` 展示「目录数据已校验」或「目录数据未校验」;同一插件重装时若某层 `revision` 小于记录值,引擎日志记一条并给一次提示,不阻断安装。

验签证书优先取信任清单登记的那张,清单未登记时按 `eecUrls` 的顺序取来源自带的嵌套路径 `certs/<合集 id>/<合集 id>-eec.crt`、旧站点的扁平路径 `certs/<合集 id>-eec.crt` 与兜底的 `eec.pem`;三档都必须先用内置根 CA 校验证书链,链不通过时结论为 `failed`(原因 `chain` 或 `revoked`),不会发起 CMS 验签,引擎日志记一条 `certificate chain ..., cms skipped`。拿不到证书或验签不通过同样记为 `failed`(原因 `other`),其中信任清单登记了证书而证书文件缺失的情形界面单列「来源证书缺失」;只有完全没有来源信息才是 `unknown`。安装记录用 `eec_anchored` 标记证书链是否已在本地校验通过,用 `source_trust`、`trust_failure` 保存信任清单判定;启动恢复按存储的证书重新做链校验并重写标记,只有链通过且验签通过的记录才算 `confirmed`。信任清单的结论只用于界面展示,未登记时在「来源已确认」旁补一条「未在官方清单登记」的中性标注。

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

提交阶段用包内代码建 Blob URL 加载模块。清单优先由 `meta.json` 的 `capabilities` 推导(与插件市场同一 id 规则),缺该字段时用产物导出的 `manifest`,两者都没有时按 `invalid-manifest` 拒绝;`meta.json` 没写 `mounts` 时,用产物导出清单的挂载点补齐,规则与在线安装一致。安装记录写入 `source_type: "local"`、留空 `source_url`、`data_base` 与 `plugin_base`,按包内材料填 `author_pub` 与 `author_sig`,并保存 `code`;离线包不写 `eec` 与 `sig`。

### 内置插件

内置插件的清单、工厂与 id 集合统一在 `builtin.ts` 维护,新增内置插件只需在该文件追加一条。当前内置插件为 `dsc-market`,源码见 `src/components/dsc-market/`,负责拉取外源插件索引并对外提供查询。

### 隔离与降级

- `activate` 与 `deactivate` 各自有超时,抛错只把该插件标记为 `failed`,引擎与其他插件继续工作;激活中途失败会先撤销已注册的挂载点与释放函数,再标记失败。
- 事件分发逐个插件、逐个处理器隔离,同步抛错与异步拒绝都只写入该插件日志。
- 请求前处理器同样逐个插件隔离:超时与抛错只让本次补丁作废,请求按原参数发出,引擎与其他插件继续工作。
- 能力调用失败不会破坏核心状态：核心侧只做只读视图转换或既有 store 方法调用。
- 插件日志按插件保存在内存,上限 100 条,经 `engine.logs(id)` 读取,不写控制台;引擎自身日志经 `engine.engineLogs()` 读取。
- 启动恢复逐个插件隔离,单个插件加载失败不影响其余插件与宿主渲染。
- 启用期冲突按保守策略处置:先把冲突双方全部停用并写入待决定记录,再由用户在插件页选择保留哪一个;结构化冲突列表写进引擎日志与插件日志,界面按单向与双向两条成对文案警告。

## dsh 映射表

| dsh 概念 | dsh 侧参考 | dsc 最小对应实现 | 落地文件 |
|:---:|:---:|:---:|:---:|
| 插件声明与清单 | 包 `package.json` 的 `dsh` 字段、`cordis.yml` 条目、配置目录 | `PluginManifest` 内联声明,安装时校验 | `types.ts`、`registry.ts` |
| 注册与加载 | `plugin-manager` 的安装操作、`cordis-plugin-loader`、`client/modules` 的懒注册表 | `install()` 注册实例;`installFromUrl()` 运行时 `import` | `index.ts`、`loader.ts` |
| 生命周期 | Cordis fiber 的挂载、激活与 `ctx.effect` 释放 | `registered` / `active` / `inactive` / `failed`,停用时执行 disposers | `index.ts`、`registry.ts` |
| 服务与依赖注入 | `ctx.<key>` 服务与 `inject` 依赖 | `PluginContext` 能力对象与 `dependencies` 校验（安装、启用、停用、卸载四处） | `capabilities.ts`、`registry.ts`、`dependencies.ts` |
| 能力/挂载点注册 | `ui-slots` 的 slot 注册、`ctx.effect` 可逆副作用 | `events.on(point, handler)` 注册挂载点并返回释放函数 | `capabilities.ts` |
| 全局面板与会话内视图 | `sidebar.panellist` + `main` 的成对注册、`conversation.view` 的会话内页签、`conversation.session.panel.section`、`sidebar.right.pane.tab` | 封闭槽位枚举 + 清单 slots 白名单,`context.ui.registerSlot` 登记声明式描述,宿主按槽位渲染导航行、标签栏、主区页面与会话右栏的段落和标签页 | `pluginSlots.ts` |
| 权限与沙箱边界 | profile patch 的沙箱与审批、插件在宿主进程内运行 | 能力白名单、凭证与票据、限流与超时、内置 id 白名单;联网只经 `context.net`(第三方插件不可用)与 `context.assets`(只读远端资产);插件拿不到 `CoreApi` 与 store 句柄 | `../dsc-core/guard.ts`、`capabilities.ts`、`registry.ts` |
| 错误隔离与降级 | 单条目失败只影响自身,其余插件照常运行 | 生命周期超时与 try/catch、事件逐个隔离、恢复失败标记、失败标记与 Toast | `index.ts` |
| 供应端点注册 | 服务注册与 `ctx.provide`,按提供方合并 | 插件交端点描述,引擎合并成注册表并给出能力矩阵与冲突 | `sources.ts`、`../dsc-core/source-catalog.ts` |
| 配置持久化 | `cordis.yml` 与配置目录 | 安装记录写 IndexedDB `<APP_NAME>-plugins` 的 `plugins` 仓库,插件配置走 `plugins:storage` 写 `<APP_NAME>:plugin-data:<id>`,供应端点凭证另存 `<APP_NAME>-plugin-sources`(键为端点 id + 基址) | `db.ts`、`credentials.ts`、`../dsc-core/plugin-data.ts` |
| 插件设置面 | Plugins 页 + `settings.section`,页面骨架由宿主画 | 激活期登记字段描述,宿主渲染表单;值分默认层与覆盖层,secret 走凭证库;覆盖状态与变更订阅对插件只读开放 | `pluginSettings.ts`、`../dsc-core/plugin-settings.ts` |
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
    mounts: ['session:changed'],
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

// 设置表面：申请 settings:surface，激活期登记字段描述
engine?.install(
  {
    id: 'demo-settings',
    name: 'Demo Settings',
    version: '1.0.0',
    engines: '^1.0.0',
    capabilities: ['settings:surface'],
  },
  {
    activate(context) {
      context.settings.register({
        fields: [
          { key: 'mode', type: 'select', label: '模式', default: 'fast', options: [
            { value: 'fast', label: '快速' },
            { value: 'accurate', label: '精确' },
          ] },
          { key: 'threshold', type: 'number', label: '阈值', default: 0.5, min: 0, max: 1 },
          { key: 'token', type: 'secret', label: '令牌' },
        ],
      })
      const values = context.settings.values()
      context.log('mode = ' + String(values.mode))
    },
  }
)
await engine?.activate('demo-settings')

// UI 槽位：申请 ui:slot 并用 slots 白名单声明槽位，激活期登记页面描述
engine?.install(
  {
    id: 'demo-slots',
    name: 'Demo Slots',
    version: '1.0.0',
    engines: '^1.0.0',
    capabilities: ['ui:slot'],
    slots: ['nav.panel'],
  },
  {
    activate(context) {
      const handle = context.ui.registerSlot({
        slot: 'nav.panel',
        id: 'catalog',
        title: '资产目录',
        iconKey: 'browse',
        order: 10,
        blocks: [{ id: 'intro', type: 'text', text: '浏览来源并安装资产。' }],
      })
      context.ui.onSlotAction(handle.slot, (payload) => {
        context.log('action ' + payload.actionId + ' on ' + payload.slot + '/' + payload.id)
        return { refresh: true }
      })
      context.ui.onSlotData(handle.slot, (slot, id) => {
        // 返回 null 表示沿用登记时的描述
        return slot === 'nav.panel' && id === 'catalog' ? null : null
      })
    },
  }
)
await engine?.activate('demo-slots')

// 请求前补丁：申请 chat:request 并声明挂载点 chat:before-request
engine?.install(
  {
    id: 'demo-patch',
    name: 'Demo Patch',
    version: '1.0.0',
    engines: '^1.0.0',
    capabilities: ['chat:request'],
    mounts: ['chat:before-request'],
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
