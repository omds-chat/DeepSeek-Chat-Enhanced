# 从零编写一个 dsc 插件

本文从一个空文件开始,写出一份能被 dsc 识别、安装并运行的插件,并说明如何验证、打包与分发。

## 插件是什么

dsc 插件在运行阶段就是一个符合 [dsc 插件产物规范](../basic/plugin-product-spec.md) 的 `js` 文件:它以 ESM 形式被 `dsc-plugin-engine` 加载,导出一个插件对象,在激活时拿到引擎提供的 `context`。

插件与宿主之间只有一条通道:`context` 上的受限能力对象。插件拿不到 `dsc-core` 的内部接口、`zustand` store 句柄与 IndexedDB 句柄,也拿不到任何 DOM 或插槽接口。绕过 `context` 直接操作宿主不受支持,引擎会识别这类行为并提示用户。

插件的运行状态有四种:

| 状态 | 含义 |
|:---:|:---:|
| `registered` | 已登记,尚未启动 |
| `active` | 已激活,能力可用 |
| `inactive` | 已停用,能力与贡献点已撤销 |
| `failed` | 启动失败,原因记录在插件日志与列表的错误字段 |

## 运行环境

| 项 | 说明 |
|:---:|:---:|
| 运行位置 | 浏览器页面主线程 |
| 可用 API | 浏览器 API,例如 `localStorage`、`setTimeout`;联网不在其中,须走宿主提供的网络能力 |
| 不可用 | Node 内置模块、后端接口、本地文件系统、自行联网 |
| 依赖 | 不得新增运行依赖 |
| 宿主版本 | dsc-core `1.0.0`,对应清单的 `engines` 字段,写成单段版本范围 |

产物按普通 ESM 在页面内 `import`,因此必须是浏览器能直接解析的模块代码,不能包含 `require` 或打包器专用的运行时占位。

### 联网

联网受宿主管控,插件只能经宿主提供的网络能力发起请求:内置插件用 `context.net.getText` 与 `context.net.postJson`,协议、方法、响应类型、体积与超时都由宿主落实。

第三方插件当前拿不到这项能力:清单里申请 `net:fetch` 会被拒绝,与申请一个不存在的能力表现一致。需要联网的第三方插件应向宿主说明用途,由宿主决定是否开放。

这条口径是契约约束,不是技术隔离:插件产物与宿主同源运行在同一个页面里,引擎无法在技术上阻止同源代码直接调用浏览器全局的 `fetch`。直接调用属于不合规,不能作为插件可以自行联网的依据。

## 最小可运行示例

### 源码

下面的代码申请两项能力:`events:session` 用于订阅会话切换事件,`plugins:storage` 用于保存自己的计数。

```ts
import type { PluginContext, PluginManifest } from './components/dsc-plugin-engine/index.js'

// 插件清单,从地址安装时以它为准
export const manifest: PluginManifest = {
  id: 'dsc-demo-log',
  name: 'Demo Log',
  version: '1.0.0',
  engines: '^1.0.0',
  capabilities: ['events:session', 'plugins:storage'],
  contributions: ['session:changed'],
}

// 启动入口,引擎在激活时调用,超时 5 秒
export const activate = (context: PluginContext) => {
  const stored = context.storage.get('switch-count')
  let count = typeof stored === 'number' ? stored : 0
  context.events.on('session:changed', (event) => {
    count += 1
    context.storage.set('switch-count', count)
    context.log('session:changed -> ' + String(event.activeId ?? 'none') + ' (' + count + ')')
  })
}

// 停用入口,可选;引擎在停用后仍会执行 events.on 返回的释放函数
export const deactivate = () => {}
```

`import type` 只是为了让编辑器拿到类型提示,编译后不会留在产物里。该路径指向本仓库的类型定义;独立插件项目可以复制这份类型声明,或使用 omds-chat 提供的 dsc 插件模板。

### 产物

插件最终交付的是去掉类型标注的 ESM 文件,内容与上面的源码等价:

```js
export const manifest = {
  id: 'dsc-demo-log',
  name: 'Demo Log',
  version: '1.0.0',
  engines: '^1.0.0',
  capabilities: ['events:session', 'plugins:storage'],
  contributions: ['session:changed'],
}

export const activate = (context) => {
  const stored = context.storage.get('switch-count')
  let count = typeof stored === 'number' ? stored : 0
  context.events.on('session:changed', (event) => {
    count += 1
    context.storage.set('switch-count', count)
    context.log('session:changed -> ' + String(event.activeId ?? 'none') + ' (' + count + ')')
  })
}
```

### 逐段说明

