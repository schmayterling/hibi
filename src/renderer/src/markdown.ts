import { Extension } from '@tiptap/core'
import { Placeholder } from '@tiptap/extension-placeholder'
import { Markdown, type MarkdownExtensionOptions } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { Marked } from 'marked'
import type { MarkdownFlavor } from '../../addons/api'
import { BlockExit } from './BlockExit.ts'
import { CodeHighlight } from './CodeHighlight.ts'
import { guardNativeInputRules } from './input-rule-guard.ts'
import { literalMarkdown } from './LiteralMarkdown.ts'
import {
  guardNativeListTokenizer,
  parseEmptyTaskItems,
} from './list-tokenizer-prefix.ts'
import {
  configureMarkdownEntities,
  entityMarkdown,
  richTextParser,
} from './markdown-entities.ts'
import { MarkdownMarkExit } from './markdown-markers.ts'
import {
  paragraphEscaper,
  renderTableParagraphs,
} from './markdown-serialization.ts'
import { markdownSyntax } from './markdown-syntax.ts'
import { preserveHtml, rawHtml } from './RawHtml.ts'
import { richFind } from './rich-find.ts'
import { installSyntaxPreferences } from './syntax-parser.ts'
import { TabIndent } from './tab-indent.ts'

export { projectMarkdown } from './markdown-projection.ts'

/** Shared declarations for the visual editor and native schema-only conversion. */
export function markdownConfiguration(
  flavors: readonly MarkdownFlavor[],
  history?: Extension,
) {
  const options = Object.assign(
    { gfm: false, breaks: false },
    ...flavors.map((flavor) => flavor.markedOptions),
  )
  const parser = richTextParser(installSyntaxPreferences(new Marked(options)))
  for (const flavor of flavors)
    for (const extension of flavor.export?.extensions ?? [])
      parser.use(extension)
  const enabled = (id: string) => markdownSyntax.enabled(`core.${id}`)
  const levels = ([1, 2, 3, 4, 5, 6] as const).filter((level) =>
    enabled(`heading-${level}`),
  )
  const taskItems = ['taskList', 'taskItem'].every(
    (name) =>
      markdownSyntax.extensionEnabled(name) &&
      flavors.some((flavor) =>
        flavor.richExtensions?.some((extension) => extension.name === name),
      ),
  )
  const escapeParagraph = paragraphEscaper(parser, flavors)
  const NativeStarterKit = StarterKit.extend({
    addExtensions() {
      return (
        this.parent?.()
          .map(entityMarkdown)
          .map((extension) =>
            extension.name === 'paragraph'
              ? extension.extend({
                  renderMarkdown: escapeParagraph,
                })
              : extension,
          )
          .map((extension) =>
            taskItems ? parseEmptyTaskItems(extension) : extension,
          )
          .map(guardNativeListTokenizer)
          .map(preserveHtml)
          .map(guardNativeInputRules) ?? []
      )
    },
  })
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
    ...rawHtml,
  ]
  const addons = flavors
    .flatMap((flavor) => flavor.richExtensions ?? [])
    .filter((extension) => markdownSyntax.extensionEnabled(extension.name))
    .map(renderTableParagraphs)
    .map((extension) =>
      taskItems ? parseEmptyTaskItems(extension) : extension,
    )
    .map(guardNativeListTokenizer)
    .map(preserveHtml)
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
      addProseMirrorPlugins: () => [richFind()],
    }),
    ...core,
    Markdown.extend({
      onBeforeCreate(event) {
        this.parent?.(event)
        configureMarkdownEntities(this.storage.manager)
      },
    }).configure({
      // Tiptap types this as the callable singleton, but uses instance methods.
      marked: parser as unknown as NonNullable<
        MarkdownExtensionOptions['marked']
      >,
      markedOptions: options,
    }),
    TabIndent,
    CodeHighlight,
    BlockExit,
    MarkdownMarkExit,
    ...addons,
    Placeholder.configure({ placeholder: 'Start typing' }),
  ]
}
