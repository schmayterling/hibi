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
          // Disposal settles pending loads so stale callbacks never fail a later start.
          links.set(element, resolve)
          element.onload = () => resolve()
          element.onerror = () =>
            reject(
              new Error(
                `The ${owner} addon could not load ${href.replace(/^.*\/[a-f\d]{64}\//, '')}.`,
              ),
            )
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
