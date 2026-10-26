import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'

test('unchanged legacy bulk requests reuse bounded source text after the first read', {
  timeout: 30000,
}, async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-legacy-warm-')),
  )
  const notes = join(root, 'notes')
  const profile = join(root, 'profile')
  await mkdir(notes)
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ graph: false, tags: false, math: false, mermaid: false }),
  )
  for (let i = 0; i < 303; i++)
    await writeFile(join(notes, `note-${i}.md`), '# note')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, notes) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [notes],
    })
  }, notes)
  await page.evaluate(() => window.hibi.openWorkspace())
  await app.evaluate((_, notes) => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const open = fs.open
    globalThis.legacySourceReads = 0
    fs.open = (...args) => {
      if (String(args[0]).startsWith(notes) && String(args[0]).endsWith('.md'))
        globalThis.legacySourceReads++
      return open(...args)
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
  }, notes)
  const reads = []
  for (let i = 0; i < 3; i++) {
    const index = await page.evaluate(() => window.hibi.getWorkspaceIndex())
    assert.equal(index.pages.length, 303)
    reads.push(
      await app.evaluate(() => {
        const reads = globalThis.legacySourceReads
        globalThis.legacySourceReads = 0
        return reads
      }),
    )
  }
  assert.deepEqual(reads, [303, 0, 0])
  const verified = await page.evaluate(() =>
    window.hibi.getWorkspaceIndex(true),
  )
  assert.equal(verified.pages.length, 303)
  assert.equal(await app.evaluate(() => globalThis.legacySourceReads), 0)
})
