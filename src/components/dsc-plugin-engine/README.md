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
├── storage.ts      # 安装记录持久化（localStorage）
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
| `plugins:storage` | 100 次 / 10 秒 | 同步调用 | `context.storage.get`、`set`、`remove` |

超限抛 `PluginRateLimitError`，未授予抛 `PluginCapabilityError`，超时抛 `PluginTimeoutError`，取消抛 `PluginAbortError`；限流与超时同时用既有 Toast 提示。

### net:fetch 的可见性

`net:fetch` 只对内置插件开放。引擎启动时把 `builtin.ts` 里的插件 id 登记进注册表；安装校验时若清单申请了 `net:fetch` 而 id 不在集合内，直接返回 `unknown-capability`，第三方插件无法把它与一个不存在的能力区分开。能力调用层会再校验一次，防止绕过安装校验直接拿到 `context.net`。

请求约束全部由 `dsc-core` 的 `net.ts` 落实：只允许 https 与 GET，不发送 Cookie 与自定义请求头（`credentials: 'omit'`），只接受 `text/*` 与 `application/json` 响应，响应体上限 512KB，超时 10 秒并用 `AbortController` 真正中止请求。网络失败与解析失败由插件自行降级，引擎不弹宿主提示。

### 持久化与启动恢复

安装记录写入 localStorage 的 `<APP_NAME>:plugins` 键，每项包含 `manifest`、`source` 与 `enabled`；`source` 为 `{ kind: 'builtin' }` 或 `{ kind: 'url', url }`。安装、卸载、启用与停用都立即落盘；落盘失败只写入 `engineLogs()`，不影响内存状态。

`installPluginEngine()` 保持同步返回，恢复在内部异步进行，不阻塞首屏渲染：

```
installPluginEngine()   # 同步：建凭证、打开核心、登记内置 id、返回实例
  └── restore()         # 异步：读取安装记录
      ├── 先装载 builtin.ts 的内置插件（首次出现默认启用）
      └── 再恢复 url 来源的插件，import 失败则标记 failed 并在 list() 中可见
```

宿主通过 `install()` 直接注册的插件没有可恢复来源，不写入安装记录。恢复失败的占位记录没有插件实例，`activate()` 会拒绝并提示 `pluginRestoreFailed`，但允许重新安装覆盖。

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
| 配置持久化 | `cordis.yml` 与配置目录 | 安装记录写 `<APP_NAME>:plugins`，插件配置走 `plugins:storage` 写 `<APP_NAME>:plugin-data:<id>` | `storage.ts`、`../dsc-core/plugin-data.ts` |
| 内置插件 | dsh 自带插件包与内置 bundle | `builtin.ts` 清单，启动时先于外部插件装载 | `builtin.ts` |
| 热重载 | `dsh-hmr` | 未实现，刷新页面重新加载 | 无 |

只取能在浏览器里落地的最小集合：不引入 Node 内置模块、不做后端、不新增依赖，插件产物按普通 ESM 在页面内加载。

## 接入方式

引擎在 `src/main.tsx` 注册一次：

```ts
installPluginEngine()
```

之后通过 `getPluginEngine()` 取实例，用 `install`、`installFromUrl`、`activate`、`deactivate`、`unload`、`list` 管理插件，用 `logs(id)`、`engineLogs()`、`bypassEvents()` 排查问题。

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
```
