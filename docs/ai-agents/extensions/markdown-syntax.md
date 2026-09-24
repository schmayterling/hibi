# Markdown syntax controls

Settings → Syntax controls rendered formatting. Base Markdown covers heading levels, bold, italic, inline code, escapes, code blocks, quotes, lists, dividers, line breaks, links, media, HTML, GitHub tables, tasks, strikethrough, alerts, and Obsidian wikilinks, embeds, and highlights. Other addons can supply switches for math, Typst blocks, subscript, and small text.

Disabling syntax displays its original Markdown in rich editing and exports without changing source. Preferences apply across documents and launches. Disabled rich-formatting commands become unavailable; source remains editable. Paragraphs and plain text stay available. HTML still passes through export sanitization, and unsupported raw HTML retains the rich editor's read-only protection.

Code highlighting has separate language switches. Both pages support filtering and **Reset all**, which enables hidden results too. See [code highlighting](code-languages.md).

## Subscript and small text

Text extras supports `H~2~O` and lines beginning with `-# ` for Discord-style small text. Both have toolbar actions and syntax switches. `~~text~~` remains strikethrough. Subscript cannot contain newlines or surrounding whitespace. Enter after small text starts a normal paragraph. Automatic flavor detection recognizes existing syntax; choose the flavor before formatting a new document.

## Registering syntax

Register each feature alongside its Markdown flavor:

```ts
context.editor.registerSyntax({
  id: 'callout',
  label: 'callouts',
  group: 'my extension',
  description: 'custom callout blocks.',
  level: 'block',
  extensions: ['callout'],
  matches: (token) => token.type === 'callout',
})
```

The host stores local IDs as `addon-id.feature-id`. `matches` receives lexer tokens and must run synchronously without changing them. `level` selects a block or inline literal fallback. `extensions` lists associated Tiptap extension names.

Also register tokenizers through the flavor's `export.extensions`, so disabled rich syntax has complete tokens to preserve as literal text. Keep tokenizers registered when preferences change.

`context.editor.isSyntaxEnabled('callout')` reads the preference; `context.editor.onSyntaxChange(listener)` reports changes. Registrations/listeners return cleanup functions and are removed on addon shutdown. Preferences survive disable/re-enable. Settings and palette entries appear automatically. Unregistered syntax remains enabled.

See the [syntax API](../reference/markdown-syntax-api.md) and [addon API](../reference/addon-api.md).
