import * as remote from '@electron/remote'
import * as electron from 'electron'
import {
  OBSIDIAN_DESKTOP,
  type ObsidianDesktopBridge,
} from '../shared/obsidian-desktop'
import { executeDesktopPlugin } from './obsidian-loader'
import './index'

const bridge: ObsidianDesktopBridge = {
  load(id, hash, api, hostModule, activate) {
    const reply = electron.ipcRenderer.sendSync(
      OBSIDIAN_DESKTOP.acquire,
      id,
      hash,
    ) as
      | { source: string; filename: string; capability: string }
      | { error: string }
    if (!reply || 'error' in reply)
      throw new Error(reply?.error ?? 'Full computer access is not available.')
    activate(reply.capability)
    return executeDesktopPlugin(
      reply.source,
      reply.filename,
      api,
      hostModule,
      electron,
      remote,
    )
  },
}
Object.defineProperty(globalThis, 'hibiObsidianDesktop', {
  value: Object.freeze(bridge),
})
