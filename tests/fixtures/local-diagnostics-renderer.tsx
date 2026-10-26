import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  installRendererDiagnostics,
  reportRendererFailure,
} from '../../src/renderer/src/local-diagnostics'
import { RecoveryBoundary } from '../../src/renderer/src/RecoveryBoundary'

const records: string[] = []
let reads = 0
let saves = 0
let stop = () => {}
const profile =
  new URL(location.href).searchParams.get('profile') === 'release'
    ? 'release'
    : 'debug'
const configuration = JSON.stringify({
  token: '12345678-1234-1234-1234-123456789012',
  profile,
  artifacts: [
    [new URL('./harness.js', location.href).href, 100],
    [new URL('./worker.js', location.href).href, 101],
  ],
})
const bridge = {
  record(wire: string) {
    records.push(wire)
    return true
  },
  configuration: async () => configuration,
}
function install() {
  stop = installRendererDiagnostics(bridge)
}
install()
Object.assign(window, {
  hibi: {
    getDocument: async () => {
      reads++
      return {
        name: 'PRIVATE_FILENAME.md',
        markdown: 'PRIVATE_DOCUMENT',
        dirty: true,
      }
    },
    saveDocument: async () => {
      saves++
      return { name: 'copy.md', markdown: 'PRIVATE_DOCUMENT', dirty: false }
    },
  },
  diagnosticHarness: {
    snapshot: () => ({ records: records.slice(), reads, saves }),
    clear: () => {
      records.length = 0
    },
    install,
    stop: () => stop(),
    exception: () => {
      setTimeout(() => {
        throw new Error('PRIVATE_RENDERER_MESSAGE')
      }, 0)
    },
    rejection: () => {
      setTimeout(() => {
        void Promise.reject({
          message: 'PRIVATE_REJECTION',
          toJSON() {
            throw new Error('must not run')
          },
        })
      }, 0)
    },
    inert: () => {
      let touched = 0
      const hostile = new Proxy(
        {},
        {
          get() {
            touched++
            throw 1
          },
          getOwnPropertyDescriptor() {
            touched++
            throw 1
          },
        },
      )
      reportRendererFailure('WORD_COUNT_WORKER_FAILED', hostile)
      return touched
    },
    worker: () => {
      const worker = {}
      const event = new ErrorEvent('error', {
        message: 'PRIVATE_WORKER_MESSAGE',
        filename: new URL('./harness.js', location.href).href,
        lineno: 10,
        colno: 20,
      })
      reportRendererFailure('SOURCE_WORKER_FAILED', event, worker)
      reportRendererFailure('SOURCE_WORKER_FAILED', event, worker)
    },
    actualWorker: () =>
      new Promise<void>((resolve) => {
        const worker = new Worker(new URL('./worker.js', location.href), {
          type: 'module',
        })
        worker.onerror = (event) => {
          // Match the existing document worker owner's error propagation policy.
          event.preventDefault()
          reportRendererFailure('SOURCE_WORKER_FAILED', event, worker)
          worker.terminate()
          resolve()
        }
      }),
  },
})

function Harness() {
  const [failed, fail] = useState(false)
  if (failed) throw new Error('PRIVATE_REACT_MESSAGE')
  return (
    <button type="button" onClick={() => fail(true)}>
      Trigger render failure
    </button>
  )
}
const root = document.createElement('div')
document.body.append(root)
createRoot(root).render(
  <RecoveryBoundary>
    <Harness />
  </RecoveryBoundary>,
)
