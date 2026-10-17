import { contextBridge, ipcRenderer } from 'electron'
import type { AddonState } from '../addons/api'
import {
  ADDON_WINDOW_CHANNELS,
  type AddonWindowBridge,
  type AddonWindowGlobal,
} from '../shared/addon-windows'

const bridge: AddonWindowBridge = {
  context: () => ipcRenderer.invoke(ADDON_WINDOW_CHANNELS.context),
  states: () => ipcRenderer.invoke(ADDON_WINDOW_CHANNELS.states),
  onStates: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, states: AddonState[]) =>
      listener(states)
    ipcRenderer.on(ADDON_WINDOW_CHANNELS.statesChanged, receive)
    return () => {
      ipcRenderer.removeListener(ADDON_WINDOW_CHANNELS.statesChanged, receive)
    }
  },
  close: () => ipcRenderer.invoke(ADDON_WINDOW_CHANNELS.closeSelf),
  query: (method, input) =>
    ipcRenderer.invoke(ADDON_WINDOW_CHANNELS.query, method, input),
  invoke: (method, input) =>
    ipcRenderer.invoke(ADDON_WINDOW_CHANNELS.invoke, method, input),
}
let sealed = false
const closed = () => Promise.reject(new Error('This window bridge is closed.'))

// Addon windows get only their owner's identity and native handlers, never window.hibi.
if (process.isMainFrame)
  contextBridge.exposeInMainWorld('hibiAddonWindow', {
    context: () => bridge.context(),
    states: () => (sealed ? closed() : bridge.states()),
    onStates: (listener) => (sealed ? () => {} : bridge.onStates(listener)),
    close: () => bridge.close(),
    query: (method, input) => (sealed ? closed() : bridge.query(method, input)),
    invoke: (method, input) =>
      sealed ? closed() : bridge.invoke(method, input),
    seal: () => {
      if (sealed) return undefined
      sealed = true
      return bridge
    },
  } satisfies AddonWindowGlobal)