| 部分 | 作用 |
|:---:|:---:|
| `export const manifest` | 安装依据。用户从地址安装时不必再提供清单;写在 `default` 导出对象上也能识别,模块顶层的具名导出优先 |
| `capabilities` | 申请的能力,必须在核心能力表内且不得重复。未申请的能力被调用时抛 `PluginCapabilityError` |
| `contributions` | 声明订阅的贡献点。只有声明了 `session:changed` 才能调用 `context.events.on('session:changed', ...)` |
| `activate(context)` | 启动入口,可返回 Promise;抛错或超过 5 秒会让插件进入 `failed`,引擎与其他插件继续运行 |
| `deactivate()` | 停用入口,可选,可返回 Promise,超时 3 秒;之后引擎执行 `events.on` 返回的释放函数并清空贡献点 |

插件 id 的仓库约定是以 `dsc-` 开头。引擎的格式校验为小写字母开头、允许数字与连字符、长度 3 到 64。

### 能力清单

| 能力 | 可见范围 | `context` 成员 | 限流 |
|:---:|:---:|:---:|:---:|
| 无 | 全部插件 | `context.id` | — |
| 无 | 全部插件 | `context.version` | — |
| `sessions:list` | 全部插件 | `context.sessions.list` | 30 次 / 10 秒 |
| `sessions:read` | 全部插件 | `context.sessions.read` | 30 次 / 10 秒 |
| `sessions:rename` | 全部插件 | `context.sessions.rename` | 5 次 / 10 秒 |
| `events:session` | 全部插件 | `context.events.on` | 5 次 / 10 秒 |
| `notify` | 全部插件 | `context.ui.notify` | 10 次 / 10 秒 |
| `settings:locale` | 全部插件 | `context.settings.locale` | 60 次 / 10 秒 |
| `plugins:storage` | 全部插件 | `context.storage.get`、`set`、`remove` | 100 次 / 10 秒 |
| `net:fetch` | 仅内置插件 | `context.net.getText`、`context.net.postJson` | 10 次 / 10 秒 |

`context.id` 与 `context.version` 是引擎注入的两个只读成员,分别取自清单的 `id` 与 `version`,不需要申请能力,也不占用限流名额。

上表的限流只约束调用次数。单次超时只对异步成员生效: `context.sessions.list`、`context.sessions.read`、`context.settings.locale` 各 3 秒,外源请求由内核自己的超时中止(读取 10 秒、计数请求 5 秒);`context.sessions.rename`、`context.ui.notify` 与 `context.storage.get`、`set`、`remove` 是同步调用,没有超时。

