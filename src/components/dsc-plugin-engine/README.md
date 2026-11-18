# dsc-plugin-engine

`dsc-plugin-engine` 是 dsc 的内置组件，模仿 DeepSeekRuntime（下称 dsh）的插件机制做浏览器内最小实现。它向 `dsc-core` 申请内部接口，再封装成受限能力对象交给插件。

## 目录结构

```
dsc-plugin-engine/
├── index.ts        # 引擎入口：安装、启停、卸载、启动恢复
├── types.ts        # 插件契约（manifest、context、contribution）
├── loader.ts       # 浏览器内加载插件运行时 js 产物
├── capabilities.ts # 能力白名单与受限代理（安全封装层）
├── registry.ts     # 插件注册表、依赖与冲突校验、内置 id 集合
├── db.ts           # 安装记录持久化（IndexedDB，不可用时降级为内存）
├── storage.ts      # 旧版 localStorage 记录的读取与清理，仅用于迁移
├── localPackage.ts # 本地离线包解析与校验：zip、tgz、meta.json、签名
├── signature.ts    # 插件产物签名校验：拉取字节并验签
├── builtin.ts      # 内置插件清单与工厂
└── README.md       # 机制说明与 dsh 映射表
```

## 机制

### 清单

| 字段 | 必填 | 说明 |
|:---:|:---:|:---:|
| `id` | 是 | 小写字母开头，允许数字与连字符，3 到 64 字符 |
| `name` | 是 | 展示名称，不得为空 |
| `version` | 是 | `主版本.次版本.修订号` |
| `engines` | 否 | 兼容的 dsc-core 版本范围，支持 `^`、`~`、`>=`、`<=` 与精确版本 |
| `dependencies` | 否 | 依赖的插件 id，安装时须已存在，激活时须已激活 |
| `conflicts` | 否 | 冲突的插件 id，同时安装会被拒绝 |
| `capabilities` | 是 | 申请的能力，必须在核心能力表内且不得重复 |
| `contributions` | 否 | 订阅的贡献点，必须在贡献点表内且不得重复 |

清单可以随产物一起导出：`export const manifest = {...}`，也可以挂在 `default` 导出对象上，模块顶层优先。`installFromUrl(url)` 省略清单时使用产物自带的 `manifest`；两者都没有时安装被拒绝，原因为 `invalid-manifest`。

`installFromUrl(url, manifest?, source?)` 的 `source` 携带来源类型与签名材料：`sourceType` 取 `inner`、`awesome`、`outer`、`local` 之一，缺省按 `outer` 处理；`pub` 与 `sign` 同时给出时，安装阶段先拉取产物字节做 SHA-512 摘要并验签，不通过则以 `signature-invalid` 拒绝安装。

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
| `events:session` | 5 次 / 10 秒 | 同步调用 | `context.events.on` |
| `notify` | 10 次 / 10 秒 | 同步调用 | `context.ui.notify` |
| `settings:locale` | 60 次 / 10 秒 | 3 秒 | `context.settings.locale` |
| `net:fetch` | 10 次 / 10 秒 | 内层 10 秒后中止请求 | `context.net.getText` |
| `net:fetch-post` | 10 次 / 10 秒 | 内层 5 秒后中止请求 | `context.net.postJson` |
| `plugins:storage` | 100 次 / 10 秒 | 同步调用 | `context.storage.get`、`set`、`remove` |

超限抛 `PluginRateLimitError`，未授予抛 `PluginCapabilityError`，超时抛 `PluginTimeoutError`，取消抛 `PluginAbortError`；限流与超时同时用既有 Toast 提示。

`plugins:data-clear` 是引擎管理专用能力，不在 `CORE_CAPABILITIES` 内，插件清单申请它时按 `unknown-capability` 拒绝，也不会出现在插件上下文中。`net:fetch-post` 同理：它是 `context.net.postJson` 背后的独立能力标识，有自己的限流窗口与超时，插件清单不能申请，只能通过 `net:fetch` 的授予间接使用。

### net:fetch 的可见性

`net:fetch` 只对内置插件开放。引擎启动时把 `builtin.ts` 里的插件 id 登记进注册表；安装校验时若清单申请了 `net:fetch` 而 id 不在集合内，直接返回 `unknown-capability`，第三方插件无法把它与一个不存在的能力区分开。能力调用层会再校验一次，防止绕过安装校验直接拿到 `context.net`。

