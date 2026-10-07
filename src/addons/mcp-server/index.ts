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
    const sync = () => {
      void window.hibi
        .invokeAddon(manifest.id, 'start', getPreferences())
        .catch(() => {})
    }
    sync()
    window.addEventListener(settingsEvent, sync)
    // The main process owns the server and closes it when the addon is disabled;
    // closing one window must not stop it for the others.
    stop = () => window.removeEventListener(settingsEvent, sync)
  },
  stop() {
    stop?.()
    stop = undefined
  },
})
