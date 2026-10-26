import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RecoveryBoundary } from '../../src/renderer/src/RecoveryBoundary'
import { Button } from '../../src/ui/Controls'
import '../../src/renderer/src/styles.css'

Object.assign(window, {
  hibi: {
    getDocument: async () => ({
      name: 'unsaved.md',
      markdown: 'keep this draft',
      dirty: true,
    }),
    saveDocument: async () => {
      document.body.dataset.copySaved = 'true'
      return { name: 'copy.md', markdown: 'keep this draft', dirty: false }
    },
    writeClipboardText: async (text: string) => {
      document.body.dataset.copiedError = text
    },
  },
})
function Harness() {
  const [failed, setFailed] = useState(false)
  if (failed) throw new Error('fixture render failure')
  return <Button onClick={() => setFailed(true)}>trigger render failure</Button>
}
const root = document.createElement('div')
document.body.append(root)
createRoot(root).render(
  <RecoveryBoundary>
    <Harness />
  </RecoveryBoundary>,
)
