import { isolateHistory } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { Prec, Transaction } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { isMarkdownDocument } from '../../shared/document-types'
import { readFrontmatter } from '../../shared/frontmatter'
import type { AddonContext } from '../api'
import { slashQuery } from './commands'
import { createSlashMenu } from './menu'

function current(view: EditorView) {
  const selection = view.state.selection.main
  if (
    !view.hasFocus ||
    view.state.readOnly ||
    !view.state.facet(EditorView.editable) ||
    !selection.empty ||
    view.state.selection.ranges.length !== 1 ||
    view.scrollDOM.classList.contains('cm-vimMode')
  )
    return null
  const line = view.state.doc.lineAt(selection.head)
  const query = slashQuery(line.text.slice(0, selection.head - line.from))
  if (query === null) return null
  for (
    let node = syntaxTree(view.state).resolveInner(selection.head, -1);
    node;
    node = node.parent!
  ) {
    if (/^(FencedCode|CodeBlock|InlineCode|HTMLBlock|HTMLTag)$/.test(node.name))
      return null
  }
  // Markdown's syntax tree does not recognize YAML frontmatter.
  if (view.state.doc.sliceString(0, 4).startsWith('---')) {
    const block = readFrontmatter(view.state.doc.toString())
    if (block && selection.head < block.prefix.length) return null
  }
  return { from: line.from, to: selection.head, query }
}

export function sourceSlashCommands(context: AddonContext) {
  return Prec.highest(
    ViewPlugin.fromClass(
      class {
        menu: ReturnType<typeof createSlashMenu>
        frame = 0
        destroyed = false
        constructor(readonly view: EditorView) {
          this.menu = createSlashMenu(
            view.contentDOM,
            () => this.schedule(),
            context,
          )
          this.schedule()
        }
        schedule() {
          const match = current(this.view)
          this.menu.observe(match)
          if (!match) this.menu.update(null)
          cancelAnimationFrame(this.frame)
          this.frame = requestAnimationFrame(() => this.refresh())
        }
        refresh() {
          if (this.destroyed || this.view.composing) return
          const document = context.editor.getDocument()
          if (document && !isMarkdownDocument(document.name)) {
            this.menu.update(null)
            return
          }
          const match = current(this.view)
          const rect = match ? this.view.coordsAtPos(match.to) : null
          this.menu.update(
            match && rect
              ? {
                  ...match,
                  rect,
                  run: (command) => {
                    const latest = current(this.view)
                    if (
                      !latest ||
                      latest.from !== match.from ||
                      latest.to !== match.to ||
                      latest.query !== match.query
                    )
                      return
                    if ('transform' in command) {
                      const source = this.view.state.doc.toString()
                      const markdown = command.transform(
                        source.slice(0, match.from) + source.slice(match.to),
                      )
                      if (markdown === null) return
                      this.view.dispatch({
                        changes: {
                          from: 0,
                          to: source.length,
                          insert: markdown,
                        },
                        selection: { anchor: markdown.length },
                        annotations: [
                          Transaction.userEvent.of('input.complete'),
                          isolateHistory.of('full'),
                        ],
                        scrollIntoView: true,
                      })
                      this.view.focus()
                      return
                    }
                    this.view.dispatch({
                      changes: {
                        from: match.from,
                        to: match.to,
                        insert: command.markdown,
                      },
                      selection: {
                        anchor:
                          match.from +
                          (command.cursor ?? command.markdown.length),
                      },
                      annotations: [
                        Transaction.userEvent.of('input.complete'),
                        isolateHistory.of('full'),
                      ],
                      scrollIntoView: true,
                    })
                    this.view.focus()
                  },
                }
              : null,
          )
        }
        update() {
          this.schedule()
        }
        destroy() {
          this.destroyed = true
          cancelAnimationFrame(this.frame)
          this.menu.destroy()
        }
      },
      {
        eventHandlers: {
          keydown(event) {
            if (event.key === 'Enter' || event.key === 'Tab') this.refresh()
            const handled = this.menu.keydown(event)
            if (handled) event.preventDefault()
            return handled
          },
          focus() {
            this.schedule()
          },
        },
      },
    ),
  )
}
