export {}

// Native appearance subscriptions may start while shared modules load.
Object.defineProperty(window, 'hibi', {
  value: window.hibiTransport,
  configurable: true,
})
const { documentTransferApi } = await import('./document-transfer')
Object.defineProperty(window, 'hibi', {
  value: documentTransferApi(window.hibiTransport),
  configurable: true,
})
await import('./main')
