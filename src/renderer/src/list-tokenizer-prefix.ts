import {
  type AnyExtension,
  getExtensionField,
  type JSONContent,
  type MarkdownToken,
  type MarkdownTokenizer,
  parseIndentedBlocks,
} from '@tiptap/core'
import {
  BulletList,
  ORDERED_LIST_MARKER_PATTERN,
  OrderedList,
  TaskItem,
  TaskList,
} from '@tiptap/extension-list'
import { TextSelection } from '@tiptap/pm/state'
import { canJoin } from '@tiptap/pm/transform'

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

const emptyTaskPrefix = /^\s*[-+*][^\S\n]+\[[ xX]\](?=\s|$)/
const emptyTask: MarkdownTokenizer = {
  ...task,
  // Marked already finds line-start bullets. Its start probe drops the first
  // character, so matching here would turn "x- [ ]" into a task list.
  start: () => -1,
  tokenize(source, _tokens, lexer) {
    if (!emptyTaskPrefix.test(source)) return undefined
    // Keep native indentation handling, but accept a checkbox at end of line.
    const result = parseIndentedBlocks(
      source,
      {
        itemPattern: /^(\s*)[-+*][^\S\n]+\[([ xX])\](?:[^\S\n]+(.*))?$/,
        extractItemData: (match) => ({
          indentLevel: match[1]?.length ?? 0,
          mainContent: match[3] ?? '',
          checked: match[2]?.toLowerCase() === 'x',
        }),
        createToken: (data, nestedTokens) => ({
          type: 'taskItem',
          raw: '',
          ...data,
          text: data.mainContent,
          tokens: lexer.inlineTokens(data.mainContent),
          nestedTokens,
        }),
      },
      lexer,
    )
    if (result)
      return {
        type: 'taskList',
        raw: source.slice(0, result.raw.length),
        items: result.items,
      }
  },
}

/** Parse and type task markers in native task lists and mixed bullet lists. */
export function parseEmptyTaskItems(extension: AnyExtension) {
  if (extension.config.addInputRules === TaskItem.config.addInputRules)
    return extension.extend({
      addInputRules() {
        return (this.parent?.() ?? []).map((rule) => {
          const original = rule.handler
          rule.handler = (props) => {
            const { state, range, match } = props
            const start = state.doc.resolve(range.from)
            if (
              !/^\s*\[[ x]?\]\s$/.test(match[0]) ||
              start.depth < 3 ||
              start.parent.type.name !== 'paragraph' ||
              start.index(-1) !== 0 ||
              start.node(-1).type.name !== 'listItem' ||
              start.node(-2).type.name !== 'bulletList'
            )
              return original(props)
            const taskList = state.schema.nodes[this.options.taskListTypeName]
            const taskItem = state.schema.nodes[extension.name]
            if (!taskList || !taskItem) return original(props)
            // Native wrapping cannot replace a list item's required first paragraph.
            // Split its bullet list so only this item becomes a task.
            const tr = state.tr.delete(range.from, range.to)
            const at = tr.doc.resolve(range.from)
            const list = at.node(-2)
            const item = at.node(-1)
            const offset = at.before(-1) - at.start(-2)
            const before = list.copy(list.content.cut(0, offset))
            const after = list.copy(list.content.cut(offset + item.nodeSize))
            const task = taskList.create(
              null,
              taskItem.create(
                { checked: match[match.length - 1] === 'x' },
                item.content,
              ),
            )
            const position = at.before(-2)
            tr.replaceWith(position, at.after(-2), [
              ...(before.childCount ? [before] : []),
              task,
              ...(after.childCount ? [after] : []),
            ])
            const taskPosition =
              position + (before.childCount ? before.nodeSize : 0)
            tr.setSelection(TextSelection.create(tr.doc, taskPosition + 3))
            if (
              tr.doc.resolve(taskPosition).nodeBefore?.type === taskList &&
              canJoin(tr.doc, taskPosition)
            )
              tr.join(taskPosition)
            const end = tr.selection.$from.after(-2)
            if (
              tr.doc.resolve(end).nodeAfter?.type === taskList &&
              canJoin(tr.doc, end)
            )
              tr.join(end)
          }
          return rule
        })
      },
    })
  if (getExtensionField(extension, 'markdownTokenizer') === task)
    return extension.extend({ markdownTokenizer: emptyTask })
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
        if (previous?.type === type) previous.content?.push(node)
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
        const token = tokenize(...args) as MarkdownToken | undefined
        if (tokenizer === ordered && token) {
          const lists = [token]
          for (const list of lists)
            for (const item of list.items ?? []) {
              const first = item.tokens?.[0]
              if (first?.type === 'paragraph' && first.raw) {
                // Native ordered lists force their first block into a paragraph.
                // Use the same block lexer as subsequent blocks and bullet lists.
                const blocks = args[2].blockTokens(first.raw)
                if (blocks.length !== 1 || blocks[0]?.type !== 'paragraph') {
                  item.tokens = blocks.concat(item.tokens?.slice(1) ?? [])
                  if (item.tokens[0]?.type !== 'paragraph')
                    item.tokens.unshift({
                      type: 'paragraph',
                      raw: '',
                      tokens: [],
                    })
                }
              }
              for (const nested of item.tokens ?? [])
                if (nested.type === 'list' && nested.ordered) lists.push(nested)
            }
        }
        return token
      },
    },
  })
}
