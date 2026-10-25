# Code highlighting

Settings → Code highlighting lists built-in languages and enabled addon languages. Each switch controls its language and aliases in source fences, rich code blocks, and exports. Disabled or unknown languages remain readable as plain text. Preferences survive restarts and addon reloads. Search matches names and aliases; **Reset all** enables every language, including hidden results.

Label fences with a language such as `javascript`, `ts`, or `python`. Names are case-insensitive; trailing details such as filenames do not affect language selection. Highlighting never executes code, changes source, moves selections, or resets undo history.

Built-in languages include JavaScript, TypeScript, JSX, TSX, HTML, CSS, JSON, Python, YAML, SQL, Java, C/C++, Rust, Go, shell, PowerShell, C#, Ruby, Swift, TOML, and Dockerfile. Common aliases include `js`, `ts`, `py`, `yml`, `sh`, `rb`, and `cs`.

## Registering a language

`context.editor.registerCodeLanguage({ id, aliases?, language })` accepts a CodeMirror `Language`. Use a language package's `.language` or `StreamLanguage.define(...)`. Registration returns cleanup and is also removed when the addon stops. Later registrations override earlier languages/aliases; cleanup restores the previous grammar. Source and rich editors update in place.

Installed modules can use the shared parser runtime:

```js
export default ({ codeMirror }) => ({
  start(context) {
    context.editor.registerCodeLanguage({
      id: 'example', aliases: ['ex'],
      language: codeMirror.language.StreamLanguage.define({
        token(stream) {
          if (stream.match(/^#[^\n]*/)) return 'comment'
          if (stream.match(/^(let|print)\b/)) return 'keyword'
          if (stream.match(/^\d+/)) return 'number'
          stream.next()
          return null
        },
      }),
    })
  },
})
```

The SDK exports `codeMirror.language` and `codeMirror.highlight` alongside state, view, and commands. Use these shared tags and runtime classes. Grammar code must come from an enabled addon, never a workspace file.

Themes can override `syntax-keyword`, `syntax-string`, `syntax-number`, `syntax-comment`, `syntax-type`, `syntax-function`, `syntax-variable`, and `syntax-operator`. Older themes derive them from existing colors. Exports embed highlighted spans and token styles without addon code.

Source highlighting uses CodeMirror's incremental parser. Rich view caches each block's tokens per parser, so a language that loads or changes refreshes only its own blocks, once per frame. Blocks longer than 10,000 characters reuse their previous syntax tree after edits and highlight only text near the viewport, including only the columns near the visible ones on long unwrapped lines; the rest stays plain until scrolled into view. Hidden rich panes, such as the visual pane in source mode, refresh their highlighting when shown again. Exports highlight every block.

See the [code language API](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FCodeLanguage.md), [addon API](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FREADME.md), and [sideload SDK](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2Fsdk.md).
