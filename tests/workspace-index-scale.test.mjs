import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'

const syntaxSnapshot = {
  version: 1,
  flavorRevision: 1,
  featureRevision: 1,
  flavors: [
    { id: 'markdown.github', kind: 'dialect', parserVersion: '1' },
    { id: 'markdown.obsidian', kind: 'syntax', parserVersion: '1' },
  ],
  features: [],
  projections: [{ id: 'frontmatter.metadata', parserVersion: '1' }],
  choices: [],
  hashtags: true,
  complete: true,
}

test('workspaces beyond 2000 notes and 20 MiB index completely and reopen from derived cache', {
  timeout: 60000,
}, async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-index-scale-')),
  )
  const notes = join(directory, 'notes')
  const profile = join(directory, 'profile')
  await mkdir(notes)
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ graph: false, tags: false, math: false, mermaid: false }),
  )
  let bytes = 0
  for (let i = 0; i < 2110; i++) {
    const source = `# note ${i}\n\n#work [[note-00000]]\n\n${'body '.repeat(2048)}`
    bytes += Buffer.byteLength(source)
    await writeFile(
      join(notes, `note-${String(i).padStart(5, '0')}.md`),
      source,
    )
  }
  assert.ok(bytes > 20 * 1024 * 1024)
  let app
  t.after(async () => {
    if (app) await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  const launch = async () => {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
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
      globalThis.scaleSourceReads = 0
      globalThis.scaleFileParses = 0
      globalThis.scaleCacheBatches = 0
      const Worker = process.getBuiltinModule('node:worker_threads').Worker
      const postMessage = Worker.prototype.postMessage
      Worker.prototype.postMessage = function (message, ...args) {
        if (message.kind === 'fileStart') globalThis.scaleFileParses++
        if (message.kind === 'cachedBatch') globalThis.scaleCacheBatches++
        return postMessage.call(this, message, ...args)
      }
      fs.open = (...args) => {
        if (
          String(args[0]).startsWith(notes) &&
          String(args[0]).endsWith('.md')
        )
          globalThis.scaleSourceReads++
        return open(...args)
      }
      process.getBuiltinModule('node:module').syncBuiltinESMExports()
    }, notes)
    return page
  }
  let page = await launch()
  await assert.rejects(
    page.evaluate(() => window.hibi.getWorkspaceIndex()),
    /legacy workspace index exceeds the 20 MiB message limit/,
  )

  await app.evaluate(() => {
    globalThis.scaleSourceReads = 0
  })
  const tail = async () =>
    page.evaluate(async (syntaxSnapshot) => {
      const { target } = await window.hibi.getWorkspaceChangeSnapshot()
      return window.hibi.queryWorkspaceReferences({
        target,
        syntaxSnapshot,
        kind: 'tag',
        tag: 'work',
        offset: 2100,
        limit: 100,
      })
    }, syntaxSnapshot)
  let result = await tail()
  assert.equal(result.ok, true)
  assert.equal(result.value.complete, true)
  assert.equal(result.value.items.length, 10)
  assert.equal(result.value.hasMore, false)
  assert.equal(await app.evaluate(() => globalThis.scaleSourceReads), 0)
  assert.equal(await app.evaluate(() => globalThis.scaleFileParses), 2110)
  assert.equal(await app.evaluate(() => globalThis.scaleCacheBatches), 33)
  await app.close()
  app = null
  page = await launch()
  result = await tail()
  assert.equal(result.ok, true)
  assert.equal(result.value.complete, true)
  assert.equal(result.value.items.length, 10)
  assert.equal(await app.evaluate(() => globalThis.scaleSourceReads), 0)
  assert.equal(await app.evaluate(() => globalThis.scaleFileParses), 0)
  assert.equal(await app.evaluate(() => globalThis.scaleCacheBatches), 33)
})
