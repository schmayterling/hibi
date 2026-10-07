import { lazy } from 'react'
import { defineAddon } from '../api'
import manifest from './manifest'
import { getPreferences, settingsEvent } from './preferences'

let stop: (() => void) | undefined
export default defineAddon({
  manifest,
  Settings: lazy(() =>
    import('./Settings').then(({ Settings }) => ({ default: Settings })),
  ),
  start() {
    // The server runs in the main process, so other windows keep it alive.
    const sync = () => {
      void window.hibi
        .invokeAddon(manifest.id, 'start', getPreferences())
        .catch(() => {})
    }
    sync()
    window.addEventListener(settingsEvent, sync)
    stop = () => {
      window.removeEventListener(settingsEvent, sync)
      void window.hibi.invokeAddon(manifest.id, 'stop').catch(() => {})
    }
  },
  stop() {
    stop?.()
    stop = undefined
  },
})