请求约束全部由 `dsc-core` 的 `net.ts` 落实：只允许 https 与 GET，不发送 Cookie 与自定义请求头（`credentials: 'omit'`），只接受 `text/*` 与 `application/json` 响应，响应体上限 512KB，超时 10 秒并用 `AbortController` 真正中止请求。网络失败与解析失败由插件自行降级，引擎不弹宿主提示。

`context.net.postJson` 面向不计结果的计数请求：只允许 https 与 JSON 请求体，请求体与响应体上限各 4KB，超时 5 秒，不跟随重定向，响应体丢弃只回传状态码。它复用 `net:fetch` 的授予口径，但用自己的限流窗口，避免计数请求挤占读取预算。

### 持久化与启动恢复

安装记录写入 IndexedDB 的 `<APP_NAME>-plugins` 库（版本 1，对象仓库 `plugins`，主键 `id`），与聊天历史库分开建库，互不影响。每条记录包含 `id`、`manifest`、`source_type`、`source_url`、`pub`、`sign`、`code`、`enabled`、`installed_at`，校验失败的记录另带 `trusted: false`。

`source_type` 取 `inner`（随本体分发）、`awesome`（精选合集）、`outer`（其他在线来源）、`local`（用户上传）之一；`source_url` 只对在线插件存在，存其 `plugin.js` 地址，`local` 来源留空；`pub` 与 `sign` 是获取插件时拿到的公钥 PEM 与 `plugin.js` 签名 base64，缺失表示该记录没有可校验的签名材料。

`code` 只对 `local` 来源存在,保存插件代码文本:本地插件没有可重新拉取的地址,启动恢复时用它重建 Blob URL 再 `import()`;在线插件不写该字段,恢复时按 `source_url` 重新加载。写入前已确认代码文本可以还原成原始字节,签名针对原始字节计算,因此重建后的字节与验签时一致。

安装、卸载、启用与停用都立即落盘；落盘失败只写入 `engineLogs()`，不影响内存状态。IndexedDB 不可用时降级为内存存储，同样只记引擎日志，不抛错。

旧版 localStorage 键 `<APP_NAME>:plugins` 在首次启动时迁移一次：`source.kind === 'url'` 的记录转为 `outer` 并保留地址，`builtin` 转为 `inner`，`pub` 与 `sign` 留空；迁移成功后删除旧键，失败只记日志、不阻断启动。

`installPluginEngine()` 保持同步返回，恢复在内部异步进行，不阻塞首屏渲染：

```
installPluginEngine()   # 同步：建凭证、打开核心、登记内置 id、返回实例
  └── restore()         # 异步：读取安装记录并完成旧版迁移
      ├── 先装载 builtin.ts 的内置插件（首次出现默认启用）
      ├── 再并发校验在线插件签名(上限 4),不通过的记录标记不可信且不激活
      ├── 接着按存储顺序恢复在线插件,加载失败则标记 failed 并在 list() 中可见
      └── 最后恢复本地插件：按存储的 code 重建模块，带签名材料时先对代码验签
```

宿主通过 `install()` 直接注册的插件没有可恢复来源，不写入安装记录。恢复失败的占位记录没有插件实例，`activate()` 会拒绝并提示 `pluginRestoreFailed`，但允许重新安装覆盖。

卸载插件时，引擎在移除记录后调用核心清除该插件的 `plugins:storage` 数据；清理失败只写入 `engineLogs()`，不影响卸载结果。

### 运行时加载与跨源

`installFromUrl()` 用 `import()` 在页面内加载产物：与页面同源时直接可用；跨源时浏览器要求托管方返回 `Access-Control-Allow-Origin`，缺失时 `import()` 被拒绝，引擎按 `load-failed` 拒绝安装，原始错误只写入 `engineLogs()`。`loader.ts` 只判定协议与主机，不介入 CORS。

### 签名校验

