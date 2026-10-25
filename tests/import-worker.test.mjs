import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { importText } from '../src/addons/_shared/import-markdown.ts'
import {
  packImportEntries,
  unpackImportEntries,
} from '../src/addons/_shared/import-packet.ts'
import {
  runImportWorker,
  streamImportWorker,
} from '../src/addons/_shared/import-worker-client.ts'
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
      file('only-text.txt', 'bear plain text stays intact'),
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
test('worker messages use at most one transfer per packet', async (t) => {
  const transfers = []
  const postMessage = Worker.prototype.postMessage
  t.mock.method(Worker.prototype, 'postMessage', function (message, buffers) {
    transfers.push(buffers?.length ?? 0)
    return postMessage.call(this, message, buffers)
  })
  const files = Array.from({ length: 2500 }, (_, index) =>
    file(index % 2 ? `assets/${index}.png` : `notes/${index}.md`, ''),
  )
  await runImportWorker(workerPath, 'obsidian', files)
  assert.ok(transfers.length > 2)
  assert.ok(transfers.every((count) => count <= 1))
})
test('packed files share one byte buffer and missing attachment bytes fail closed', () => {
  const entries = Array.from({ length: 10001 }, (_, index) =>
    index % 2
      ? { path: `${index}.png`, original: index }
      : file(`${index}.md`, 'note'),
  )
  const packet = packImportEntries(entries)
  assert.ok(packet.bytes instanceof ArrayBuffer)
  const unpacked = unpackImportEntries(packet)
  for (let index = 0; index < entries.length; index++)
    if (entries[index].data) {
      assert.equal(unpacked[index].data.buffer, packet.bytes)
      assert.equal(Buffer.from(unpacked[index].data).toString(), 'note')
    } else assert.equal('data' in unpacked[index], false)
  assert.throws(() => importText({ path: 'missing.md' }), /unsafe/)
  assert.throws(() => packImportEntries([{ path: 'rewrapped.png' }]), /unsafe/)
})
test('aborting an active conversion rejects its request before any output is written', async (t) => {
  const controller = new AbortController()
  const postMessage = Worker.prototype.postMessage
  t.mock.method(Worker.prototype, 'postMessage', function (message, buffers) {
    const result = postMessage.call(this, message, buffers)
    if (message.type === 'files') controller.abort()
    return result
  })
  let writes = 0
  await assert.rejects(
    streamImportWorker(workerPath, 'obsidian', {
      paths: ['note.md'],
      signal: controller.signal,
      read: async () => Buffer.from('[[#heading]]'),
      write: async () => {
        writes++
      },
    }),
    { name: 'AbortError' },
  )
  assert.equal(writes, 0)
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
