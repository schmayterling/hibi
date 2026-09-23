import { Puzzle } from 'lucide-react'
import { defineAddon } from '../api'
import manifest from './manifest'
import { ObsidianPluginPanel } from './Panel'
import { ObsidianPluginRuntime } from './runtime'

let running: ObsidianPluginRuntime | null = null

export default defineAddon({
  manifest,
  async start(context) {
    const runtime = new ObsidianPluginRuntime(context)
    running = runtime
    const view = context.sidebar.register({
      id: 'plugins',
      label: 'Obsidian plugins',
      icon: Puzzle,
      Content: () => (
        <ObsidianPluginPanel context={context} runtime={runtime} />
      ),
    })
    context.commands.register({
      id: 'open',
      label: 'Manage Obsidian plugins',
      keywords: 'community plugins install',
      run: () => view.open(),
    })
    await runtime.start()
  },
  stop() {
    running?.stop()
    running = null
  },
})
