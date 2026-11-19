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

Only `dsc-market` is loaded by the plugin engine and appears under Installed in the plugin panel; `dsc-core` and `dsc-plugin-engine` are host-side base modules and are not listed as plugins.

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
> Plugins listed by [awesome-dsc-plugin](https://omdsc-dev.github.io/awesome-dsc-plugin/) may have review omissions; verify their origin and safety before use.<br>
> If you encounter a malicious plugin, you can [submit an issue](https://github.com/omdsc-dev/awesome-dsc-plugin/issues/new), [contact awesome-dsc-plugin](mailto:JularDepick@gmail.com?subject=Malicious%20plugin%20report), or even [contact omdsc-dev directly](mailto:JularDepick@gmail.com?subject=Malicious%20plugin%20report) to report it and request removal. But we cannot recover your losses; remove the malicious plugin promptly and update your API key.


## Plugin panel

The plugin panel is where plugins are managed inside the app, and it takes over the main area: click the Plugins button at the bottom of the sidebar to switch to the plugin page, then click that button again, click any conversation, or click New chat to return to the chat; when the sidebar is collapsed, the entry is the plugin icon in the top-left button group.

| Tab | Purpose |
|:---:|:---:|
| Installed | Lists each plugin's name, version, state, and source, and provides enable, disable, uninstall, and log viewing |
| Plugin market | Reads the plugin index and lists installable plugins, and can refresh the index or install directly |

The bottom of the Installed tab provides two install entries: Install from URL takes the `https` address of a plugin artifact and reads the manifest from the `manifest` export bundled with the artifact; Install from file takes an offline package and shows its name, version, author, and signature state for confirmation before installing.

Install records and enable states are stored in browser storage and restored the next time the page loads. A plugin from an online source shows Update available when a newer version exists, and can be updated from the panel.

For end-user instructions, see the [plugin user guide](docs/user/guide/plugins.md).


## Plugin market

To view the plugin list online, visit [awesome-dsc-plugin](https://omdsc-dev.github.io/awesome-dsc-plugin/).

To view the same-origin plugin list online, visit [dsc-inner-plugin](https://omdsc-dev.github.io/dsc-inner-plugin/).

For plugin submission, see [omdsc-dev/awesome-dsc-plugin](https://github.com/omdsc-dev/awesome-dsc-plugin/).

Plugins listed in the market **must comply with** the [dsc plugin development specification](docs/user/develop/basic/plugin-develop-spec.md).

Plugin sources follow a certificate-based signature scheme: each source holds a signing certificate issued by the omdsc-dev root certificate, plugin artifacts and web artifacts carry that signature, and the browser verifies it when installing, when starting a plugin, and when the page loads. A plugin author may also sign the same plugin with their own private key, and that signature exists alongside the source signature.

A source's trustworthiness is proven by the certificate chain, and the plugin market, the plugin panel, and the web runtime all verify the same certificates, with no separate collection trust signature. When verification fails you only get a warning: the install or the page still works, so decide for yourself whether to continue.

See [trust chain and PKI signatures](docs/user/develop/basic/trust-chain.md) for the signing tools, revocation, and private key boundaries.


## Certificate and trust data

The `certs/` directory is the single source of public certificates and public keys:

```
certs/
├── dsce/            # material used by dsc itself: root certificate, page signing certificate, same-origin plugin collection certificate
├── plugin-set/      # plugin collection registry and the EEC of each collection
└── schemas/         # JSON Schemas and index notes for the above (see certs/schemas/README.md)
```

- Private keys are not in this directory: the root private key stays in the organisation's offline signing environment, and EEC private keys stay in each collection's CI secrets.
- Plugin author public keys belong to each plugin collection and are not placed here.
- Trust data for the page and for plugins is taken from `certs/` only: CI copies it verbatim into the `online-data` branch, and the published layout matches `certs/`.
- The build embeds `certs/dsce/root-ca/dsce-root-ca.crt` into the artifact; an offline run cannot fetch the online copy, so the embedded root certificate is what makes offline use possible.


## Building plugins

Every dsc plugin is an independent project during **development**. You can write the plugin logic in **any programming language**, as long as the **built runtime artifact** conforms to the [**dsc plugin artifact specification**](docs/user/develop/basic/plugin-product-spec.md) so the plugin is recognized and runs.

To keep plugins standardized and maintainable, and to make your plugin easier for others to use and build upon, we recommend developing plugins with the [dsc plugin template](https://github.com/omdsc-dev/dsc-plugin-template) provided by omdsc-dev.

Every dsc plugin is a `js script` conforming to the [dsc plugin artifact specification](docs/user/develop/basic/plugin-product-spec.md) during **runtime**.

A plugin artifact can export a named `manifest`, so users do not need to supply one when installing from a URL; see the [dsc plugin artifact specification](docs/user/develop/basic/plugin-product-spec.md) for the manifest fields and export forms, and [building a plugin from scratch](docs/user/develop/framework/build-a-plugin.md) for a minimal example.

A dsc plugin is loaded by `dsc-plugin-engine` and controls the whole Chat and its pages in a limited way through the standard interfaces provided by `dsc-plugin-engine`. Bypassing `dsc-plugin-engine` to interact with `dsc-core` directly is inappropriate; `dsc-plugin-engine` detects this behavior and raises an alert to the user.

See [build-a-plugin.md](docs/user/develop/framework/build-a-plugin.md).


## Copyright and license

Copyright &copy; 2026 omdsc-dev

See [COPYRIGHT](COPYRIGHT) for details.

New additions, modifications, and merges made on top of the source repository in this branch are licensed under [Apache-2.0](LICENSE) and distributed with the artifact.

Content from the source repository remains under the [MIT](LICENSE.deepseek) license and is distributed with the artifact. Third-party dependencies and plugins follow their respective licenses.


## Security policy

See the [security policy document](SECURITY.md).

Every code file of the web build is signed individually and verified silently at runtime; a failed check only shows a warning. See [web signature and runtime verification](docs/user/develop/basic/web-signature.md).


## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).