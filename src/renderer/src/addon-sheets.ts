/** A stalled stylesheet fails its activation instead of holding the editor. */
const ADDON_SHEET_TIMEOUT_MS = 5000

/**
 * Declarative package sheets sit in the body, after every head stylesheet and
 * before every runtime addon style, ordered by owner id and then declared
 * order. A URL keeps the browser's base for relative `url()` and `@import`.
 * Sheets load inactive and apply together only when `publish` runs after a
 * successful activation.
 */
export function linkAddonSheets(owner: string, urls: readonly string[]) {
  const links = new Map<HTMLLinkElement, () => void>()
  const ready = Promise.all(
    urls.map(
      (href, index) =>
        new Promise<void>((resolve, reject) => {
          const element = document.createElement('link')
          element.rel = 'stylesheet'
          element.media = 'not all'
          element.dataset.addonStyle = owner
          element.dataset.addonStyleIndex = String(index)
          const next = [
            ...document.body.querySelectorAll<HTMLElement>(
              '[data-addon-style]',
            ),
          ].find(
            ({ localName, dataset }) =>
              localName !== 'link' ||
              (dataset.addonStyle ?? '') > owner ||
              (dataset.addonStyle === owner &&
                Number(dataset.addonStyleIndex) > index),
          )
          const fail = () => {
            clearTimeout(timer)
            reject(
              new Error(
                `The ${owner} addon could not load ${href.replace(/^.*\/[a-f\d]{64}\//, '')}.`,
              ),
            )
          }
          const timer = setTimeout(fail, ADDON_SHEET_TIMEOUT_MS)
          // Disposal settles pending loads so stale callbacks never fail a later start.
          const settle = () => {
            clearTimeout(timer)
            resolve()
          }
          links.set(element, settle)
          element.onload = settle
          element.onerror = fail
          element.href = href
          document.body.insertBefore(element, next ?? null)
        }),
    ),
  ).then(() => {})
  return {
    ready,
    publish() {
      for (const element of links.keys()) element.removeAttribute('media')
    },
    dispose() {
      for (const [element, settle] of links) {
        element.remove()
        settle()
      }
      links.clear()
    },
  }
}
