# Maintaining Hibi

These guides describe Hibi's code, extension APIs, validation, and release process. They are for contributors and coding agents. For help using the app, start with the [Hibi guide](../../README.md).

## Development

- [Product direction](PRODUCT.md)
- [Architecture and security](development/architecture.md)
- [Development and validation](development/validation.md)
- [Performance measurement](development/performance.md)
- [formatted word count parity](development/word-count-parity.md)
- [Recorded startup measurements](development/startup-measurements.md)
- [Releases and publishing](development/releases.md)
- [Shared UI](development/design-system.md)
- [Document formats](development/document-formats.md)

## Addon development

- [Creating addons](development/addons.md)
- [Dialogs](development/dialogs.md)
- [Notifications](development/notifications.md)
- [Toolbar and tooltips](development/toolbar-and-tooltips.md)
- [Installing addon packages](extensions/sideloading.md)
- [Command discovery](extensions/command-discovery.md)
- [Workspace decorations](extensions/explorer-decorations.md)
- [Menus](extensions/menus.md)
- [Markdown flavors](extensions/flavors.md)
- [Syntax controls](extensions/markdown-syntax.md)
- [Code highlighting](extensions/code-languages.md)

## API references

The [addon API reference](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FREADME.md) describes the public contracts. It is generated from source declarations; `npm run docs` writes a local copy into the ignored documentation snapshot. Change the source, run `npm run docs`, and confirm `npm run docs:check` passes.
