import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'

test('queued workspace opens stop obsolete traversal and open only the latest intent', {
  timeout: 30000,
}, async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-open-intents-')),
  )
  const slow = join(directory, 'slow')
  const latest = join(directory, 'latest')
  await mkdir(slow)
  await mkdir(latest)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(directory, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await app.evaluate(
    ({ dialog, ipcMain }, { slow, latest }) => {
      const host = { dialogs: 0, intents: 0, read: 0, closed: 0 }
      host.started = new Promise((resolve) => {
        host.start = resolve
      })
      host.received = new Promise((resolve) => {
        host.receive = resolve
      })
      host.held = new Promise((resolve) => {
        host.release = resolve
      })
      globalThis.openIntents = host
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [host.dialogs++ === 0 ? slow : latest],
      })
      const handlers = ipcMain._invokeHandlers
      const open = handlers.get('workspace:open')
      handlers.set('workspace:open', (...args) => {
        const result = open(...args)
        if (++host.intents === 4) host.receive()
        return result
      })
      const fs = process.getBuiltinModule('node:fs/promises')
      const original = fs.opendir
      fs.opendir = async (path, ...args) =>
        path !== slow
          ? original(path, ...args)
          : {
              async *[Symbol.asyncIterator]() {
                try {
                  for (let i = 0; i < 10000; i++) {
                    host.read++
                    if (i === 0) {
                      host.start()
                      await host.held
                    }
                    yield {
                      name: `file-${i}.unsupported`,
                      isDirectory: () => false,
                      isSymbolicLink: () => false,
                      isFile: () => true,
                    }
                  }
                } finally {
                  host.closed++
                }
              },
            }
      process.getBuiltinModule('node:module').syncBuiltinESMExports()
    },
    { slow, latest },
  )
  const first = page.evaluate(() => window.hibi.openWorkspace())
  await app.evaluate(async () => {
    await globalThis.openIntents.started
  })
  await page.evaluate(() => {
    globalThis.pendingOpens = Array.from({ length: 3 }, () =>
      window.hibi.openWorkspace(),
    )
  })
  await app.evaluate(async () => {
    await globalThis.openIntents.received
    globalThis.openIntents.release()
  })
  await first
  const opened = await page.evaluate(() => Promise.all(globalThis.pendingOpens))
  assert.equal(opened.at(-1).name, 'latest')
  assert.deepEqual(
    await app.evaluate(() => {
      const { dialogs, read, closed } = globalThis.openIntents
      return { dialogs, read, closed }
    }),
    { dialogs: 2, read: 1, closed: 1 },
  )
})

test('an open request cannot cancel relocation reload and a canceled dialog leaves the moved workspace usable', {
  timeout: 30000,
}, async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-relocate-open-')),
  )
  const profile = join(directory, 'profile')
  const from = join(directory, 'notes')
  const parent = join(directory, 'destination')
  const to = join(parent, 'notes')
  for (const path of [profile, from, parent]) await mkdir(path)
  await writeFile(join(from, 'note.md'), '# note')
  await writeFile(
    join(profile, 'workspace-settings.json'),
    JSON.stringify({
      enabled: true,
      showAllFiles: false,
      path: from,
      startup: 'empty',
      startupFolder: null,
    }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, from) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [from] })
  }, from)
  await page.evaluate(() => window.hibi.openWorkspace())
  await app.evaluate(
    ({ dialog, ipcMain }, { parent, to }) => {
      const host = {}
      host.started = new Promise((resolve) => {
        host.start = resolve
      })
      host.received = new Promise((resolve) => {
        host.receive = resolve
      })
      host.held = new Promise((resolve) => {
        host.release = resolve
      })
      globalThis.relocateOpen = host
      dialog.showOpenDialog = async (_window, options) =>
        options.title === 'Open workspace'
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [parent] }
      const handlers = ipcMain._invokeHandlers
      const open = handlers.get('workspace:open')
      handlers.set('workspace:open', (...args) => {
        const result = open(...args)
        host.receive()
        return result
      })
      const fs = process.getBuiltinModule('node:fs/promises')
      const opendir = fs.opendir
      let held = false
      fs.opendir = async (path, ...args) => {
        if (path === to && !held) {
          held = true
          host.start()
          await host.held
        }
        return opendir(path, ...args)
      }
      process.getBuiltinModule('node:module').syncBuiltinESMExports()
    },
    { parent, to },
  )
  const relocating = page.evaluate(() =>
    window.hibi.updateWorkspaceSettings({ action: 'relocate' }),
  )
  await app.evaluate(async () => {
    await globalThis.relocateOpen.started
  })
  const opening = page.evaluate(() => window.hibi.openWorkspace())
  await app.evaluate(async () => {
    await globalThis.relocateOpen.received
    globalThis.relocateOpen.release()
  })
  assert.equal((await relocating).path, to)
  assert.equal(await opening, null)
  assert.equal(
    (await page.evaluate(() => window.hibi.getWorkspace())).id,
    createHash('sha256').update(to).digest('hex'),
  )
  await page.evaluate(() => window.hibi.refreshWorkspace())
  assert.equal(
    (await page.evaluate(() => window.hibi.getWorkspaceSettings())).currentPath,
    to,
  )
  assert.ok(
    (await page.evaluate(() => window.hibi.getKnownWorkspaces())).some(
      (item) => item.path === to,
    ),
  )
})