`net:fetch` 只对内置插件开放。第三方插件在清单里申请它时,安装结果为 `unknown-capability`,与申请一个不存在的能力表现一致;调用层还会再校验一次。第三方插件需要联网时由宿主决定是否开放,口径见上文「[联网](#联网)」。

`context.net.postJson` 只发一次 JSON 请求体,不等待响应内容:只允许 https,请求体与响应体上限各 4KB,超时 5 秒,不跟随重定向,响应体被丢弃。它面向不计结果的计数类请求,插件清单仍然只声明 `net:fetch`。

各能力的完整签名与可见数据范围见 [dsc 插件开发规范](../basic/plugin-develop-spec.md)。

## 本地加载验证

1. 准备产物:一个 js 文件,例如 `dsc-demo-log.js`。
2. 用本机静态服务器以 `http://localhost` 提供该文件,例如 `http://localhost:8090/dsc-demo-log.js`。地址规则:允许 `https://` 的任意主机,或 `http://localhost`、`http://127.0.0.1`、`http://[::1]`;其余协议与主机一律拒绝。
3. 打开插件面板,在「从地址安装」中粘贴产物地址,点击「安装」。
4. 安装成功后插件自动激活,「已安装」中出现该插件,状态为「运行中」。
5. 点击「查看日志」可看到 `context.log` 写入的内容;切换会话后再次查看,计数递增。

两点补充:

- 面板与 `installFromUrl(url, manifest?)` 共用同一地址判定,所以本地 `http://localhost` 地址可以直接从面板安装;分发给用户时仍应使用 `https` 地址。
- 产物改动后需要先在面板卸载再重新安装;取件带 `cache: 'no-store'`,若托管方对产物另设了长时间缓存,必要时更换文件名或地址。

## 发布成单个 js 产物

| 要求 | 说明 |
|:---:|:---:|
| 入口 | 一个 js 文件,浏览器可直接 `import` 的 ESM |
| 导出 | 保留 `export const manifest` 与 `export const activate` |
| 依赖 | 第三方依赖内联进产物,不新增运行依赖 |
| 资源 | 样式、字体、图片内联进产物;相对路径导入在安装后不会生效,运行时取资源属于联网,须走宿主网络能力(见「[联网](#联网)」) |
| 格式 | 不使用 `require`、Node 内置模块与打包器专用运行时 |

打包时注意:

- 把入口配置为 ESM 库,保留 `manifest` 与 `activate` 两个导出,不要产出仅供应用使用的 HTML 入口。
- 产物必须单文件:安装后代码按文本存进浏览器本地,加载时用的是 Blob 地址,拆分出来的 chunk 与相对路径资源无法解析。
- 构建完成后在浏览器控制台直接 `import('https://example.com/dsc-demo-log.js')` 一次,确认没有语法错误与缺失依赖。

## 打包成离线包

用户也可以拿到一个文件直接本地安装,不必自己搭静态服务器。引擎接受两种离线包:

| 格式 | 目录布局 | 生成方式 |
|:---:|:---:|:---:|
| zip | 根目录直接放 `meta.json` 与 `plugin.js`,可选作者签名 `plugin.js.author.sig` 与 `author_pub.pem` | 进入 `dist/` 后打包:`zip -r ../dsc-demo-log-1.0.0.zip .` |
| npm 包(`.tgz`) | 产物在 `package/dist/` 下 | 在插件项目根目录执行 `pnpm pack` |

zip 的要点:

- 压缩包根目录就是 `dist/` 的内容,不能再套一层目录;根目录下多一层 `dist/` 会导致安装时提示缺少 `meta.json`。
- 只识别 `meta.json`、`plugin.js` 与作者签名材料 `plugin.js.author.sig`、`author_pub.pem`,其余文件会被忽略,不影响安装。
- 用命令行打包,避免系统压缩工具写入额外的元数据目录。
- Windows 上不要直接用 `Compress-Archive` 压缩 `dist` 目录,它会把目录名套进包内;进入 `dist` 后执行 `tar -a -c -f ..\plugin.zip *`,或用资源管理器选中目录内的文件再压缩。

npm 包的要点:

- 用 `pnpm pack` 或 `npm pack` 生成,包内路径固定为 `package/dist/...`。
- `package.json` 的 `files` 需要包含 `dist`,否则产物不会进包。
- `package/` 下的其他内容被忽略,只安装 `package/dist/` 下的文件。

`meta.json` 是安装依据:预检先确认包内有 `meta.json` 与 `plugin.js`,再确认 `plugin.js` 不超过 2 MB,然后把 `meta.json` 按 UTF-8 解码并解析。`meta.json` 不是合法 UTF-8 时按 `invalid-meta` 拒绝;解码成功后要求 `name`、`version`、`author` 非空且版本号为三段数字。清单里的 `capabilities` 用来推导安装清单,缺该字段时改用产物导出的 `manifest`,两者都没有时安装失败。`dependencies.dsc` 会被当作清单的 `engines` 使用,必须写成单段版本范围,例如 `^1.0.0`;写成 `>=1.0.0 <2.0.0` 这类组合范围时预检同样按 `invalid-meta` 拒绝,原因说明指向 `dependencies.dsc`。

带作者签名的离线包:

1. 生成作者密钥对:`openssl genpkey -algorithm ed25519 -out author_secret.pem`,再用 `openssl pkey -in author_secret.pem -pubout -out author_pub.pem` 导出公钥。
2. 对 `plugin.js` 的字节做裸公钥分离签名:`openssl pkeyutl -sign -rawin -inkey author_secret.pem -in plugin.js -out plugin.js.author.sig` 。
3. 把 `plugin.js.author.sig` 与 `author_pub.pem` 一起放进包内,与 `meta.json`、`plugin.js` 同级。

只带其中一个文件时,引擎按未提供签名处理,并在确认对话框里提示未校验。合集侧的 CMS 签名与整站签名由合集用自己持有的 EEC 私钥完成,它覆盖 `plugin.js` 与目录数据,但不代替作者签名:作者签名由作者用自己持有的私钥签,合集只做收录与整站签名。`meta.json` 的完整性由合集的三层清单或整站清单覆盖,不需要作者签名。两套签名的约定见 [信任链与 PKI 签名](../basic/trust-chain.md) 。

## 让用户安装

| 方式 | 入口 | 清单来源 |
|:---:|:---:|:---:|
| 从地址安装 | 插件面板底部的「从地址安装」 | 产物自带的 `manifest` 导出 |
| 从本地安装 | 插件面板底部的「从本地安装」 | `meta.json` 的 `capabilities`,缺该字段时用产物自带的 `manifest` |
| 插件市场 | 插件面板的「插件市场」标签页 | 索引条目内联的清单优先,否则用产物自带的 `manifest` |
| 宿主注册 | 宿主代码调用 `engine.install(manifest, plugin)` | 调用方传入 |

- 通过地址安装成功后插件自动激活;安装记录写入浏览器本地,下次打开页面时自动恢复。
- 从本地安装的插件把代码文本一并存进安装记录,下次打开页面时用保存的代码恢复,不再读取离线包;离线包只需保留用于重装。
- 启动恢复只用安装时保存的代码,不再访问产物地址;单个插件恢复失败只把它标记为 `failed`,不影响其他插件与页面渲染。
- 市场索引的结构与收录要求由插件市场侧维护,产物仍须导出 `manifest`,或由索引条目内联清单。
- 卸载不会清除该插件的本地数据,`context.storage` 写入的内容在卸载后仍然保留;需要清理时由用户在设置的数据管理中执行。
- 安装时引擎用 `fetch` 取产物字节,托管方必须允许跨源取件:与页面同源时不需要额外配置;跨源时响应必须带 `Access-Control-Allow-Origin`,否则安装失败。
- 常见静态托管的默认行为:GitHub Pages 对资源返回 `Access-Control-Allow-Origin: *`,一般可以直接跨源加载;对象存储与多数 CDN 通常默认不返回该头,需要在存储桶或 CDN 侧配置 CORS 规则;不确定时用 `curl -I <产物地址>` 查看响应头里有没有 `Access-Control-Allow-Origin`。

## 常见错误与排查

安装阶段的拒绝原因:

| 原因 | 常见成因 | 处理 |
|:---:|:---:|:---:|
| `invalid-manifest` | `id`、`name`、`version` 不符合规则,或产物未导出清单且调用时未传入清单 | 修正清单字段;确保产物导出 `manifest` |
| `unknown-capability` | 申请了能力表之外的能力,或第三方插件申请 `net:fetch` | 只申请能力清单内的能力 |
| `unknown-contribution` | `contributions` 不在贡献点表内 | 只使用 `session:changed` |
| `incompatible-version` | `engines` 与宿主 `1.0.0` 不匹配,或写成了 `>=1.0.0 <2.0.0` 这类组合范围 | 把 `engines` 改成单段表达式 |
| `duplicate` | 同 id 插件已存在 | 先卸载旧插件再安装 |
| `missing-dependency` | `dependencies` 中的插件未安装 | 先安装依赖 |
| `conflict` | `conflicts` 中的插件已安装 | 先卸载冲突插件 |
| `artifact-unreachable` | 产物字节取不到:网络失败,或跨源托管缺少 `Access-Control-Allow-Origin` | 检查地址、网络与托管侧的 CORS 配置 |
| `load-failed` | 地址协议不支持、产物不是可存的 UTF-8 文本,或导入超过 10 秒 | 检查地址与产物格式 |
| `invalid-plugin` | 产物没有导出 `activate`,或导出形态不被识别 | 检查导出形态 |
| `missing-meta` / `missing-plugin` | 离线包根目录不是 `dist/` 的内容,或 npm 包里没有 `dist/` | 按打包要求重新生成离线包 |
| `invalid-meta` | `meta.json` 不是合法 UTF-8,缺少 `name`、`version`、`author`,版本号不是三段数字,或 `dependencies.dsc` 不是单段版本范围 | 修正 `meta.json`,版本范围写成单段表达式 |
| `corrupt-package` | 压缩包损坏,或 `plugin.js` 不是 UTF-8 文本 | 重新打包 |
| `package-too-large` | `plugin.js` 超过 2 MB | 精简产物(行压缩、去掉内联资源)后重新打包 |

签名校验不通过不属于安装拒绝:引擎仍会安装,只把该插件标记为校验失败并提示用户自行判断,重新签名后重新打包即可消除提示。

运行阶段的现象:

| 现象 | 成因 | 处理 |
|:---:|:---:|:---:|
| 状态显示「启动失败」 | `activate` 抛错或超过 5 秒 | 打开插件日志定位抛错位置 |
| 抛 `PluginCapabilityError` | 调用了未在清单申请的能力 | 在 `capabilities` 中补上 |
| 抛 `PluginRateLimitError` | 超出能力限流 | 降低调用频率或改为事件驱动 |
| 抛 `PluginTimeoutError` | 单次异步调用超过 3 秒 | 缩短单次调用耗时 |
| 抛 `PluginAbortError` | 传入的 `signal` 已取消 | 检查取消逻辑 |
| 抛 `PluginDataError` | 数据超过 64KB,或值无法 JSON 序列化 | 精简数据;移除函数、`undefined` 与循环引用 |
| 卸载被拒绝 | 有已启用的插件依赖它 | 先停用依赖方再卸载 |

## 延伸阅读

- [dsc 插件开发规范](../basic/plugin-develop-spec.md)
- [dsc 插件产物规范](../basic/plugin-product-spec.md)
- [开发文档索引](../index.md)