插件产物按签名约定做 hash-then-sign：对 `plugin.js` 字节取 SHA-512 摘要，再用公钥验证摘要的 Ed25519 签名，签名编码为 base64。验签直接复用 `src/services/integrity/ed25519.ts` 的 `sha512`、`verifyEd25519`、`readPublicKey`，只新增 `base64ToBytes` 与 `verifyBytesSignature` 两个入口。

- 安装阶段：`installFromUrl` 传入 `pub` 与 `sign` 时先校验，不通过返回 `signature-invalid` 并拒绝安装。
- 本地安装:`inspectLocalPackage` 在预检阶段对包内 `plugin.js` 字节验签,不通过返回 `signature-invalid`,包内没有签名材料时按 `unverified` 安装。
- 启动阶段:`restore()` 对每条带 `source_url`、`pub`、`sign` 的记录重新拉取当前字节并验签,并发上限 4;`local` 记录改用存储的 `code` 字节验签,不再发起网络请求。
- 校验不通过：不激活该插件，记录标记为不可信（`trusted: false`），提示用户「插件签名校验未通过，建议重新下载」，记录保留在 `list()` 中供用户手动卸载。
- 字节拉取失败：视为网络问题而不是篡改，按 `pluginRestoreFailed` 处理，不标记不可信。
- 拉取使用 `cache: 'no-store'`，避免命中旧缓存得出错误的通过结论。

### 本地安装与离线包

`inspectLocalPackage(file)` 做预检,`installFromLocalFile(file)` 是预检加提交的组合入口。二次确认在界面层完成:预检只读文件并校验,返回待安装信息与提交函数,提交前不改动注册表与安装记录,也不把 `File` 放进引擎状态。

| 包格式 | 产物位置 | 说明 |
|:---:|:---:|:---:|
| zip | 包根目录 | 根目录直接放 `meta.json`、`plugin.js`,可选 `plugin_sign.json` 与 `plugin_secret.pub`;子目录内容忽略 |
| tgz(npm 包) | `package/dist/` | 只取该目录下的文件,`package/` 下的其他内容一律忽略 |

zip 用 `fflate` 的 `unzipSync` 解压;tgz 用 `gunzipSync` 解压后交给最小 tar 读取器 `readTarEntries`,它只收普通文件条目,pax 头、GNU 长名头与目录条目跳过。两者都不新增依赖。

预检的校验顺序与失败原因:

| 检查 | 失败原因 |
|:---:|:---:|
| 扩展名为 `.zip` 或 `.tgz` | `unsupported-package` |
| 压缩包可解压 | `corrupt-package` |
| 存在 `meta.json` | `missing-meta` |
| 存在 `plugin.js` | `missing-plugin` |
| `meta.json` 可解析,`name`、`version`、`author` 非空,`version` 为三段数字 | `invalid-meta` |
| `plugin.js` 是可还原的 UTF-8 文本 | `corrupt-package` |
| 同时有 `plugin_sign.json` 与 `plugin_secret.pub` 时,`for` 为 `plugin.js` 的签名通过 | `signature-invalid` |
| `plugin.js` 不超过 1 MB | `package-too-large` |

包内只有一半签名材料时按 `unverified` 安装,并在引擎日志里记一条说明。预检通过后返回待安装信息,包含 id、名称、版本、作者、许可证、签名状态与「是否已安装同 id」;同 id 已存在时提交返回 `duplicate`,不覆盖已有记录。

提交阶段用包内代码建 Blob URL 加载模块。清单优先由 `meta.json` 的 `capabilities` 推导(与插件市场同一 id 规则),缺该字段时用产物导出的 `manifest`,两者都没有时按 `invalid-manifest` 拒绝。安装记录写入 `source_type: "local"`、留空 `source_url`、按包内材料填 `pub` 与 `sign`,并保存 `code`。

### 内置插件

内置插件的清单、工厂与 id 集合统一在 `builtin.ts` 维护，新增内置插件只需在该文件追加一条。当前内置插件为 `dsc-market`，源码见 `src/components/dsc-market/`，负责拉取外源插件索引并对外提供查询。

### 隔离与降级

