<div align="center">

# DeepSeek-Chat-Enhanced

[简体中文] |
[English](README.en-US.md)

</div>

> [!IMPORTANT]
> 本仓库是 DeepSeek 官方仓库 [Chat-Demo](https://github.com/deepseek-ai/chat-demo/) 的增强分支,由社区维护,与DeepSeek官方无直接关联。

DeepSeek 官方开源的仓库 [Chat-Demo](https://github.com/deepseek-ai/chat-demo/) 是一个基于 DeepSeek API 的静态聊天示例。无需应用后端,浏览器直接请求配置的 API 服务。

这是一个基于 [deepseek-ai/Chat-Demo](https://github.com/deepseek-ai/chat-demo/) 的分支版本,整合了 dsh 的部分增强功能,使您的聊天体验更加友好。

本分支对源仓库做了以下 **功能增强** ：

1. 效仿 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的理念 “Everything is a Plugin.”,引入了插件体系,制定了统一的插件规范。
2. 内置了以下基础插件：

| 插件名称 | 介绍 |
|:---:|:---:|
| `dsc-core` | dsc核心,运行Chat-Demo的基本服务 |
| `dsc-plugin-engine` | dsc插件引擎,实现插件体系的中间层  |
| `dsc-market` | dsc插件市场,读取外源插件索引,为插件面板的「插件市场」提供列表与查询 |
| 其他同源插件 | 详见 [dsc-inner-plugin](https://omdsc-dev.github.io/dsc-inner-plugin/) |

其中 `dsc-market` 由插件引擎装载,可在插件面板的「已安装」中看到;`dsc-core` 与 `dsc-plugin-engine` 是宿主侧的基础模块,不进入插件列表。

<!-- 任何一个dsc插件都必须以 `dsc-` 开头 -->

我们沿用了 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的部分设计理念和仓库规范,但针对 Chat 场景我们做了一些 **必要的改变**,详见 [DSC与DSH差异文档](docs/intro/dsc-diff-dsh.md)


## 在线体验

点击 [在线体验](https://omdsc-dev.github.io/chat/) 即可使用,也可以前往 [Releases](https://github.com/omdsc-dev/DeepSeek-Chat-Enhanced/releases) 下载压缩包,解压后双击 `index.html` 在本地使用,无需安装或构建。

注意,我们只提供 **静态网页(无Agent能力)** 和部分必要插件(上述同源插件)的制作、展示与分发,**不提供任何** 付费服务、后端服务。另外,我们还会收录一些由社区开发者制作的外源插件,该部分插件的引入由用户 **自行判断并承担** 安全风险,请确保只引入你 **信任安全** 的插件。

> [!WARNING]
> 温馨提示：使用 DeepSeek-Chat-Enhanced 及其在线网页一样需要依赖模型 API 服务并产生资费,但这些费用本身并不会进入 omdsc-dev 的钱包。<br>
> 除非您订阅了 Token Plan 、有免费额度的渠道或者预算充足,否则不要轻易使用 DeepSeek-Chat-Enhanced,以防止产生预期外的资费。

> [!CAUTION]
> 请保护好你的 API Key,因为它直接保存并暴露在浏览器储存中。<br>
> 不要轻易启用未知来源的、不受用户本人信任的任何插件,以防止你的 API Key 、会话内容发生泄露造成不必要的损失。<br>
> 由 [omdsc-dev/dsc-inner-plugin](https://omdsc-dev.github.io/dsc-inner-plugin/) 提供的插件不会试图泄露你的凭证和数据。<br>
> 由 [OMDSC-Market](https://omdsc-market.com/) 提供的插件可能存在审查遗漏,使用前请先查证其来源和安全性。<br>
> 如遇恶意插件,你可以 [提交Issue](https://github.com/omdsc-dev/awesome-dsc-plugin/issues/new) 或 [联系 OMDSC-Market](mailto:JularDepick@gmail.com?subject=恶意插件举报) 甚至 [直接联系 omdsc-dev](mailto:JularDepick@gmail.com?subject=恶意插件举报) 进行举报、要求移除。但我们无法挽回你的损失,请及时移除恶意插件并更新您的 API Key 。

<!-- 链接事项: OMDSC-Market 需要预设恶意插件紧急下线流程、恶意插件广播公告 -->


## 插件面板

插件面板是应用内管理插件的入口。点击侧边栏底部的「插件」按钮即可打开;侧边栏收起后,入口位于左上角按钮组的插件图标处。

| 标签页 | 作用 |
|:---:|:---:|
| 已安装 | 列出插件的名称、版本、状态与来源,可启用、停用、卸载,并查看插件日志 |
| 插件市场 | 读取插件索引并列出可安装的插件,可刷新索引并直接安装 |

面板底部提供「从地址安装」:输入插件产物的 `https` 地址即可安装,本机调试也可用 `http://localhost`、`http://127.0.0.1` 或 `http://[::1]` 地址;清单由产物自带的 `manifest` 导出提供。

安装记录与启用状态保存在浏览器本地,下次打开页面时自动恢复。

普通用户的操作说明见 [插件使用指南](docs/user/guide/plugins.md) 。


## 插件市场

插件市场在线查看列表请访问 [OMDSC-Market](https://omdsc-market.com/zh-CN/) 。

同源插件列表在线查看请访问 [dsc-inner-plugin](https://omdsc-dev.github.io/dsc-inner-plugin/) 。

插件收录申请详见 [omdsc-dev/awesome-dsc-plugin](https://github.com/omdsc-dev/awesome-dsc-plugin/) 。

插件市场收录的插件 **必须符合** [dsc插件开发规范](docs/user/develop/basic/plugin-develop-spec.md) 。

插件来源遵循 PKI 签名体系:

1. omdsc-dev 作为根证书机构签发终端签名证书(EEC),合集用 EEC 对收录的插件做 CMS 分离签名,产物是插件版本目录的 `plugin.js.sig` 与 `meta.json.sig` 。
2. 插件作者还可以用自己的私钥对同一插件自签名,产物是 `plugin.js.author.sig`,与合集签名并存。
3. 合集的 EEC 由根证书签发,根证书与各合集 EEC 通过 online-data 分支分发;合集可信性由证书链证明,不再单独签发合集信任签名。

市场先校验证书链,通过后才信任该来源的 EEC,再用它校验插件签名;网页产物同样用 EEC 的 CMS 签名自校验。校验不通过时市场会给出警告,但不会阻止安装,由你自行判断是否继续使用。证书链不支持下级派生: 合集 EEC 不能签发下级证书。

网页运行时的证书链校验已按上述约定实现,插件市场的合集信任仍在迁移。签发工具、重签时机、吊销与私钥边界见 [信任链与 PKI 签名](docs/user/develop/basic/trust-chain.md) 。


## 制作插件

每一个dsc插件在 **开发阶段** 都是一个独立的项目,你可以用 **任何编程语言** 编写插件的逻辑,只需要保证 **构建的运行时产物** 符合 [**dsc插件产物规范**](docs/user/develop/basic/plugin-product-spec.md) 即可保证插件的识别和运行。

为保证插件的规范性、可维护性,方便你的插件能被更多人使用和二次开发,我们更推荐你使用 omdsc-dev 提供的 [dsc插件模板](https://github.com/omdsc-dev/dsc-plugin-template) 进行插件开发。

每一个dsc插件在 **运行阶段** 都是一个符合 [dsc插件产物规范](docs/user/develop/basic/plugin-product-spec.md) 的 `js脚本` 。

插件产物可以导出具名 `manifest`,用户从地址安装时就不需要再提供清单:

```js
export const manifest = {
  id: 'dsc-demo-log',
  name: 'Demo Log',
  version: '1.0.0',
  capabilities: ['events:session', 'plugins:storage'],
  contributions: ['session:changed'],
}

export const activate = (context) => {
  context.log('demo log activated')
}
```

清单也可以挂在 `default` 导出对象上,模块顶层的具名导出优先;`installFromUrl(url, manifest)` 显式传入清单时以传入的为准。产物未导出清单且安装时也没有提供清单,安装会被拒绝。

dsc插件由 `dsc-plugin-engine` 负责引入,并通过交互 `dsc-plugin-engine` 提供的标准接口来有限地控制整个Chat及其页面。绕过 `dsc-plugin-engine` 直接交互 `dsc-core` 是不合适的,该行为会被 `dsc-plugin-engine` 识别并报出警报给用户。

详见 [build-a-plugin.md](docs/user/develop/framework/build-a-plugin.md) 。


## 版权与许可

Copyright &copy; 2026 omdsc-dev

版权信息详见 [COPYRIGHT](COPYRIGHT) 。

本分支在源仓库上所做的新增、修改、合并,均按 [Apache-2.0](LICENSE) 许可证授权,随产物一同分发。

源仓库的内容沿用 [MIT](LICENSE.deepseek) 许可证,随产物一同分发。第三方依赖和插件遵循各自的许可证。


## 安全政策

详见 [安全政策文档](SECURITY.md) 。

网页产物对每个代码文件单独签名,页面运行时静默校验,校验不通过只提示一条警告,详见 [网页签名与运行时校验](docs/user/develop/basic/web-signature.md) 。


## 贡献指南

详见 [CONTRIBUTING.md](CONTRIBUTING.md) 。