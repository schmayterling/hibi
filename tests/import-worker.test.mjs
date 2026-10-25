import assert from 'node:assert/strict'
import test from 'node:test'
import { runImportWorker } from '../src/addons/_shared/import-worker-client.ts'
import { importBear } from '../src/addons/import-bear/convert.ts'
import { importNotion } from '../src/addons/import-notion/convert.ts'
import { importObsidian } from '../src/addons/import-obsidian/convert.ts'

const workerPath = new URL(
  '../src/addons/_shared/import-worker.ts',
  import.meta.url,
)
const file = (path, text) => ({ path, data: Buffer.from(text) })
const snapshot = (result) => ({
  ...result,
  files: result.files.map(({ path, data }) => ({
    path,
    data: Buffer.from(data).toString('base64'),
  })),
})
test('import workers preserve converter results, warnings, and original assets', async () => {
  for (const [format, convert] of [
    ['obsidian', importObsidian],
    ['bear', importBear],
    ['notion', importNotion],
  ]) {
    const files = [
      file(
        'notes/Start.md',
        '![[Target]] [[Missing]] bear://note/id [Tasks](../Tasks.csv)',
      ),
      file('Target.md', '# Target'),
      file('Tasks.csv', 'Name,Description\nA,B\n'),
      file('Note.textbundle/text.md', '[[Target]]'),
      file('Note.textbundle/info.json', '{}'),
      file('images/a.png', Buffer.from([0, 255, 1, 2])),
    ]
    const before = snapshot({ files })
    const expected = await convert(files)
    const result = await runImportWorker(workerPath, format, files)
    assert.deepEqual(snapshot(result), snapshot(expected), format)
    assert.equal(
      result.files.find((item) => item.path === 'images/a.png'),
      files.at(-1),
    )
    assert.deepEqual(snapshot({ files }), before)
  }
})
test('import workers keep the main event loop running for a single large note', async () => {
  let turns = 0,
    immediate
  const tick = () => {
    turns++
    immediate = setImmediate(tick)
  }
  tick()
  try {
    const result = await runImportWorker(workerPath, 'obsidian', [
      file('note.md', 'ordinary words [[#heading]]\n\n'.repeat(8000)),
    ])
    assert.equal(result.files.length, 1)
    assert.ok(turns > 1)
  } finally {
    clearImmediate(immediate)
  }
})
test('import worker failures preserve decoder and format errors', async () => {
  await assert.rejects(
    runImportWorker(workerPath, 'obsidian', [
      file('bad.md', Buffer.from([255])),
    ]),
    /encoded data was not valid/,
  )
  await assert.rejects(
    runImportWorker(workerPath, 'notion', [file('nested.zip', '')]),
    /Choose a Notion/,
  )
  await assert.rejects(
    runImportWorker(workerPath, 'obsidian', [
      file('large.md', Buffer.alloc(2 * 1024 * 1024 + 1)),
    ]),
    /2 MiB editing limit/,
  )
})
