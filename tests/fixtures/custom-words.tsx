import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AddonContext } from '../../src/addons/api'
import { CustomWords } from '../../src/addons/dictionary/CustomWords'
import {
  type CustomWord,
  customWordKey,
} from '../../src/addons/dictionary/custom-word-data'
import { IndexedCustomWords } from '../../src/addons/dictionary/custom-word-storage'
import { openCustomWords } from '../../src/addons/dictionary/custom-words'
import { SettingsPageVisible } from '../../src/ui/settings-index'
import '../../src/renderer/src/styles.css'
import '../../src/addons/dictionary/dictionary.css'

let words: CustomWord[] = []
let revision = 1
let notice: string | undefined
let failing = false
let token: string | undefined
let baseRevision = 0
const changes = new Map<string, CustomWord | null>()
const metadata = () => ({
  revision,
  count: words.length,
  ...(notice ? { notice } : {}),
})
// The fixture substitutes only the native boundary; rendering uses the production page cache.
const indexed = new IndexedCustomWords(
  async <T,>(method: string, input?: unknown) => {
    const value = input as
      | {
          type?: string
          id?: string
          revision?: number
          token?: string
          offset?: number
          after?: number
          upsert?: CustomWord[]
          remove?: string[]
          merge?: boolean
        }
      | undefined
    let result: unknown
    if (method === 'customWordsMetadata') result = metadata()
    else if (method === 'customWordsGet')
      result = {
        revision,
        word: words.find((word) => word.id === value?.id) ?? null,
      }
    else if (method === 'customWords') {
      if (value?.revision !== undefined && value.revision !== revision)
        throw new Error('Custom words changed in another window. Try again.')
      const start = value?.offset ?? value?.after ?? 0
      const page = words.slice(start, start + 256)
      result = {
        revision,
        words: page,
        after: start + page.length,
        more: start + page.length < words.length,
      }
    } else if (method === 'changeCustomWords') {
      if (value?.type === 'dismissNotice') {
        notice = undefined
        result = metadata()
      } else if (value?.type === 'begin') {
        changes.clear()
        baseRevision = value.revision ?? -1
        if (baseRevision !== revision)
          throw new Error('Custom words changed in another window. Try again.')
        token = crypto.randomUUID()
        result = { token }
      } else if (value?.type === 'abort') {
        if (token === value.token) {
          changes.clear()
          token = undefined
        }
        result = {}
      } else {
        if (!token || value?.token !== token)
          throw new Error('Custom words changed in another window. Try again.')
        if (value.type === 'stage') {
          for (const word of value.upsert ?? []) {
            const match = value.merge
              ? words.find(
                  (saved) => customWordKey(saved) === customWordKey(word),
                )
              : undefined
            const id = match?.id ?? word.id ?? crypto.randomUUID()
            changes.set(id, { ...word, id })
          }
          for (const id of value.remove ?? []) changes.set(id, null)
          result = { count: changes.size }
        } else if (value.type === 'commit') {
          try {
            if (failing) throw new Error('Could not save custom words.')
            if (baseRevision !== revision)
              throw new Error(
                'Custom words changed in another window. Try again.',
              )
            words = words.flatMap((word) => {
              if (!word.id || !changes.has(word.id)) return [word]
              const changed = changes.get(word.id)
              changes.delete(word.id)
              return changed ? [changed] : []
            })
            for (const word of changes.values()) if (word) words.push(word)
            revision++
            result = { ...metadata(), changed: 1 }
          } finally {
            changes.clear()
            token = undefined
          }
        } else throw new Error('Unexpected fixture request')
      }
    } else throw new Error('Unexpected fixture method')
    return result as T
  },
)

function Harness() {
  const [visible, setVisible] = useState(true)
  Object.assign(window, {
    wordHarness: {
      setVisible,
      async setWords(values: string[]) {
        words = values.map((word) => ({ id: word, word }))
        revision++
        await indexed.refresh()
      },
      fail: (value: boolean) => {
        failing = value
      },
      async notice(value: string) {
        notice = value
        await indexed.refresh()
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

void indexed
  .refresh()
  .then(() =>
    openCustomWords(
      { host: { selectedIo: null } } as unknown as AddonContext,
      indexed,
    ),
  )
  .then(() => {
    const root = document.createElement('div')
    document.body.append(root)
    createRoot(root).render(<Harness />)
  })
