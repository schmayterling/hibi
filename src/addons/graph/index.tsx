import { Network } from 'lucide-react'
import { lazy } from 'react'
import { defineAddon } from '../api'
import manifest from './manifest'
import { GraphPanel } from './Panel'
import css from './style.css?inline'
export default defineAddon({
  manifest,
  Settings: lazy(() =>
    import('./Settings').then(({ Settings }) => ({ default: Settings })),
  ),
  start(context) {
    context.styles.register('graph', css)
    const expanded = context.views.register({
      id: 'expanded',
      label: 'Workspace graph',
      location: 'tab',
      Content: ({ input }) => {
        const query = typeof input === 'string' ? input : ''
        return (
          <GraphPanel
            key={query}
            context={context}
            expandedView
            initialQuery={query}
          />
        )
      },
    })
    const view = context.sidebar.register({
      id: 'workspace',
      label: 'Workspace graph',
      icon: Network,
      Content: () => (
        <GraphPanel
          context={context}
          onExpand={(query) => expanded.open({ input: query })}
        />
      ),
    })
    const open = () => view.open()
    context.commands.register({
      id: 'open',
      label: 'Open workspace graph',
      keywords: 'notes links connections backlinks',
      run: open,
    })
    context.toolbar.register({
      id: 'open',
      label: 'Workspace graph',
      icon: Network,
      commandId: 'open',
    })
  },
})
