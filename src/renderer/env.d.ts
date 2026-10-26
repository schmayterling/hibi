import type { DesktopApi } from '../shared/desktop'
import type { DocumentTransferApi } from '../shared/document-transfer'

declare global {
  interface Window {
    hibi: DesktopApi
    hibiTransport: DesktopApi & DocumentTransferApi
  }
}
