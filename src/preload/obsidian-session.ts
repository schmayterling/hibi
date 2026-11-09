import type { IpcRenderer } from 'electron'
import {
  OBSIDIAN_DESKTOP,
  type ObsidianWorkspaceSessionBridge,
} from '../shared/obsidian-desktop'

/** Both preloads use the same journal/session transfer. This never supplies Node to the sandbox. */
export function obsidianSession(
  transport: IpcRenderer,
  flush: () => Promise<void>,
): ObsidianWorkspaceSessionBridge {
  const captures = new Set<() => unknown | Promise<unknown>>()
  const resumes = new Set<(message?: string) => void>()
  transport.on(OBSIDIAN_DESKTOP.capture, (_event, token: string) => {
    void (async () => {
      await flush()
      if (captures.size !== 1)
        throw new Error(
          'Wait for the workspace to finish loading, then try again.',
        )
      const ui = await [...captures][0]!()
      await flush()
      transport.send(OBSIDIAN_DESKTOP.captured, token, ui, null)
    })().catch((error: unknown) => {
      transport.send(OBSIDIAN_DESKTOP.captured, token, null, String(error))
    })
  })
  transport.on(OBSIDIAN_DESKTOP.resume, (_event, message: unknown) => {
    for (const resume of resumes)
      resume(typeof message === 'string' ? message : undefined)
  })
  return {
    pending: process.argv.includes('--hibi-workspace-swap'),
    active:
      process.argv.includes('--hibi-workspace-swap') ||
      !process.contextIsolated,
    onCapture(callback) {
      captures.add(callback)
      return () => {
        captures.delete(callback)
      }
    },
    onResume(callback) {
      resumes.add(callback)
      return () => {
        resumes.delete(callback)
      }
    },
    restore: () => transport.invoke(OBSIDIAN_DESKTOP.restore),
    ready: () => transport.invoke(OBSIDIAN_DESKTOP.ready),
    switch: () => {
      transport.send(OBSIDIAN_DESKTOP.switch)
    },
    abort: (message) => {
      transport.send(OBSIDIAN_DESKTOP.abort, message)
    },
  }
}
