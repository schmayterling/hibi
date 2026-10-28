import { lazy, type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { AddonWindowEditorProps, AddonWindowProps } from '../../addons/api'
import { legacySdk } from '../../addons/sdk-host'
import type {
  AddonWindowContext,
  AddonWindowGlobal,
} from '../../shared/addon-windows'
import { errorMessage } from '../../shared/errors'
import {
  activePaletteKey,
  applyActivePalette,
  createColorschemeStore,
} from '../../ui/colorschemes'
import './styles.css'
import '../../ui/ui-case'
import { codemirrorFormattedView } from './formatted-engine'

declare global {
  interface Window {
    hibiAddonWindow: AddonWindowGlobal
  }
}

// Take the bridge before any addon module loads. This module's imports contain no
// addon code, and afterwards the global answers only `context` and `close`.
const bridge = window.hibiAddonWindow.seal()
if (!codemirrorFormattedView) {
  legacySdk.all = () => import('../../addons/sdk')
  legacySdk.rich = () => import('@tiptap/core')
}
// Same origin as the main window, so appearance follows its saved choice.
createColorschemeStore('hibi-colorscheme').start()
// The main window's resolved palette wins, so addon colorschemes apply here too.
const palette = document.createElement('style')
document.head.append(palette)
applyActivePalette(palette)
window.addEventListener('storage', (event) => {
  if (event.key === activePaletteKey) applyActivePalette(palette)
})
// "Match system" keeps following the system after the main window closes.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () =>
  applyActivePalette(palette),
)
const root = createRoot(document.getElementById('root') as HTMLElement)
const request = async <T,>(pending: Promise<unknown>) => {
  try {
    return (await pending) as T
  } catch (error) {
    throw new Error(errorMessage(error))
  }
}

let context: AddonWindowContext | undefined
let disposeSheets = () => {}
window.addEventListener('pagehide', () => disposeSheets(), { once: true })

function show(children: ReactNode) {
  root.render(
    <StrictMode>
      <div className="app addon-window" data-platform={context?.platform}>
        {context?.titleBar === 'hibi' && (
          <header className="titlebar addon-window-titlebar">
            <div className="document-title">
              <span>{context.title}</span>
            </div>
          </header>
        )}
        <div className="addon-window-content">{children}</div>
      </div>
    </StrictMode>,
  )
}

async function render() {
  if (!bridge) throw new Error('This addon window is unavailable.')
  context = await bridge.context()
  const { addonId, id, input } = context
  const [{ default: catalog }, { normalizeDefinition }] = await Promise.all([
    import('virtual:hibi-addon-catalog/windows'),
    import('./addon-definition'),
  ])
  const owner = catalog.find(({ id }) => id === addonId)
  const resources = await owner?.loadResources?.()
  const sheets = resources?.styles.length
    ? (await import('./addon-sheets')).linkAddonSheets(
        addonId,
        resources.styles,
      )
    : undefined
  disposeSheets = () => sheets?.dispose()
  await sheets?.ready
  const addon =
    owner && (await normalizeDefinition((await owner.load()).default, owner))
  const windows = addon?.windows
  // Only own keys: an id such as "constructor" must not reach Object.prototype.
  const Content =
    windows && Object.hasOwn(windows, id) ? windows[id] : undefined
  if (!Content) throw new Error('This addon window is unavailable.')
  // The editor host's modules expect window.hibi; give them a privilege-free stand-in.
  const Editor = lazy(async () => {
    const { windowDesktop } = await import('./window-desktop')
    Object.defineProperty(window, 'hibi', {
      value: windowDesktop(bridge),
      configurable: true,
    })
    const { WindowEditor } = await import('./WindowEditor')
    return {
      default: (props: AddonWindowEditorProps) => (
        <WindowEditor {...props} subscribeStates={bridge.onStates} />
      ),
    }
  })
  const props: AddonWindowProps = {
    input,
    native: {
      query: (method, value) => request(bridge.query(method, value)),
      invoke: (method, value) => request(bridge.invoke(method, value)),
    },
    close: () => void bridge.close(),
    Editor,
  }
  show(<Content {...props} />)
  sheets?.publish()
}

render().catch((error: unknown) => {
  disposeSheets()
  show(
    <p role="alert" className="addon-window-error">
      {errorMessage(error)}
    </p>,
  )
})
