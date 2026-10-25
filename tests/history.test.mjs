import assert from 'node:assert/strict'
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { electron, startupDiagnostics } from './electron.mjs'
import { pressShortcut, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('local history snapshots on save, previews, and restores without overwriting disk', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-history-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'original')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.historyWriteGate?.release()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, file)
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+o`)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'original',
  )
  await page.waitForFunction(
    () =>
      document.querySelector('.tiptap')?.textContent === 'original' &&
      document.querySelector('.tiptap')?.getAttribute('contenteditable') ===
        'true',
  )
  await replaceRichText(page, rich, 'saved change')
  await waitForAsync(page, async () => {
    const document = await window.hibi.getDocument()
    return document.dirty && document.markdown === 'saved change'
  })
  await app.evaluate(
    async (_electron, { profile, file }) => {
      const fs = process.getBuiltinModule('node:fs/promises')
      const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
      const { dirname, basename, join } = process.getBuiltinModule('node:path')
      const open = fs.open
      const counts = { syncs: [], indexWrites: 0 }
      fs.open = async (...args) => {
        const handle = await open(...args)
        const path = String(args[0])
        if (
          args[1] === 'wx' &&
          (path.startsWith(join(profile, 'history')) ||
            (dirname(path) === dirname(file) &&
              basename(path).startsWith(`.${basename(file)}.`)))
        ) {
          const kind = basename(path).startsWith('.index.json.')
            ? 'index'
            : path.startsWith(join(profile, 'history'))
              ? 'version'
              : 'document'
          const sync = handle.sync
          handle.sync = async () => {
            counts.syncs.push(kind)
            return sync.call(handle)
          }
          if (kind === 'index') {
            const write = handle.writeFile
            handle.writeFile = async (...args) => {
              counts.indexWrites++
              return write.apply(handle, args)
            }
          }
        }
        return handle
      }
      syncBuiltinESMExports()
      globalThis.historyWriteCounts = counts
    },
    { profile, file: await realpath(file) },
  )
  const takeWrites = () =>
    app.evaluate(() => {
      const counts = globalThis.historyWriteCounts
      const result = {
        syncs: counts.syncs.splice(0),
        indexWrites: counts.indexWrites,
      }
      counts.indexWrites = 0
      return result
    })
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(
    page,
    async () => (await window.hibi.listVersions()).length === 2,
  )
  assert.deepEqual(await takeWrites(), {
    syncs: ['document', 'version', 'version', 'index'],
    indexWrites: 1,
  })
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), 'saved change')
  const versions = await page.evaluate(() => window.hibi.listVersions())
  assert.equal(
    await page.evaluate((id) => window.hibi.previewVersion(id), versions[1].id),
    'original',
  )
  await pressShortcut(app, `${mod}+s`)
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') !== 'true',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.listVersions())).length,
    2,
  )
  assert.deepEqual(await takeWrites(), {
    syncs: ['document'],
    indexWrites: 0,
  })
  await assert.rejects(
    page.evaluate(() => window.hibi.previewVersion('../../note.md')),
    /This saved version is no longer available\./,
  )
  await pressShortcut(app, `${mod}+k`)
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('version history')
  await page.getByRole('option').first().waitFor()
  await page.keyboard.press('Enter')
  const history = page.getByRole('dialog', {
    name: /^version history$/i,
    exact: true,
  })
  await history
    .getByRole('navigation', { name: /saved versions/i })
    .getByRole('button')
    .last()
    .click()
    .catch(async (error) => {
      try {
        console.error(
          'history version click:',
          JSON.stringify(await startupDiagnostics(app, page)),
        )
      } catch {}
      throw error
    })
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="version preview" i]').textContent ===
      'original',
  )
  await history.getByRole('button', { name: /restore to editor/i }).click()
  await waitForAsync(page, async () => {
    const doc = await window.hibi.getDocument()
    return doc.dirty && doc.markdown === 'original'
  })
  assert.equal(await readFile(file, 'utf8'), 'saved change')
  await history.waitFor({ state: 'hidden' })
  await page.waitForFunction(
    () =>
      document.querySelector('.app').getAttribute('aria-busy') === 'false' &&
      document.querySelector('.tiptap')?.textContent === 'original' &&
      document.querySelector('.tiptap')?.getAttribute('contenteditable') ===
        'true',
  )
  await replaceRichText(page, rich, 'unsaved buffer')
  await waitForAsync(page, async () => {
    const document = await window.hibi.getDocument()
    return document.dirty && document.markdown === 'unsaved buffer'
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 2 })
  })
  assert.equal(
    await page.evaluate((id) => window.hibi.restoreVersion(id), versions[1].id),
    null,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'unsaved buffer',
  )
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  // Hold the history commit so reads can prove they wait for the save.
  await app.evaluate(() => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
    const rename = fs.rename
    let release = () => {}
    let reached = false
    fs.rename = async (from, to) => {
      if (String(to).endsWith('index.json')) {
        reached = true
        await new Promise((resolve) => {
          release = resolve
        })
      }
      return rename(from, to)
    }
    syncBuiltinESMExports()
    globalThis.historyWriteGate = {
      get reached() {
        return reached
      },
      release: () => {
        fs.rename = rename
        syncBuiltinESMExports()
        release()
      },
    }
  })
  await page.evaluate(() => {
    window.historySave = window.hibi.saveDocument(false)
  })
  const started = performance.now()
  while (!(await app.evaluate(() => globalThis.historyWriteGate.reached))) {
    assert.ok(
      performance.now() - started < 10000,
      'history write did not pause',
    )
    await delay(20)
  }
  await page.evaluate((id) => {
    window.historyList = window.hibi.listVersions()
    window.historyPreview = window.hibi.previewVersion(id)
  }, versions[1].id)
  assert.deepEqual(
    await page.evaluate(() =>
      Promise.all(
        [window.historyList, window.historyPreview].map((read) =>
          Promise.race([
            read.then(() => 'resolved'),
            new Promise((resolve) => setTimeout(() => resolve('pending'), 250)),
          ]),
        ),
      ),
    ),
    ['pending', 'pending'],
  )
  await app.evaluate(() => globalThis.historyWriteGate.release())
  assert.equal((await page.evaluate(() => window.historySave)).dirty, false)
  const [savedVersions, preview] = await page.evaluate(() =>
    Promise.all([window.historyList, window.historyPreview]),
  )
  assert.equal(savedVersions.length, 3)
  assert.equal(preview, 'original')
  assert.deepEqual(await takeWrites(), {
    syncs: ['document', 'version', 'index'],
    indexWrites: 1,
  })

  for (const failure of ['copy', 'index', 'index-cleanup'])
    await t.test(
      `history preserves published versions after ${failure} failure`,
      async (t) => {
        const previous = `external content before ${failure} failure`
        const content = `saved despite ${failure} failure`
        await replaceRichText(page, rich, content)
        await waitForAsync(
          page,
          async (content) => {
            const document = await window.hibi.getDocument()
            return document.dirty && document.markdown === content
          },
          content,
        )
        await writeFile(file, previous)
        const before = await page.evaluate(() => window.hibi.listVersions())
        await app.evaluate(
          ({ dialog }, { profile, failure }) => {
            const fs = process.getBuiltinModule('node:fs/promises')
            const { syncBuiltinESMExports } =
              process.getBuiltinModule('node:module')
            const { basename, join } = process.getBuiltinModule('node:path')
            const open = fs.open
            const unlink = fs.unlink
            let copies = 0
            fs.open = async (...args) => {
              const path = String(args[0])
              if (
                args[1] === 'wx' &&
                path.startsWith(join(profile, 'history'))
              ) {
                const index = basename(path).startsWith('.index.json.')
                if (
                  (failure === 'index' && index) ||
                  (failure === 'copy' && !index && ++copies === 2)
                )
                  throw Object.assign(
                    new Error('ENOSPC: no space left on device'),
                    {
                      code: 'ENOSPC',
                    },
                  )
              }
              return open(...args)
            }
            fs.unlink = async (path) => {
              if (
                failure === 'index-cleanup' &&
                basename(path).startsWith('.index.json.')
              )
                throw Object.assign(
                  new Error('EIO: index staging cleanup failed'),
                  {
                    code: 'EIO',
                  },
                )
              return unlink(path)
            }
            dialog.showMessageBox = async () => ({ response: 0 })
            globalThis.restoreHistoryFailure = () => {
              fs.open = open
              fs.unlink = unlink
              syncBuiltinESMExports()
              dialog.showMessageBox = async () => ({ response: 1 })
            }
            syncBuiltinESMExports()
          },
          { profile, failure },
        )
        t.after(() => app.evaluate(() => globalThis.restoreHistoryFailure()))
        const saved = await page.evaluate(() => window.hibi.saveDocument(false))
        await app.evaluate(() => globalThis.restoreHistoryFailure())
        assert.equal(saved.dirty, false)
        assert.equal(saved.savedMarkdown, content)
        assert.equal(await readFile(file, 'utf8'), content)
        const after = await page.evaluate(() => window.hibi.listVersions())
        if (failure === 'copy') {
          await page
            .getByText(
              'File saved, but Hibi could not add it to version history.',
            )
            .last()
            .waitFor()
          assert.equal(after.length, before.length + 1)
          assert.equal(
            await page.evaluate(
              (id) => window.hibi.previewVersion(id),
              after[0].id,
            ),
            previous,
          )
        } else if (failure === 'index') assert.deepEqual(after, before)
        else assert.equal(after.length, before.length + 2)
        const history = join(profile, 'history')
        const [folder] = await readdir(history)
        assert.deepEqual(
          (await readdir(join(history, folder)))
            .filter((name) => name.endsWith('.md'))
            .sort(),
          after.map(({ id }) => `${id}.md`).sort(),
        )
      },
    )

  await replaceRichText(page, rich, 'saved after history failures')
  await waitForAsync(page, async () => {
    const document = await window.hibi.getDocument()
    return (
      document.dirty && document.markdown === 'saved after history failures'
    )
  })
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.ok(
    (
      await page.evaluate(async () =>
        Promise.all(
          (
            await window.hibi.listVersions()
          ).map(({ id }) => window.hibi.previewVersion(id)),
        ),
      )
    ).includes('external content before copy failure'),
  )

  await t.test('history failure still saves and notifies', async () => {
    await rm(join(profile, 'history'), { recursive: true })
    await writeFile(join(profile, 'history'), 'blocked')
    const content = 'saved without history'
    await replaceRichText(page, rich, content)
    await waitForAsync(
      page,
      async (content) => (await window.hibi.getDocument()).markdown === content,
      content,
    )
    const saved = await page.evaluate(() => window.hibi.saveDocument(false))
    assert.equal(saved.dirty, false)
    assert.equal(saved.savedMarkdown, content)
    assert.equal(await readFile(file, 'utf8'), content)
    await page
      .getByText('File saved, but Hibi could not add it to version history.')
      .last()
      .waitFor()
  })
})
