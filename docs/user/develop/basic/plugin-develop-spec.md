# dsc 插件开发规范

本文说明如何按 `dsc-plugin-engine` 的契约编写 dsc 插件。规范只描述已实现的能力。

## 开发约束

- 纯前端运行：只用浏览器 API,不引入 Node 内置模块、后端接口与新增依赖。
- 不直接访问内核：插件拿不到 `dsc-core` 的 `CoreApi`、`zustand` store 句柄与 IndexedDB 句柄,只能使用 `context` 上的受限能力对象。
- 不直接操作宿主 DOM：`context` 未提供任何 DOM 或插槽接口,界面提示统一走 `context.ui.notify`。
- 用户可见文案使用宿主文案键：`notify` 的 `key` 取值来自 `src/i18n` 的既有键,不硬编码中文或英文句子。
- 代码风格与宿主一致：单引号、无分号、2 空格缩进、具名导出、模块内相对导入带 `.js` 后缀。

## 插件对象

```ts
import type { PluginContext } from './components/dsc-plugin-engine/index.js'

export const activate = (context: PluginContext) => {
  context.events.on('session:changed', (event) => {
    context.log('active: ' + String(event.activeId ?? 'none'))
  })
}

export const deactivate = () => {}
```

`activate` 可返回 Promise,超时 5 秒;`deactivate` 可返回 Promise,超时 3 秒。`context.events.on` 返回的释放函数由引擎在停用与卸载时自动执行,`activate` 的返回值被忽略,插件不需要也不应返回释放函数。

## 导出清单

产物可以导出具名 `manifest`,用户从地址安装时就不需要再提供清单：

```ts
import type { PluginContext, PluginManifest } from './components/dsc-plugin-engine/index.js'

export const manifest: PluginManifest = {
  id: 'demo-plugin',
  name: 'Demo',
  version: '1.0.0',
  capabilities: ['notify'],
}

export const activate = (context: PluginContext) => {
  context.log('demo plugin activated')
}
```

`manifest` 写在模块顶层或 `default` 导出对象上都可识别,模块顶层优先;宿主调用 `installFromUrl(url, manifest)` 并显式传入清单时以传入的为准。两者都没有时安装被拒绝,原因为 `invalid-manifest`。

## 能力清单

| 能力 | 上下文成员 | 签名 | 限流 |
|:---:|:---:|:---:|:---:|
| `sessions:list` | `context.sessions.list` | `(options?) => Promise<CoreSessionSummary[]>` | 30 次 / 10 秒 |
| `sessions:read` | `context.sessions.read` | `(id, options?) => Promise<CoreSessionView \| null>` | 30 次 / 10 秒 |
| `sessions:rename` | `context.sessions.rename` | `(id, title) => boolean` | 5 次 / 10 秒 |
| `events:session` | `context.events.on` | `(point, handler) => () => void` | 5 次 / 10 秒 |
| `notify` | `context.ui.notify` | `(key, params?) => void` | 10 次 / 10 秒 |
| `settings:locale` | `context.settings.locale` | `(options?) => Promise<'zh-CN' \| 'en-US'>` | 60 次 / 10 秒 |
| `plugins:storage` | `context.storage.get` | `(key) => unknown` | 100 次 / 10 秒 |
| `plugins:storage` | `context.storage.set` | `(key, value) => void` | 100 次 / 10 秒 |
| `plugins:storage` | `context.storage.remove` | `(key) => void` | 100 次 / 10 秒 |

`net:fetch` 不出现在上表中：该能力只对内置插件可见,第三方插件清单里写 `net:fetch` 时安装结果为 `unknown-capability`。

`options` 为 `{ signal?: AbortSignal }`,用于取消异步调用;取消抛 `PluginAbortError`。异步能力单次超时 3 秒,超时抛 `PluginTimeoutError`。

## 插件数据

`context.storage` 只有 `get`、`set`、`remove` 三个同步方法,值必须是可 JSON 序列化的对象：

| 项 | 规定 |
|:---:|:---:|
| 存储位置 | 浏览器 localStorage,键为 `<APP_NAME>:plugin-data:<插件 id>` |
| 单插件总量 | 上限 64KB,超出抛 `PluginDataError` 并提示宿主文案 |
| 序列化失败 | 值含函数、undefined、循环引用时抛 `PluginDataError` |
| 生命周期 | 数据保存在浏览器本地,随站点数据清除而丢失,不得当作可靠存储 |
| 键名 | 非空字符串,长度不超过 64 |

## 可见数据范围

| 数据 | 可见字段 |
|:---:|:---:|
| 会话摘要 | `id`、`title`、`createdAt`、`updatedAt` |
| 会话内容 | 消息的 `id`、`role`、`createdAt`、文本、附件名称与大小、是否为图片 |
| 事件 | `session:changed` 与当前会话 `activeId` |
| 设置 | 当前语言 |
| 插件数据 | 该插件自己写入的键值,读写都以插件 id 隔离 |

不可见：API Key、附件本地 id 与服务端 file_id、附件原件、请求快照、分支内部结构、其他插件的本地数据、请求 Cookie。

## 产物签名

作者可以对产物签名,作者签名与合集签名相互独立,约定见 [信任链与 PKI 签名](trust-chain.md):

```
openssl genpkey -algorithm ed25519 -out author_secret.pem
openssl pkey -in author_secret.pem -pubout -out author_secret.pub
openssl pkeyutl -sign -rawin -inkey author_secret.pem -in plugin.js -out plugin.js.author.sig
openssl pkeyutl -sign -rawin -inkey author_secret.pem -in meta.json -out meta.json.author.sig
```

| 产物文件 | 说明 |
|:---:|:---:|
| `plugin.js.author.sig` | 作者对 `plugin.js` 原始字节的 Ed25519 裸签名 |
| `meta.json.author.sig` | 作者对 `meta.json` 原始字节的 Ed25519 裸签名,随合集分发时使用 |
| `author_pub.pem` | 作者公钥,交给合集放到 `plugins/<作者>/author_pub.pem` |

作者签名是逐字节语义,签名后不得再改动被签名文件。合集签名 `plugin.js.sig` 与 `meta.json.sig` 由合集用 EEC 证书签发,作者不需要处理。安装与启动时签名校验失败只提示,不阻断;未提供签名时按未校验处理。

## 错误处理

- 未申请的能力被调用时抛 `PluginCapabilityError`,引擎同时提示宿主文案。
- 超出限流抛 `PluginRateLimitError`,插件应降低调用频率或改为事件驱动。
- `activate` 抛错会让插件进入 `failed`,不会中断引擎与其他插件;重新激活前应先修复。
- 事件处理器内的错误只写入该插件日志,可用 `engine.logs(id)` 读取。

最后,产物要符合 [dsc插件产物规范](./plugin-product-spec.md)。
