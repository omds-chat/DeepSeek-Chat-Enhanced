# DSC 与 DSH 的设计异同

- DSH means: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- DSC means: [DeepSeek Chat (Enhanced)](https://github.com/omdsc-dev/DeepSeek-Chat-Enhanced)


## 设计理念

| 事项 | DSH | DSC |
|:--:|:--:|:--:|
| 设计理念 | **Everything is** a Plugin | **Something can be** a Plugin **(更克制)** |

> 为什么要克制？
> DSC 完全是一个静态网页，它运行在浏览器中。受限于环境和设计理念本身，它就不适宜把 computer-use 等 Agent 能力完全以插件的形式实现出来。


## 产品服务

| 事项 | DSH | DSC |
|:--:|:--:|:--:|
| 服务场景 | **本地** Agent 控制 | **在线** AI 对话 |
| 服务对象 | **开发者** 群体为主 | **普通用户** 群体为主 |
| 服务提供者 | [DeepSeek 官方](https://github.com/deepseek-ai/) + 社区共建 | [omdsc-dev 社区](https://github.com/omdsc-dev/) + 社区共建 |


## 服务边界

| 事项 | DSH | DSC |
|:--:|:--:|:--:|
| 插件安全审查 | 冲突校验 + 社区支持 | **原生支持** |
| 插件市场 | 不内置 | **内置** |
| 插件收录 | 不提供 | **提供** |
| 插件托管 | 依靠npm与社区生态 | 依靠npm与社区生态 + 收录即托管 |

<details><summary>为什么要内置插件市场？</summary>

> DSH开发早期，社区就一度困扰于插件查找与安装的不便利性、插件统一安装和更新渠道的缺失。我们充分吸取DSH开发早期的经验教训、参考社区后续涌现的 dshmarket 、 awesome-dsh-plugin 等优秀插件及其合集，推出了DSC内置的插件市场
> 更考虑到浏览器本身的安全储存能力，我们不放心把用户的凭证暴露给不受信任的脚本。

</details>

<details><summary>我们到底在做什么？</summary>

> 实际上，omdsc-dev 一直致力于降低 DeepSeek 系列 AI 产品的使用门槛，为 **普通用户** 提供更温和、更易用的二次开发产品，将 AI 前沿科技产品普惠给广大普通用户。
> 往小的说，我们敬仰并拥戴 DeepSeek 及其系列产品，并且不忍心见其因 [11·16 DeepSeek免费用户对话服务限额事件](https://baike.baidu.com/item/11%C2%B716%20DeepSeek%E5%85%8D%E8%B4%B9%E7%94%A8%E6%88%B7%E5%AF%B9%E8%AF%9D%E6%9C%8D%E5%8A%A1%E9%99%90%E9%A2%9D%E4%BA%8B%E4%BB%B6) 及过往的各种策略变动而遭受广大普通用户的贬低和抨击；实际上，我们也希望开发者用户能用上更好的Chat产品以辅助开发。
> 往大的说，omdsc-dev 正积极参与推进 “AI普惠全人类” 的 **最后一公里** 。

</details>


## 技术架构

| 事项 | DSH | DSC |
|:--:|:--:|:--:|
| 前后端 | 完全耦合 | 纯前端 |
| 本体开发 | Node.js | Node.js + React |
| 本体运行 | Node.js | **仅浏览器** |
| 插件开发 | Node.js | Node.js + 自研规范 |
| 插件运行 | Node.js | **仅浏览器** |

> [!NOTE]
> 本质上，DSC和DSH是两个完全不同的东西，将它们放在一起比较并不具有现实意义。
> 本文档将二者进行对比，是为了让读者能更清晰地理解DSC的属性：它有什么用、面向谁、和DSH是什么关系、在哪些方面继承了DSH、在哪些方面没有走DSH的老路。