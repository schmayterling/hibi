import { Extension } from '@tiptap/core'
import { Placeholder } from '@tiptap/extension-placeholder'
import { Markdown, type MarkdownExtensionOptions } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { Marked } from 'marked'
import { search } from 'prosemirror-search'
import type { MarkdownFlavor } from '../../addons/api'
import { BlockExit } from './BlockExit.ts'
import { CodeHighlight } from './CodeHighlight.ts'
import { guardNativeInputRules } from './input-rule-guard.ts'
import { literalMarkdown } from './LiteralMarkdown.ts'
import { guardNativeListTokenizer } from './list-tokenizer-prefix.ts'
import { MarkdownMarkExit } from './markdown-markers.ts'
import { markdownSyntax } from './markdown-syntax.ts'
import { installSyntaxPreferences } from './syntax-parser.ts'

export { projectMarkdown } from './markdown-projection.ts'

const NativeStarterKit = StarterKit.extend({
  addExtensions() {
    return (
      this.parent?.()
        .map((extension) =>
          extension.name === 'paragraph'
            ? extension.extend({
                renderMarkdown: (node, helpers) =>
                  helpers.renderChildren(node.content ?? []),
              })
            : extension,
        )
        .map(guardNativeListTokenizer)
        .map(guardNativeInputRules) ?? []
    )
  },
})

/** Shared declarations for the visual editor and native schema-only conversion. */
export function markdownConfiguration(
  flavors: readonly MarkdownFlavor[],
  history?: Extension,
) {
  const options = Object.assign(
    { gfm: false, breaks: false },
    ...flavors.map((flavor) => flavor.markedOptions),
  )
  const parser = installSyntaxPreferences(new Marked(options))
  const BaseLexer = parser.Lexer
  class RichLexer<
    ParserOutput = string,
    RendererOutput = string,
  > extends BaseLexer<ParserOutput, RendererOutput> {
    lex(source: string) {
      const tokens = super.lex(source)
      // Tiptap consumes tokens directly; soft breaks need spaces with pre-wrap.
      parser.walkTokens(tokens, (token) => {
        if (token.type === 'text') token.text = token.text.replaceAll('\n', ' ')
        return []
      })
      return tokens
    }
  }
  parser.Lexer = RichLexer
  for (const flavor of flavors)
    for (const extension of flavor.export?.extensions ?? [])
      parser.use(extension)
  const enabled = (id: string) => markdownSyntax.enabled(`core.${id}`)
  const levels = ([1, 2, 3, 4, 5, 6] as const).filter((level) =>
    enabled(`heading-${level}`),
  )
  const core = [
    NativeStarterKit.configure({
      ...(history ? { undoRedo: false as const } : {}),
      strike: false,
      underline: false,
      trailingNode: false,
      bold: enabled('bold') ? {} : false,
      italic: enabled('italic') ? {} : false,
      code: enabled('inline-code') ? {} : false,
      codeBlock: enabled('code-blocks') ? {} : false,
      blockquote: enabled('quotes') ? {} : false,
      bulletList: enabled('bullet-lists') ? {} : false,
      orderedList: enabled('numbered-lists') ? {} : false,
      horizontalRule: enabled('dividers') ? {} : false,
      hardBreak: enabled('line-breaks') ? {} : false,
      heading: levels.length ? { levels } : false,
      link: enabled('links') ? { openOnClick: false } : false,
    }),
    ...(history ? [history] : []),
    ...literalMarkdown,
  ]
  const addons = flavors
    .flatMap((flavor) => flavor.richExtensions ?? [])
    .filter((extension) => markdownSyntax.extensionEnabled(extension.name))
    .map(guardNativeListTokenizer)
    .map(guardNativeInputRules)
  return { parser, options, core, addons }
}

export function editorExtensions(
  flavors: readonly MarkdownFlavor[],
  history?: Extension,
) {
  const { parser, options, core, addons } = markdownConfiguration(
    flavors,
    history,
  )
  return [
    Extension.create({
      name: 'findInNote',
      addProseMirrorPlugins: () => [search()],
    }),
    ...core,
    Markdown.configure({
      // Tiptap types this as the callable singleton, but uses instance methods.
      marked: parser as unknown as NonNullable<
        MarkdownExtensionOptions['marked']
      >,
      markedOptions: options,
    }),
    Extension.create({
      name: 'listTabFocus',
      // After list keymaps: keep focus when an item cannot indent further.
      priority: 50,
      addKeyboardShortcuts() {
        const inListItem = () => {
          if (!this.editor.isEditable) return false
          const { $from } = this.editor.state.selection
          for (let depth = $from.depth; depth > 0; depth--)
            if (['listItem', 'taskItem'].includes($from.node(depth).type.name))
              return true
          return false
        }
        return { Tab: inListItem, 'Shift-Tab': inListItem }
      },
    }),
    CodeHighlight,
    BlockExit,
    MarkdownMarkExit,
    ...addons,
    Placeholder.configure({ placeholder: 'Start typing' }),
  ]
}
