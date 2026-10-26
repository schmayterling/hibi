import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AddonContext } from '../../src/addons/api'
import { CustomWords } from '../../src/addons/dictionary/CustomWords'
import { openCustomWords } from '../../src/addons/dictionary/custom-words'
import { SettingsPageVisible } from '../../src/ui/settings-index'
import '../../src/renderer/src/styles.css'
import '../../src/addons/dictionary/dictionary.css'

let state = { status: 'ready' as const, revision: 1, value: [] as unknown }
const listeners = new Set<() => void>()
let failing = false
const publish = (value: unknown) => {
  state = { ...state, revision: state.revision + 1, value }
  for (const listener of listeners) listener()
}
const handle = {
  snapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  async set(value: unknown) {
    if (failing) return { status: 'unavailable', reason: 'corrupt' }
    publish(value)
    return { status: 'saved', revision: state.revision, value }
  },
}

function Harness() {
  const [visible, setVisible] = useState(true)
  Object.assign(window, {
    wordHarness: {
      setVisible,
      setWords: (words: string[]) =>
        publish(words.map((word) => ({ id: word, word }))),
      fail: (value: boolean) => {
        failing = value
      },
    },
  })
  return (
    <main className="settings-screen">
      <div className="settings-content">
        <section
          role="tabpanel"
          id="settings-plugin-dictionary"
          hidden={!visible}
        >
          <SettingsPageVisible value={visible}>
            <CustomWords />
          </SettingsPageVisible>
        </section>
      </div>
    </main>
  )
}

void openCustomWords({
  storage: { global: async () => handle },
  host: { selectedIo: null },
} as unknown as AddonContext).then(() => {
  const root = document.createElement('div')
  document.body.append(root)
  createRoot(root).render(<Harness />)
})
