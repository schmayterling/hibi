import {
  type AnyExtension,
  getExtensionField,
  type JSONContent,
  type MarkdownTokenizer,
} from '@tiptap/core'
import {
  BulletList,
  ORDERED_LIST_MARKER_PATTERN,
  OrderedList,
  TaskList,
} from '@tiptap/extension-list'

const ordered = getExtensionField<MarkdownTokenizer>(
  OrderedList,
  'markdownTokenizer',
)
const task = getExtensionField<MarkdownTokenizer>(TaskList, 'markdownTokenizer')
// The ordered tokenizer matches its first split line. Task parsing also skips
// leading blank lines. Neither can put a marker or checkbox across a newline.
const orderedPrefix = new RegExp(
  `^[^\\S\\n]*(?:${ORDERED_LIST_MARKER_PATTERN})[.)][^\\S\\n]`,
)
const taskPrefix = /^\s*[-+*][^\S\n]+\[[ xX]\][^\S\n]/

/** Recover task markers that the native task tokenizer leaves in bullet lists. */
export function parseEmptyTaskItems(extension: AnyExtension) {
  if (extension.config.parseMarkdown !== BulletList.config.parseMarkdown)
    return extension
  return extension.extend({
    parseMarkdown(token, helpers) {
      if (token.type !== 'list' || token.ordered) return []
      const groups: JSONContent[] = []
      for (const item of token.items ?? []) {
        // Marked leaves an empty checkbox in the first text block, which
        // may be followed by nested lists. Remove only that marker block.
        const empty =
          !item.task && /^\[[ xX]\][ \t]*$/.test(item.tokens?.[0]?.text ?? '')
        const checkbox =
          (item.task || empty) &&
          item.raw?.match(/^[ \t]*[-+*][ \t]+\[([ xX])\](?=[ \t\r\n]|$)/)
        const [node] = helpers.parseChildren([
          checkbox
            ? {
                ...item,
                tokens: (item.tokens ?? []).filter(
                  (token, index) =>
                    token.type !== 'checkbox' && (!empty || index > 0),
                ),
              }
            : item,
        ])
        if (!node) continue
        if (checkbox) {
          node.type = 'taskItem'
          node.attrs = { checked: checkbox[1].toLowerCase() === 'x' }
          if (node.content?.[0]?.type !== 'paragraph')
            node.content = [
              { type: 'paragraph', content: [] },
              ...(node.content ?? []),
            ]
        }
        const type = checkbox ? 'taskList' : 'bulletList'
        const previous = groups.at(-1)
        if (previous?.type === type) previous.content!.push(node)
        else groups.push({ type, content: [node] })
      }
      return groups
    },
  })
}

/** Reject ordinary text before native list tokenizers split the remaining source. */
export function guardNativeListTokenizer(extension: AnyExtension) {
  const tokenizer = getExtensionField<MarkdownTokenizer | undefined>(
    extension,
    'markdownTokenizer',
  )
  const prefix =
    tokenizer === ordered
      ? orderedPrefix
      : tokenizer === task
        ? taskPrefix
        : null
  if (!prefix || !tokenizer) return extension
  const tokenize = tokenizer.tokenize
  return extension.extend({
    markdownTokenizer: {
      ...tokenizer,
      tokenize(...args: Parameters<MarkdownTokenizer['tokenize']>) {
        if (!prefix.test(args[0])) return undefined
        return tokenize(...args)
      },
    },
  })
}
