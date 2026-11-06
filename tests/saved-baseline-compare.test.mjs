import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

// The main process's document module with real files and history; only
// electron is stood in for, and the note's final rename can be held or fail.
const root = await fs.realpath(
  await fs.mkdtemp(join(tmpdir(), 'hibi-saved-baseline-')),
)
let rename = null
const io = {
  ...fs,
  rename: async (from, to) => {
    const step = rename
    if (step && String(to) === step.file) {
      rename = null
      await step.run()
    }
    return fs.rename(from, to)
  },
}
const bundle = await build({
  stdin: {
    contents: "export * from './src/main/document.ts'",
    resolveDir: resolve('.'),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})
const module = { exports: {} },
  require = createRequire(import.meta.url)
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  (id) =>
    id === 'electron'
      ? {
          app: { getPath: () => root },
          dialog: { showMessageBox: async () => ({ response: 0 }) },
        }
      : id === 'node:fs/promises'
        ? io
        : require(id),
  module,
  module.exports,
)
const document = module.exports
const window = {
  isDestroyed: () => false,
  setDocumentEdited() {},
  webContents: { send() {} },
  setRepresentedFilename() {},
  setTitle() {},
}
test.after(() => fs.rm(root, { recursive: true, force: true }))

let notes = 0
async function note(text) {
  const file = join(root, `note-${notes++}.md`)
  await fs.writeFile(file, text)
  await document.loadDocument(window, file)
  return file
}
/** Replaces the note's text as an edit from the editor does. */
function edit(value) {
  const store = document.getDocumentSource(),
    before = store.snapshot()
  store.commit(
    store.prepare({
      document: before.document,
      operationId: crypto.randomUUID(),
      historyGroup: 'test',
      origin: 'source',
      baseVersion: before.version,
      contentVersion: before.version + 1,
      changes: [{ from: 0, to: before.utf16Length, insert: value }],
    }),
  )
  document.updateDocumentEdited(window)
}
/** Whether the note reads dirty once its scheduled comparison has had its tasks. */
async function settled() {
  for (let task = 0; task < 20 && document.getDocument().dirty; task++)
    await new Promise((done) => setTimeout(done, 0))
  return document.getDocument().dirty
}
/** Holds the note's final rename until `during` has run; `entered` says whether the save reached it. */
function holdWrite(file, during) {
  let entered = false
  const done = Promise.withResolvers()
  rename = {
    file,
    run: async () => {
      entered = true
      try {
        await during()
        done.resolve()
      } catch (error) {
        done.reject(error)
      }
    },
  }
  return { entered: () => entered, done: done.promise }
}
const text = 'same saved text\n'
const away = 'away saved text\n'

test('text edited back to what a save is writing reads saved once it lands', async () => {
  const file = await note(text)
  edit(away)
  edit(text)
  assert.equal(await settled(), false)
  const write = holdWrite(file, async () => {
    edit(away)
    edit(text)
    // Clean against the old baseline while the write is held.
    assert.equal(await settled(), false)
  })
  const saved = await document.saveDocument(window)
  assert.ok(write.entered())
  await write.done
  assert.ok(saved)
  assert.equal(await fs.readFile(file, 'utf8'), text)
  assert.equal(await settled(), false)
})

for (const via of ['an autosave', 'a target save'])
  test(`${via} whose text is edited away and back during the write reads saved`, async () => {
    const file = await note('old saved text\n')
    edit(text)
    assert.equal(await settled(), true)
    const { tabId, revision, contentVersion } = document.getDocument()
    const write = holdWrite(file, async () => {
      edit(away)
      edit(text)
    })
    const result =
      via === 'an autosave'
        ? await document.autosaveDocument(window, tabId, revision)
        : await document.saveTargetDocument(
            window,
            tabId,
            revision,
            contentVersion,
            () => true,
          )
    assert.equal(result.status, 'saved')
    assert.ok(write.entered())
    await write.done
    assert.equal(await fs.readFile(file, 'utf8'), text)
    assert.equal(await settled(), false)
  })

test('other text of the same length typed during a save stays unsaved', async () => {
  const file = await note(text)
  edit(away)
  // As long in UTF-16 and UTF-8 as the text saved, so the texts are compared.
  const other = 'away saved TEXT\n'
  const write = holdWrite(file, async () => edit(other))
  await document.saveDocument(window)
  assert.ok(write.entered())
  await write.done
  assert.equal(await fs.readFile(file, 'utf8'), away)
  assert.equal(await settled(), true)
  assert.equal(document.getDocument().markdown, other)
})

test('a failed write keeps the file and the unsaved text', async () => {
  const file = await note(text)
  edit(away)
  rename = {
    file,
    run: () =>
      Promise.reject(Object.assign(new Error('write failed'), { code: 'EIO' })),
  }
  await assert.rejects(document.saveDocument(window), /write failed/)
  assert.equal(await fs.readFile(file, 'utf8'), text)
  assert.equal(await settled(), true)
  assert.equal(document.getDocument().markdown, away)
})

test('a save with no edits during the write reads saved', async () => {
  const file = await note(text)
  edit(away)
  await document.saveDocument(window)
  assert.equal(await fs.readFile(file, 'utf8'), away)
  assert.equal(await settled(), false)
})
