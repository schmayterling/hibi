import { lazy } from 'react'
import { defineAddon } from '../api'
import manifest from './manifest'

let generation = 0
let stop: (() => void) | undefined
let idle: number | undefined
export default defineAddon({
  manifest,
  Settings: lazy(() =>
    import('./Settings').then(({ Settings }) => ({ default: Settings })),
  ),
  start(context) {
    const run = ++generation
    const failed = () => {
      if (run === generation) context.notify('Could not load keyBeats.')
    }
    void import('./engine')
      .then((module) => {
        if (run !== generation) return
        // Cold output-device initialization must stay off the input callback.
        idle = requestIdleCallback(
          () => {
            idle = undefined
            if (run !== generation) return
            try {
              stop = module.startKeybeats(context)
            } catch {
              failed()
            }
          },
          { timeout: 1000 },
        )
      })
      .catch(failed)
  },
  stop() {
    generation++
    if (idle !== undefined) cancelIdleCallback(idle)
    idle = undefined
    stop?.()
    stop = undefined
  },
})