- `activate` 与 `deactivate` 各自有超时，抛错只把该插件标记为 `failed`，引擎与其他插件继续工作；激活中途失败会先撤销已注册的贡献点与释放函数，再标记失败。
- 事件分发逐个插件、逐个处理器隔离，同步抛错与异步拒绝都只写入该插件日志。
- 能力调用失败不会破坏核心状态：核心侧只做只读视图转换或既有 store 方法调用。
- 插件日志按插件保存在内存，上限 100 条，经 `engine.logs(id)` 读取，不写控制台；引擎自身日志经 `engine.engineLogs()` 读取。
- 启动恢复逐个插件隔离，单个插件加载失败不影响其余插件与宿主渲染。

## dsh 映射表

| dsh 概念 | dsh 侧参考 | dsc 最小对应实现 | 落地文件 |
|:---:|:---:|:---:|:---:|
| 插件声明与清单 | 包 `package.json` 的 `dsh` 字段、`cordis.yml` 条目、配置目录 | `PluginManifest` 内联声明，安装时校验 | `types.ts`、`registry.ts` |
| 注册与加载 | `plugin-manager` 的安装操作、`cordis-plugin-loader`、`client/modules` 的懒注册表 | `install()` 注册实例；`installFromUrl()` 运行时 `import` | `index.ts`、`loader.ts` |
| 生命周期 | Cordis fiber 的挂载、激活与 `ctx.effect` 释放 | `registered` / `active` / `inactive` / `failed`，停用时执行 disposers | `index.ts`、`registry.ts` |
| 服务与依赖注入 | `ctx.<key>` 服务与 `inject` 依赖 | `PluginContext` 能力对象与 `dependencies` 校验 | `capabilities.ts`、`registry.ts` |
| 能力/贡献点注册 | `ui-slots` 的 slot 注册、`ctx.effect` 可逆副作用 | `events.on(point, handler)` 注册贡献点并返回释放函数 | `capabilities.ts` |
| 权限与沙箱边界 | profile patch 的沙箱与审批、插件在宿主进程内运行 | 能力白名单、凭证与票据、限流与超时、内置 id 白名单；插件拿不到 `CoreApi` 与 store 句柄 | `../dsc-core/guard.ts`、`capabilities.ts`、`registry.ts` |
| 错误隔离与降级 | 单条目失败只影响自身，其余插件照常运行 | 生命周期超时与 try/catch、事件逐个隔离、恢复失败标记、失败标记与 Toast | `index.ts` |
| 配置持久化 | `cordis.yml` 与配置目录 | 安装记录写 IndexedDB `<APP_NAME>-plugins` 的 `plugins` 仓库，插件配置走 `plugins:storage` 写 `<APP_NAME>:plugin-data:<id>` | `db.ts`、`../dsc-core/plugin-data.ts` |
| 内置插件 | dsh 自带插件包与内置 bundle | `builtin.ts` 清单，启动时先于外部插件装载 | `builtin.ts` |
| 热重载 | `dsh-hmr` | 未实现，刷新页面重新加载 | 无 |

只取能在浏览器里落地的最小集合：不引入 Node 内置模块、不做后端、不新增依赖，插件产物按普通 ESM 在页面内加载。

## 接入方式

引擎在 `src/main.tsx` 注册一次：

```ts
installPluginEngine()
```

之后通过 `getPluginEngine()` 取实例，用 `install`、`installFromUrl`、`inspectLocalPackage`、`installFromLocalFile`、`activate`、`deactivate`、`unload`、`list` 管理插件，用 `logs(id)`、`engineLogs()`、`bypassEvents()` 排查问题。`installFromUrl(url, manifest?, source?)` 的清单可以省略，省略时取产物自带的 `manifest` 导出；`source` 省略时来源记为 `outer` 且不校验签名。`install()` 直接注册的宿主内联插件不写安装记录。

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

// 运行时安装：清单由产物自带的 manifest 导出提供
await engine?.installFromUrl('https://example.com/demo-plugin.js')

// 也可以显式传入清单，此时以传入的为准
await engine?.installFromUrl('https://example.com/demo-plugin.js', {
  id: 'demo-plugin',
  name: 'Demo',
  version: '1.0.0',
  capabilities: ['notify'],
})

// 带来源与签名材料：安装阶段先验签，不通过返回 signature-invalid
await engine?.installFromUrl('https://example.com/demo-plugin.js', undefined, {
  sourceType: 'awesome',
  pub: publicKeyPem,
  sign: signatureBase64,
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
