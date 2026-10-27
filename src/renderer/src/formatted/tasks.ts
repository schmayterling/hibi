import type { EditorState, TransactionSpec } from '@codemirror/state'
import { type EditorView, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { TaskList } from '@lezer/markdown'
import { decodeHTMLStrict } from 'entities'
import { wikiText } from '../../../addons/markdown/formatted-syntax.ts'
import { EmptyTask } from '../../../shared/markdown-extra-syntax.ts'
import type { FormattedContribution } from '../formatted-contributions.ts'
import './tasks.css'

export { EmptyTask } from '../../../shared/markdown-extra-syntax.ts'

/** Check or uncheck the task marker starting at `pos` with one source edit. */
export function toggleTask(
  state: EditorState,
  pos: number,
): TransactionSpec | null {
  const marker = state.sliceDoc(pos, pos + 3)
  if (state.readOnly || !/^\[[ xX]\]$/.test(marker)) return null
  return {
    changes: {
      from: pos + 1,
      to: pos + 2,
      insert: marker[1] === ' ' ? 'x' : ' ',
    },
    userEvent: 'input.toggle',
  }
}

/** A task's checkbox. Clicking it or pressing Space while it has focus toggles the marker. */
export class TaskWidget extends WidgetType {
  readonly checked: boolean
  readonly text: string
  constructor(checked: boolean, text: string) {
    super()
    this.checked = checked
    this.text = text
  }
  override eq(other: TaskWidget) {
    return other.checked === this.checked && other.text === this.text
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'hibi-lp-task'
    // Keep the caret and focus in the text, like the rich editor's checkbox.
    box.addEventListener('mousedown', (event) => event.preventDefault())
    box.addEventListener('click', () => {
      // The edit updates the box; without one, it keeps showing the source.
      // Cancelling the click would restore the old state after the update.
      const spec = toggleTask(view.state, view.posAtDOM(box))
      if (spec) view.dispatch(spec)
      else box.checked = !box.checked
    })
    this.updateDOM(box)
    return box
  }
  override updateDOM(dom: HTMLElement) {
    const box = dom as HTMLInputElement
    box.checked = this.checked
    box.setAttribute(
      'aria-label',
      `Task item checkbox for ${this.text || 'empty task item'}`,
    )
    return true
  }
}

/** Syntax whose text the formatted view does not show: an inline link's destination and title, images, html. */
const unshown = new Set([
  'URL',
  'LinkTitle',
  'LinkLabel',
  'Image',
  'HTMLTag',
  'Comment',
  'ProcessingInstruction',
])

/**
 * The task's text after `from` as the formatted view shows it, for its
 * checkbox's name: without Markdown markers, a link's text only, entities as
 * their characters. Like outline labels, it reads at most 512 characters.
 */
function taskText(state: EditorState, task: SyntaxNode, from: number) {
  const end = Math.min(task.to, from + 512)
  let text = ''
  let at = from
  /** Add the text up to `to`, then `insert` for the node there, and go past the node. */
  const take = (node: SyntaxNode, insert = '') => {
    if (node.from > at) text += state.sliceDoc(at, Math.min(node.from, end))
    text += insert
    at = node.to
  }
  const visit = (node: SyntaxNode | null) => {
    for (; node && node.from < end; node = node.nextSibling) {
      if (node.to <= at) continue
      const { name } = node
      // Reference links and images show as written.
      if (
        (name === 'Link' || name === 'Image') &&
        state.sliceDoc(node.to - 1, node.to) !== ')'
      )
        continue
      if (
        /Mark(er)?$/.test(name) ||
        // Autolinks and bare URLs show their URL.
        (unshown.has(name) && !(name === 'URL' && node.parent?.name !== 'Link'))
      )
        take(node)
      else if (name === 'Escape')
        take(node, state.sliceDoc(node.to - 1, node.to))
      else if (name === 'WikiLink') {
        const label = node.getChild('WikiAlias') ?? node.getChild('WikiTarget')
        take(
          node,
          node.to <= end
            ? decodeHTMLStrict(label?.tree?.prop(wikiText) ?? '')
            : '',
        )
      } else if (name === 'HardBreak') take(node, ' ')
      else if (name === 'Entity')
        take(node, decodeHTMLStrict(state.sliceDoc(node.from, node.to)))
      else visit(node.firstChild)
    }
  }
  visit(task.firstChild)
  if (end > at) text += state.sliceDoc(at, end)
  return text.replace(/\s+/g, ' ').trim()
}

/** The item's first block, which a task marker must start. */
function firstBlock(item: SyntaxNode) {
  // A lookup after the list marker, not a walk over the item's children.
  const mark = item.firstChild
  return mark ? item.childAfter(mark.to) : null
}
const isTaskItem = (item: SyntaxNode) => firstBlock(item)?.name === 'Task'

/** GitHub task list items: the marker becomes a checkbox that edits the source. */
export const contribution: FormattedContribution = {
  id: 'markdown.tasks',
  feature: 'markdown.tasks',
  flavor: 'markdown.github',
  syntax: [TaskList, EmptyTask],
  views: [
    {
      // Like the rich editor's task item: no bullet, the checkbox and a 10px
      // gap in a 30px indent.
      nodes: ['ListItem'],
      container: (node) =>
        isTaskItem(node.node) ? { width: '30px', marker: false } : undefined,
    },
    {
      nodes: ['TaskMarker'],
      decorate(node, out, { state }) {
        // A marker after the item's first block is text, as in GitHub.
        const task = node.node.parent
        const item = task?.parent
        if (
          !task ||
          item?.name !== 'ListItem' ||
          firstBlock(item)?.from !== task.from
        )
          return false
        const line = state.doc.lineAt(node.from)
        const rest = state.sliceDoc(node.to, line.to)
        // The checkbox takes the marker and the space before the task's text.
        const space = rest.length - rest.replace(/^[ \t]+/, '').length
        out.replace(
          node.from,
          node.to + space,
          new TaskWidget(
            /[xX]/.test(state.sliceDoc(node.from + 1, node.from + 2)),
            taskText(state, task, node.to),
          ),
        )
        return false
      },
    },
  ],
}
