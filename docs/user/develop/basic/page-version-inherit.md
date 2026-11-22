# 页面版本继承

本文说明页面加载时如何比对当前实际加载的版本与上次使用的版本,以及两者不一致时的处理流程。内容与 `src/services/pageVersion.ts`、`src/components/base/VersionNotice.tsx`、`rspack.config.ts` 和 `.github/workflows/pages.yml` 的既有实现一致,未实现的能力不写入本文。

## 机制概览

| 环节 | 位置 | 说明 |
|:---:|:---:|:---:|
| 版本来源 | `rspack.config.ts` | 构建时把前端展示版本写入 `index.html` 的 meta 标签 `application-version`;展示版本取环境变量 `DS_CHAT_DISPLAY_VERSION`(CI 传入,不带 `dsc-` 前缀),未设置时回落 `package.json` 的版本号 |
| 历史版本留存 | `.github/workflows/pages.yml` | 部署包扁平化:正式发行把产物放到站点根,同时留存 `<tag>/` 与 `latest/` 快照;预发行只新增 `<tag>/` 快照,不进站点根 |
| 状态继承 | `src/services/pageVersion.ts` | 页面加载后执行一次,比对版本并决定提示或更新记录 |
| 提示界面 | `src/components/base/VersionNotice.tsx` | 应用内飘窗提示,提供刷新、打开旧版本与稍后处理三条路径 |

页面是纯静态产物,没有后端进程,所有状态都落在浏览器储存,版本继承也只在浏览器内完成。

## 流程

```
页面加载
├── 读取 meta application-version
│    └── 缺失或内容不是版本 tag → 结束,不提示
├── 存在刷新标记
│    └── 记录当前版本并清除标记 → 结束(刚点过「刷新到最新版」)
├── 读取 localStorage 的 page-version
│    ├── 没有记录 → 写入当前版本 → 结束(首次访问不提示)
│    └── 记录与当前一致 → 写入当前版本 → 结束(版本一致不提示)
├── 该组合已处理过
│    └── 结束(同一组合只提示一次)
└── 记录与当前不一致 → 显示飘窗提示
     ├── 刷新到最新版 → 打开站点根(带一次性查询串) → 加载后记录当时加载到的版本
     ├── 打开旧版本 → 打开 <站点根>/<记录版本>/ → 记录旧版本
     └── 稍后处理 → 只记录已处理过的组合,记录版本保持不变
```

提示是应用内飘窗,不用浏览器原生弹窗,也不影响页面其余部分的操作:没有遮罩、不锁焦点、不拦截飘窗以外的点击。

## localStorage 键名

| 键 | 值 | 说明 |
|:---:|:---:|:---:|
| `DeepSeek-Chat-Enhanced:page-version` | 版本 tag,形如 `dsc-1.0.0` | 上次使用的页面版本,首次访问时写入当前版本 |
| `DeepSeek-Chat-Enhanced:page-version-ack` | `<当前版本>\|<记录版本>` | 已处理过的版本组合,同一组合只提示一次 |

刷新标记不入 localStorage,而是放在会话储存 `DeepSeek-Chat-Enhanced:page-version-refreshing`,只在当前标签页的一次刷新内有效,加载后立即清除。

三条路径对记录的影响:

| 选择 | page-version | page-version-ack |
|:---:|:---:|:---:|
| 刷新到最新版 | 加载完成后写入当时加载到的版本 | 不变 |
| 打开旧版本 | 写入记录版本 | 写入本次组合 |
| 稍后处理 | 不变 | 写入本次组合 |

## 版本 tag 归一化

构建写入的 meta 内容始终带前缀,例如 `dsc-1.0.0`;储存里较早的记录可能是不带前缀的版本号,例如 `1.0.0`。读取后统一补成 tag 再比较,已是 tag 时原样使用。比较只判断字符串是否相等,既不解析版本号,也不判断新旧。

## 旧版本地址推导

站点可能部署在子路径下,地址一律从 `document.baseURI` 推导,不写死绝对路径。部署包已扁平化:历史版本快照直接位于 `<站点根>/<tag>/`,不再有 `version/` 这一层。推导规则:先取页面所在目录,该目录的末段与当前加载版本的 tag 一致时,说明当前页面就在本版快照目录里,去掉该目录得到站点根;当前页面在站点根时目录保持不变。旧版本地址为 `<站点根>/<记录版本>/`。

| 当前页面地址 | 推导出的站点根 | 记录版本的旧版本地址 |
|:---:|:---:|:---:|
| `https://host/DeepSeek-Chat-Enhanced/` | `https://host/DeepSeek-Chat-Enhanced/` | `https://host/DeepSeek-Chat-Enhanced/dsc-0.9.0/` |
| `https://host/DeepSeek-Chat-Enhanced/dsc-1.0.0/` | `https://host/DeepSeek-Chat-Enhanced/` | `https://host/DeepSeek-Chat-Enhanced/dsc-0.9.0/` |
| `https://host/dsc-1.0.0/` | `https://host/` | `https://host/dsc-0.9.0/` |
| `file:///D:/app/index.html` | `file:///D:/app/` | `file:///D:/app/dsc-0.9.0/` |

末段只匹配当前加载版本的 tag,只有本版快照目录会被剥掉:已经处在旧版本页面里再次选择「打开旧版本」时,不会出现 `dsc-1.0.0/dsc-0.9.0/` 这类重复拼接。「刷新到最新版」一律打开站点根,并附加一次性查询串绕开可能被缓存的 `index.html`。

## 预发行的展示语义

预发行 tag 形如 `dsc-1.0.0-alpha.1`,构建时 CI 剥掉 `dsc-` 前缀得到展示版本 `1.0.0-alpha.1` 注入 meta,界面上如实展示带 `XXX.序号` 后缀的预发行版本号;仓库版本号字段(`package.json` 等)不随预发行推进,锁定在目标正式版本。

预发行与正式发行在版本继承机制里是平等的两个页面版本:两者各自通过 meta 获得自己的版本 tag,各自按 `<站点根>/<tag>/` 留存快照,预发行与正式发行之间、预发行相互之间的继承比对都走同一条流程。

## 边界行为

| 情形 | 行为 |
|:---:|:---:|
| meta 缺失或内容不是合法 tag | 不提示,不写入任何记录 |
| 浏览器储存不可用 | 提示仍按内存状态工作,记录无法持久化,下次加载可能再次提示 |
| 同一标签页内重复调用继承 | 只执行一次 |
| 用户选择刷新后重新加载 | 记录已在加载时更新,不再提示同一组合 |
