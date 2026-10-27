import { isolateHistory } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { type EditorState, Prec, Transaction } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import { isMarkdownDocument } from '../../shared/document-types'
import type { AddonContext } from '../api'
import {
  maximumSlashQueryUnits,
  type SlashCommand,
  slashQuery,
} from './commands'
import { createSlashMenu } from './menu'

type FrontmatterReader = (state: EditorState) =>
  | {
      end: number
      prefix?: number
      open: boolean
      closer: number
      searched: number
      oversized?: boolean
      complete?: boolean
    }
  | undefined

function current(
  view: EditorView,
  formattedTree?: (state: EditorState) => Tree | null,
  sourceBounds?: FrontmatterReader,
  cell = false,
) {
  const formatted = Boolean(formattedTree)
  const source = !formatted && !cell
  const selection = view.state.selection.main
  if (
    !view.hasFocus ||
    view.composing ||
    view.state.readOnly ||
    !view.state.facet(EditorView.editable) ||
    !selection.empty ||
    view.state.selection.ranges.length !== 1 ||
    view.scrollDOM.classList.contains('cm-vimMode')
  )
    return null
  const line = view.state.doc.lineAt(selection.head)
  if (source && selection.head - line.from > maximumSlashQueryUnits) return null
  const sourcePrefix = source
    ? view.state.doc.sliceString(line.from, selection.head)
    : null
  if (sourcePrefix !== null && slashQuery(sourcePrefix) === null) return null
  // A cell holds no blocks; its query starts after the cell's padding.
  const tree = cell
    ? null
    : formattedTree
      ? formattedTree(view.state)
      : syntaxTree(view.state)
  let block: SyntaxNode | null = null
  for (
    let node: SyntaxNode | null =
      tree?.resolveInner(selection.head, -1) ?? null;
    node;
    node = node.parent
  ) {
    if (
      /^(FencedCode|CodeBlock|InlineCode|HTMLBlock|HTMLTag|Frontmatter)$/.test(
        node.name,
      )
    )
      return null
    if (
      formatted &&
      !block &&
      /^(Paragraph|Task|Subtext|ATXHeading[1-6]|SetextHeading[12])$/.test(
        node.name,
      )
    )
      block = node
  }
  let from = line.from
  if (formatted) {
    if (!block) return null
    from = block.from
    const mark = block.firstChild
    if (mark?.name === 'TaskMarker' || /^ATXHeading/.test(block.name))
      from = mark?.to ?? from
    if (block.name === 'Subtext') from += 3
  }
  if (selection.head - from > maximumSlashQueryUnits) return null
  const prefix =
    sourcePrefix ?? view.state.doc.sliceString(from, selection.head)
  const spacing = source ? 0 : (/^[ \t]*/.exec(prefix)?.[0].length ?? 0)
  from += spacing
  const query = slashQuery(prefix.slice(spacing))
  if (query === null) return null
  // The source language does not recognize YAML; use the host's bounded search.
  const bounds = source && sourceBounds?.(view.state)
  if (
    bounds &&
    (bounds.oversized ||
      selection.head < (bounds.prefix ?? bounds.end) ||
      (bounds.open &&
        !bounds.complete &&
        !bounds.closer &&
        bounds.searched < view.state.doc.length))
  )
    return null
  return { from, to: selection.head, query, block }
}

/**
 * Slash commands for a source view, the formatted view with its syntax tree,
 * or the editor of a table cell in the formatted view `main`, which offers
 * the commands that stay inside a cell.
 */
export function sourceSlashCommands(
  context: AddonContext,
  formattedTree?: (state: EditorState) => Tree | null,
  sourceBounds?: FrontmatterReader,
  main?: EditorView,
) {
  const formatted = Boolean(formattedTree)
  const cell = Boolean(main)
  /** Inline syntax, plain text and document commands keep a cell's text one line of a table. */
  const fitsCell = (command: SlashCommand) =>
    'transform' in command ||
    command.id === 'text' ||
    context.editor
      .getSyntaxFeatures()
      .some(
        (feature) => feature.id === command.id && feature.level === 'inline',
      )
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
            cell ? fitsCell : undefined,
          )
          this.schedule()
        }
        schedule() {
          const match = current(this.view, formattedTree, sourceBounds, cell)
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
          const match = current(this.view, formattedTree, sourceBounds, cell)
          const rect = match ? this.view.coordsAtPos(match.to) : null
          this.menu.update(
            match && rect
              ? {
                  ...match,
                  rect,
                  run: (command) => {
                    const latest = current(
                      this.view,
                      formattedTree,
                      sourceBounds,
                      cell,
                    )
                    if (
                      !latest ||
                      latest.from !== match.from ||
                      latest.to !== match.to ||
                      latest.query !== match.query
                    )
                      return
                    if ('transform' in command) {
                      // A cell's query ends at the formatted view's caret,
                      // which follows the cell's.
                      const target = main ?? this.view
                      const to = main
                        ? main.state.selection.main.head
                        : match.to
                      const from = to - (match.to - match.from)
                      if (
                        main &&
                        main.state.sliceDoc(from, to) !==
                          this.view.state.sliceDoc(match.from, match.to)
                      )
                        return
                      const source = target.state.doc.toString()
                      const markdown = command.transform(
                        source.slice(0, from) + source.slice(to),
                      )
                      if (markdown === null) return
                      target.dispatch({
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
                      target.focus()
                      return
                    }
                    const block = latest.block
                    const replaceBlock =
                      formatted &&
                      block &&
                      (command.id === 'text' ||
                        context.editor
                          .getSyntaxFeatures()
                          .some(
                            (feature) =>
                              feature.id === command.id &&
                              feature.level === 'block',
                          ))
                    const from = replaceBlock ? block.from : match.from
                    const changes = [
                      { from, to: match.to, insert: command.markdown },
                    ]
                    const closing = replaceBlock && block.lastChild
                    if (
                      closing &&
                      closing.name === 'HeaderMark' &&
                      closing.from >= match.to
                    )
                      changes.push({
                        from: block.name.startsWith('SetextHeading')
                          ? this.view.state.doc.lineAt(closing.from).from - 1
                          : closing.from,
                        to: closing.to,
                        insert: '',
                      })
                    this.view.dispatch({
                      changes,
                      selection: {
                        anchor:
                          from + (command.cursor ?? command.markdown.length),
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
