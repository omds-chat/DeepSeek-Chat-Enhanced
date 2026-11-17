<div align="center">

# DeepSeek-Chat-Enhanced

[简体中文](README.md) |
[English]

</div>

> [!IMPORTANT]
> This repository is an enhanced fork of DeepSeek's official [Chat-Demo](https://github.com/deepseek-ai/chat-demo/), maintained by the community and not directly affiliated with DeepSeek.

DeepSeek's officially open-sourced repository [Chat-Demo](https://github.com/deepseek-ai/chat-demo/) is a static chat demo powered by the DeepSeek API. No application backend is required: the browser connects directly to the configured API service.

This is a fork of [deepseek-ai/Chat-Demo](https://github.com/deepseek-ai/chat-demo/) that integrates some enhanced features from dsh, making your chat experience friendlier.

This branch adds the following **feature enhancements** to the source repository:

1. Following the philosophy of [DeepSeekRuntime](https://github.com/deepseek-ai/deepseek-harness), "Everything is a Plugin.", it introduces a plugin system and defines a unified plugin specification.
2. The following base plugins are built in:

| Plugin | Description |
|:---:|:---:|
| `dsc-core` | dsc core, runs the basic services of Chat-Demo |
| `dsc-plugin-engine` | dsc plugin engine, the middle layer that implements the plugin system |
| `dsc-market` | dsc plugin market, reads and displays external plugin collections |
| Other same-origin plugins | See [dsc-inner-plugin](https://omdsc-dev.github.io/dsc-inner-plugin/) |

<!-- Every dsc plugin must start with `dsc-` -->

Limited by traditional front-end technology, we cannot guarantee that everything can be made into a plugin, so we cautiously follow and propose "Something can be a Plugin".

We follow some of the design philosophy and repository conventions of [DeepSeekRuntime](https://github.com/deepseek-ai/deepseek-harness), but made some **necessary changes** for the chat scenario. See the [DSC vs DSH differences](docs/intro/dsc-diff-dsh.md).

Note that we only provide the creation, display, and distribution of **static web pages (no agent capabilities)**. We **do not provide** any external plugins, paid services, or backend services. Introducing external plugins is at your **own risk**; make sure you only introduce plugins you **trust**.

You can [try the app online](https://omdsc-dev.github.io/chat/) or download the archive from [Releases](https://github.com/omdsc-dev/DeepSeek-Chat-Enhanced/releases), extract it, and double-click `index.html` to use it locally without installation or a build.

> [!WARNING]
> Using DeepSeek-Chat-Enhanced and its online page still depends on a model API service and incurs charges, but these fees do not go into omdsc-dev's wallet.
> Unless you subscribe to a Token Plan, use a channel with free quota, or have sufficient balance, do not use DeepSeek-Chat-Enhanced casually, to avoid extra charges.

> [!CAUTION]
> Protect your API key, because it is stored and exposed directly in browser storage.
> Do not enable any plugin of unknown or untrusted origin, to prevent your API key and conversation content from leaking.
> Plugins provided by [omdsc-dev/dsc-inner-plugin](https://omdsc-dev.github.io/dsc-inner-plugin/) will not attempt to leak your credentials or data.
> Plugins provided by [OMDSC-Market](https://omdsc-market.com/) may have review omissions; verify their origin and safety before use. If you encounter a malicious plugin, you can [submit an issue](https://github.com/omdsc-dev/awesome-dsc-plugin/issues/new), [contact OMDSC-Market](mailto:JularDepick@gmail.com?subject=Malicious%20plugin%20report), or even [contact omdsc-dev directly](mailto:JularDepick@gmail.com?subject=Malicious%20plugin%20report) to report it and request removal. But we cannot recover your losses; remove the malicious plugin promptly and update your API key.

<!-- Link note: OMDSC-Market needs a preset emergency takedown process and broadcast announcement for malicious plugins -->


## Plugin market

To view the plugin list online, visit [OMDSC-Market](https://omdsc-market.com/en-US/).

To view the same-origin plugin list online, visit [dsc-inner-plugin](https://omdsc-dev.github.io/dsc-inner-plugin/).

For plugin submission, see [omdsc-dev/awesome-dsc-plugin](https://github.com/omdsc-dev/awesome-dsc-plugin/).

Plugins listed in the market **must comply with** the [dsc plugin development specification](docs/user/develop/basic/plugin-develop-spec.md).

## Building plugins

Every dsc plugin is an independent project during **development**. You can write the plugin logic in **any language**, as long as the **built runtime artifact** conforms to the [**dsc plugin artifact specification**](docs/user/develop/basic/plugin-product-spec.md) so the plugin is recognized and runs.

To keep plugins standardized and maintainable, and to make your plugin easier for others to use and extend, we recommend developing plugins with the [dsc plugin template](https://github.com/omdsc-dev/dsc-plugin-template) provided by omdsc-dev.

Every dsc plugin is a `js script` conforming to the [dsc plugin artifact specification](docs/user/develop/basic/plugin-product-spec.md) at runtime, but it must ultimately be built into a standard plugin body that follows the interface specification.

A dsc plugin is loaded by `dsc-plugin-engine` and controls the whole Chat and its pages in a limited way through the standard interfaces provided by `dsc-plugin-engine`.

See [build-a-plugin.md](docs/user/develop/framework/build-a-plugin.md).


## Copyright and license

Copyright &copy; 2026 omdsc-dev

See [COPYRIGHT](COPYRIGHT) for details.

New additions, modifications, and merges made on top of the source repository in this branch are licensed under [Apache-2.0](LICENSE) and distributed with the artifact.

Content from the source repository remains under the [MIT](LICENSE.deepseek) license and is distributed with the artifact. Third-party dependencies follow their respective licenses.


## Security policy

None for now.
