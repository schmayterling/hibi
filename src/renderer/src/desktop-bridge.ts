export {}

// Native appearance subscriptions may start while shared modules load.
Object.defineProperty(window, 'hibi', {
  value: Object.fromEntries(
    Object.entries(window.hibiTransport).filter(
      ([name]) => !name.endsWith('DocumentTransfer'),
    ),
  ),
  configurable: true,
})
const { documentTransferApi } = await import('./document-transfer')
Object.defineProperty(window, 'hibi', {
  value: documentTransferApi(window.hibiTransport, async (metadata) => {
    const { documentRuntime } = await import('./document-runtime')
    const owned = documentRuntime.get(metadata.tabId)
    if (!owned || (!owned.dirty && !documentRuntime.ownsMetadata(metadata)))
      return null
    return documentRuntime.metadataDocument(metadata)
  }),
  configurable: true,
})
await import('./main')
