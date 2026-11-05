type ClipboardCopy = { html: string; text: string; trusted: boolean }
let lastCopied: ClipboardCopy | null = null
const snapshots = new WeakMap<object, ClipboardCopy>()

/** Strip native clipboard envelopes without rewriting the fragment. */
export function clipboardHtml(html: string) {
  const fragment = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i.exec(
    html,
  )?.[1]
  if (fragment !== undefined) return fragment
  return html
    .replace(/^\s*<html\b[^>]*>([\s\S]*)<\/html>\s*$/i, '$1')
    .replace(/^\s*<head\b[^>]*>[\s\S]*?<\/head>/i, '')
    .replace(/^\s*<body\b[^>]*>([\s\S]*)<\/body>\s*$/i, '$1')
    .replace(/^(?:<meta\b[^>]*>)+/i, '')
}

/** Restore source only from a matching owned copy or its captured paste. */
export function isCopiedHtml(html: string, text: string, snapshot?: object) {
  const copy = snapshot === undefined ? lastCopied : snapshots.get(snapshot)
  return (
    !!copy?.trusted && clipboardHtml(html) === copy.html && text === copy.text
  )
}

/** Capture acceptance and rejection before asynchronous paste conversion. */
export function captureCopiedHtml(html: string, text: string): object {
  const snapshot = {}
  snapshots.set(snapshot, {
    html: clipboardHtml(html),
    text,
    trusted: isCopiedHtml(html, text),
  })
  return snapshot
}

/** Read the final payload after the editor's copy, cut or drag handler. */
export function observeClipboard(dom: HTMLElement) {
  // Cut can detach its target before the event bubbles.
  const owned = new WeakSet<Event>()
  const capture = (event: Event) => {
    lastCopied = null
    if (dom.contains(event.target as Node)) owned.add(event)
  }
  const remember = (event: Event) => {
    if (!owned.delete(event)) return
    const data =
      (event as ClipboardEvent).clipboardData ??
      (event as DragEvent).dataTransfer
    const html = clipboardHtml(data?.getData('text/html') ?? '')
    lastCopied = html
      ? { html, text: data?.getData('text/plain') ?? '', trusted: true }
      : null
  }
  const events = ['copy', 'cut', 'dragstart']
  const document = dom.ownerDocument
  for (const event of events) {
    document.addEventListener(event, capture, true)
    document.addEventListener(event, remember)
  }
  return () => {
    for (const event of events) {
      document.removeEventListener(event, capture, true)
      document.removeEventListener(event, remember)
    }
  }
}
