import { Annotation, EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import DOMPurify from 'dompurify'
import { renderedHtmlOptions } from '../../../shared/rendered-html.ts'
import { documentRuntime } from '../document-runtime'
import {
  type FormattedContribution,
  formattedDocument,
} from '../formatted-contributions.ts'
import { renderMarkdown } from '../render-markdown'

/*
 * Copy and paste in the formatted view. Copying gives the selection's exact
 * Markdown as text and the same Markdown rendered by the export renderer,
 * sanitized, as HTML; pasted HTML becomes Markdown, and plain text pastes as
 * it is.
 */

/** Marks the HTML this view copies, whose text is already the exact Markdown. */
const copied = 'data-hibi-markdown'
/**
 * ponytail: the most selected Markdown a copy renders as HTML, the size of the
 * largest note the rich view opens formatted. The clipboard only takes data
 * during the event, and rendering grows with the selection, so larger
 * selections copy their Markdown as text only, as the source view does. A
 * later write would replace anything copied since; HTML for them needs a
 * clipboard that can add a format to an earlier copy.
 */
const renderedLimit = 256 * 1024
const pastedSelection = Annotation.define<EditorSelection>()

/** HTML pastes waiting for the converter, with the selection each replaces. */
const pastes = new Set<{ view: EditorView; selection: EditorSelection }>()

function copy(event: ClipboardEvent, view: EditorView, cut: boolean) {
  const data = event.clipboardData
  const { state } = view
  const ranges = state.selection.ranges.filter((range) => !range.empty)
  // A collapsed selection copies whole lines, as in the source view.
  if (!data || !ranges.length) return false
  const markdown = ranges
    .map((range) => state.sliceDoc(range.from, range.to))
    .join(state.lineBreak)
  event.preventDefault()
  data.clearData()
  data.setData('text/plain', markdown)
  if (markdown.length <= renderedLimit)
    try {
      const { tabId } = state.facet(formattedDocument)
      const { html } = renderMarkdown(
        markdown,
        tabId ? documentRuntime.get(tabId)?.id : undefined,
      )
      data.setData(
        'text/html',
        `<div ${copied}>${DOMPurify.sanitize(html, renderedHtmlOptions)}</div>`,
      )
    } catch (error) {
      // The text is on the clipboard either way.
      console.error('Copied HTML could not be rendered:', error)
    }
  if (cut && !state.readOnly)
    view.dispatch({
      changes: ranges.map(({ from, to }) => ({ from, to })),
      scrollIntoView: true,
      userEvent: 'delete.cut',
    })
  return true
}

function paste(event: ClipboardEvent, view: EditorView) {
  const data = event.clipboardData
  const html = data?.getData('text/html')
  // Plain text, and this view's own copies, paste their text as it is.
  if (!html || view.state.readOnly) return false
  event.preventDefault()
  // The clipboard is only readable during the event.
  const text = data?.getData('text/plain') ?? ''
  const pending = { view, selection: view.state.selection }
  pastes.add(pending)
  void import('../html-markdown')
    .then(({ htmlToMarkdown }) => htmlToMarkdown(html, text))
    .catch((error: unknown) => {
      console.error('Pasted HTML could not be converted:', error)
      return ''
    })
    .then((markdown) => {
      pastes.delete(pending)
      const insert = markdown || text
      if (!insert || !view.dom.isConnected || view.state.readOnly) return
      const { selection } = pending
      // One source edit at the selection the paste was made at; edits and
      // selections made since keep their place.
      view.dispatch(
        view.state.selection.eq(selection)
          ? view.state.replaceSelection(insert)
          : {
              changes: selection.ranges.map(({ from, to }) => ({
                from,
                to,
                insert,
              })),
            },
        {
          scrollIntoView: true,
          userEvent: 'input.paste',
          annotations: pastedSelection.of(selection),
        },
      )
    })
  return true
}

/** Copy, cut and paste with Markdown text and rendered HTML. */
export const contribution: FormattedContribution = {
  id: 'core.clipboard',
  extension: [
    EditorView.domEventHandlers({
      copy: (event, view) => copy(event, view, false),
      cut: (event, view) => copy(event, view, true),
      paste: (event, view) => paste(event, view),
    }),
    EditorView.updateListener.of((update) => {
      for (const transaction of update.transactions) {
        if (!transaction.docChanged) continue
        const pasted = transaction.annotation(pastedSelection)
        for (const pending of pastes) {
          if (pending.view !== update.view) continue
          // Later pastes at the same selection follow this insertion.
          // Intervening edits keep the original selection association.
          pending.selection = pasted?.eq(pending.selection)
            ? EditorSelection.create(
                pending.selection.ranges.map((range) =>
                  EditorSelection.cursor(
                    transaction.changes.mapPos(range.to, 1),
                  ),
                ),
                pending.selection.mainIndex,
              )
            : pending.selection.map(transaction.changes)
        }
      }
    }),
  ],
}
