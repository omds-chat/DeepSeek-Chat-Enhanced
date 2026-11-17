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
| `dsc-market` | dsc plugin market, reads the external plugin index and feeds the plugin panel's Plugin market tab |
| Other same-origin plugins | See [dsc-inner-plugin](https://omdsc-dev.github.io/dsc-inner-plugin/) |

<!-- Every dsc plugin must start with `dsc-` -->

We follow some of the design philosophy and repository conventions of [DeepSeekRuntime](https://github.com/deepseek-ai/deepseek-harness), but made some **necessary changes** for the chat scenario. See the [DSC vs DSH differences](docs/intro/dsc-diff-dsh.md).


## Try it online

Click [try it online](https://omdsc-dev.github.io/chat/) to use it, or download the archive from [Releases](https://github.com/omdsc-dev/DeepSeek-Chat-Enhanced/releases), extract it, and double-click `index.html` to use it locally without installation or a build.

Note that we only provide the creation, display, and distribution of **static web pages (no agent capabilities)** and a few necessary plugins (the same-origin plugins above). We **do not provide any** paid services or backend services. In addition, we also list some external plugins made by community developers; introducing those plugins is at the user's **own judgment and risk**, so make sure you only introduce plugins you **trust**.

> [!WARNING]
> Note: Using DeepSeek-Chat-Enhanced and its online page still depends on a model API service and incurs charges, but these fees do not go into omdsc-dev's wallet.<br>
> Unless you subscribe to a Token Plan, use a channel with free quota, or have sufficient budget, do not use DeepSeek-Chat-Enhanced casually, to avoid unexpected charges.

> [!CAUTION]
> Protect your API key, because it is stored and exposed directly in browser storage.<br>
> Do not enable any plugin of unknown or untrusted origin, to prevent your API key and conversation content from leaking.<br>
> Plugins provided by [omdsc-dev/dsc-inner-plugin](https://omdsc-dev.github.io/dsc-inner-plugin/) will not attempt to leak your credentials or data.<br>
> Plugins provided by [OMDSC-Market](https://omdsc-market.com/) may have review omissions; verify their origin and safety before use.<br>
> If you encounter a malicious plugin, you can [submit an issue](https://github.com/omdsc-dev/awesome-dsc-plugin/issues/new), [contact OMDSC-Market](mailto:JularDepick@gmail.com?subject=Malicious%20plugin%20report), or even [contact omdsc-dev directly](mailto:JularDepick@gmail.com?subject=Malicious%20plugin%20report) to report it and request removal. But we cannot recover your losses; remove the malicious plugin promptly and update your API key.

<!-- Link note: OMDSC-Market needs a preset emergency takedown process and broadcast announcement for malicious plugins -->


## Plugin panel

The plugin panel is where plugins are managed inside the app. Open it with the Plugins button at the bottom of the sidebar; when the sidebar is collapsed, the entry is the plugin icon in the top-left button group.

| Tab | Purpose |
|:---:|:---:|
| Installed | Lists each plugin's name, version, state, and source, and provides enable, disable, uninstall, and log viewing |
| Plugin market | Reads the plugin index and lists installable plugins, and can refresh the index or install directly |

The bottom of the panel provides Install from URL: paste the `https` address of a plugin artifact to install it, and the manifest comes from the `manifest` export bundled with the artifact.

Install records and enable states are stored in browser storage and restored the next time the page loads.

For end-user instructions, see the [plugin user guide](docs/user/guide/plugins.md).


## Plugin market

To view the plugin list online, visit [OMDSC-Market](https://omdsc-market.com/en-US/).

To view the same-origin plugin list online, visit [dsc-inner-plugin](https://omdsc-dev.github.io/dsc-inner-plugin/).

For plugin submission, see [omdsc-dev/awesome-dsc-plugin](https://github.com/omdsc-dev/awesome-dsc-plugin/).

Plugins listed in the market **must comply with** the [dsc plugin development specification](docs/user/develop/basic/plugin-develop-spec.md).


## Building plugins

Every dsc plugin is an independent project during **development**. You can write the plugin logic in **any programming language**, as long as the **built runtime artifact** conforms to the [**dsc plugin artifact specification**](docs/user/develop/basic/plugin-product-spec.md) so the plugin is recognized and runs.

To keep plugins standardized and maintainable, and to make your plugin easier for others to use and build upon, we recommend developing plugins with the [dsc plugin template](https://github.com/omdsc-dev/dsc-plugin-template) provided by omdsc-dev.

Every dsc plugin is a `js script` conforming to the [dsc plugin artifact specification](docs/user/develop/basic/plugin-product-spec.md) during **runtime**.

A plugin artifact can export a named `manifest`, so users do not need to supply one when installing from a URL:

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

The manifest may also live on the `default` export, and a top-level named export wins. When `installFromUrl(url, manifest)` receives a manifest explicitly, that manifest is used. If the artifact exports no manifest and none is supplied, the install is rejected.

A dsc plugin is loaded by `dsc-plugin-engine` and controls the whole Chat and its pages in a limited way through the standard interfaces provided by `dsc-plugin-engine`. Bypassing `dsc-plugin-engine` to interact with `dsc-core` directly is inappropriate; `dsc-plugin-engine` detects this behavior and raises an alert to the user.

See [build-a-plugin.md](docs/user/develop/framework/build-a-plugin.md).


## Copyright and license

Copyright &copy; 2026 omdsc-dev

See [COPYRIGHT](COPYRIGHT) for details.

New additions, modifications, and merges made on top of the source repository in this branch are licensed under [Apache-2.0](LICENSE) and distributed with the artifact.

Content from the source repository remains under the [MIT](LICENSE.deepseek) license and is distributed with the artifact. Third-party dependencies and plugins follow their respective licenses.


## Security policy

See the [security policy document](SECURITY.md).


## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).