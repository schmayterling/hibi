import { lazy } from 'react'
import { defineAddon } from '../api'
import manifest from './manifest'

let generation = 0
let stop: (() => void) | undefined
let idle: number | undefined
let cancelWarmup: (() => void) | undefined
export default defineAddon({
  manifest,
  Settings: lazy(() =>
    import('./Settings').then(({ Settings }) => ({ default: Settings })),
  ),
  start(context) {
    const run = ++generation
    const failed = () => {
      if (run === generation) {
        cancelWarmup?.()
        context.notify('Could not load keyBeats.')
      }
    }
    const warm = new Promise<void>((resolve) => {
      const audio = new Audio()
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        audio.oncanplaythrough = null
        audio.onerror = null
        audio.removeAttribute('src')
        audio.load()
        if (cancelWarmup === finish) cancelWarmup = undefined
        resolve()
      }
      cancelWarmup = finish
      audio.oncanplaythrough = finish
      audio.onerror = finish
      audio.preload = 'auto'
      // Eight silent PCM frames prepare output without enumerating devices.
      audio.src =
        'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA'
    })
    void Promise.all([import('./engine'), warm])
      .then(([module]) => {
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
    cancelWarmup?.()
    if (idle !== undefined) cancelIdleCallback(idle)
    idle = undefined
    stop?.()
    stop = undefined
  },
})
