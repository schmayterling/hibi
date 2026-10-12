/**
 * Declarative package sheets sit after core styles and before every runtime
 * addon style, ordered by owner id and then declared order. A URL keeps the
 * browser's base for relative `url()` and `@import`.
 */
export function linkAddonSheets(owner: string, urls: readonly string[]) {
  const links = new Map<HTMLLinkElement, () => void>()
  const ready = Promise.all(
    urls.map(
      (href, index) =>
        new Promise<void>((resolve, reject) => {
          const element = document.createElement('link')
          element.rel = 'stylesheet'
          element.dataset.addonStyle = owner
          element.dataset.addonStyleIndex = String(index)
          const next = [
            ...document.head.querySelectorAll<HTMLElement>(
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
          document.head.insertBefore(element, next ?? null)
        }),
    ),
  ).then(() => {})
  return {
    ready,
    dispose() {
      for (const [element, settle] of links) {
        element.remove()
        settle()
      }
      links.clear()
    },
  }
}
