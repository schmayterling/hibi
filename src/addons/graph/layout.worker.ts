import { createLayout, type LayoutMessage } from './layout'

const layout = createLayout((frame, transfer) =>
  self.postMessage(frame, { transfer }),
)
self.onmessage = (event: MessageEvent<LayoutMessage>) =>
  layout.receive(event.data)
