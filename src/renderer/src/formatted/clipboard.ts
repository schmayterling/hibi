import { EditorView } from '@codemirror/view'
import { documentRuntime } from '../document-runtime'
import { renderMarkdownAsync } from '../flavors'
import {
  type FormattedContribution,
  formattedDocument,
} from '../formatted-contributions.ts'

/*
 * Copy and paste in the formatted view. Copying gives the selection's exact
 * Markdown as text at once, and adds the same Markdown rendered by the export
 * renderer as HTML through the main process; pasted HTML becomes Markdown,
 * and plain text pastes as it is.
 */

/** Marks the HTML this view copies, whose text is already the exact Markdown. */
const copied = 'data-hibi-markdown'

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
  // The rendered HTML follows, unless something else was copied by then.
  const { tabId } = state.facet(formattedDocument)
  void renderMarkdownAsync(
    markdown,
    tabId ? documentRuntime.get(tabId)?.id : undefined,
  )
    .then(({ html }) =>
      window.hibi.writeClipboardRendered(
        markdown,
        `<div ${copied}>${html}</div>`,
      ),
    )
    .catch((error: unknown) =>
      console.error('Copied HTML could not be added:', error),
    )
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
  if (!html || html.includes(copied) || view.state.readOnly) return false
  event.preventDefault()
  // The clipboard is only readable during the event.
  const text = data?.getData('text/plain') ?? ''
  void import('../html-markdown').then(({ htmlToMarkdown }) => {
    const markdown = htmlToMarkdown(html) || text
    if (!markdown || !view.dom.isConnected || view.state.readOnly) return
    // One source edit at the selection, as the view's own paste makes.
    view.dispatch(view.state.replaceSelection(markdown), {
      scrollIntoView: true,
      userEvent: 'input.paste',
    })
  })
  return true
}

/** Copy, cut and paste with Markdown text and rendered HTML. */
export const contribution: FormattedContribution = {
  id: 'core.clipboard',
  extension: EditorView.domEventHandlers({
    copy: (event, view) => copy(event, view, false),
    cut: (event, view) => copy(event, view, true),
    paste: (event, view) => paste(event, view),
  }),
}
