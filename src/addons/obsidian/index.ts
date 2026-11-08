import { defineAddon } from '../api'
import manifest from './manifest'

let stop: (() => void) | undefined
let generation = 0
export default defineAddon({
  manifest,
  async start(context) {
    const current = ++generation
    const { startObsidianHost } = await import('./host')
    if (current !== generation) return
    const dispose = startObsidianHost(context)
    if (current === generation) stop = dispose
    else dispose()
  },
  stop() {
    generation++
    const dispose = stop
    stop = undefined
    dispose?.()
  },
})
