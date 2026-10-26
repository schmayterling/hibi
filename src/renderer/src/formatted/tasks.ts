import type { EditorState, TransactionSpec } from '@codemirror/state'
import { type EditorView, WidgetType } from '@codemirror/view'
import {
  type BlockContext,
  type LeafBlock,
  type LeafBlockParser,
  type MarkdownConfig,
  TaskList,
} from '@lezer/markdown'
import type { FormattedContribution } from '../formatted-contributions.ts'
import './tasks.css'

/** Lezer's task parser, for a marker with nothing after it on its line. */
class EmptyTaskParser implements LeafBlockParser {
  nextLine() {
    return false
  }
  finish(cx: BlockContext, leaf: LeafBlock) {
    cx.addLeafElement(
      leaf,
      cx.elt('Task', leaf.start, leaf.start + leaf.content.length, [
        cx.elt('TaskMarker', leaf.start, leaf.start + 3),
        ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3),
      ]),
    )
    return true
  }
}

/** `- [ ]` alone on its line is a task too; GFM's syntax needs text after the marker. */
export const EmptyTask: MarkdownConfig = {
  parseBlock: [
    {
      name: 'EmptyTask',
      leaf: (cx, leaf) =>
        /^\[[ xX]\]$/.test(leaf.content) && cx.parentType().name === 'ListItem'
          ? new EmptyTaskParser()
          : null,
      after: 'SetextHeading',
    },
  ],
}

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
    box.addEventListener('click', (event) => {
      // The source decides the state; the view updates the box after the edit.
      event.preventDefault()
      const spec = toggleTask(view.state, view.posAtDOM(box))
      if (spec) view.dispatch(spec)
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

/** GitHub task list items: the marker becomes a checkbox that edits the source. */
export const contribution: FormattedContribution = {
  id: 'markdown.tasks',
  feature: 'markdown.tasks',
  syntax: [TaskList, EmptyTask],
  views: [
    {
      nodes: ['TaskMarker'],
      decorate(node, out, { state }) {
        const line = state.doc.lineAt(node.from)
        const rest = state.sliceDoc(node.to, line.to)
        // The checkbox takes the marker and the space before the task's text.
        const space = rest.length - rest.replace(/^[ \t]+/, '').length
        out.replace(
          node.from,
          node.to + space,
          new TaskWidget(
            /[xX]/.test(state.sliceDoc(node.from + 1, node.from + 2)),
            rest.slice(space).trim(),
          ),
        )
        return false
      },
    },
  ],
}
