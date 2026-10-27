import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

test('575 kb source-first samples record real capability and continue to editable samples', async (t) => {
  await mkdir('test-results', { recursive: true })
  const directory = await mkdtemp(
    resolve('test-results/editor-benchmark-native-'),
  )
  // Keep provenance and traces for inspection alongside the benchmark report.
  t.diagnostic(directory)
  const env = { ...process.env }
  delete env.GITHUB_ACTIONS
  delete env.HIBI_TEST_SHOW_WINDOWS
  await promisify(execFile)(
    process.execPath,
    [
      'scripts/benchmark-editors.mjs',
      '--runs',
      '2',
      '--keys',
      '2',
      '--scroll-frames',
      '2',
      '--sizes',
      '575kb,100kb',
      '--fixtures',
      'prose',
      '--out',
      directory,
    ],
    { env },
  )
  const report = JSON.parse(
    await readFile(join(directory, 'results.json'), 'utf8'),
  )
  assert.equal(report.samples.length, 8)
  assert.deepEqual(
    report.samples.map(({ engine }) => engine),
    [
      'tiptap',
      'codemirror',
      'codemirror',
      'tiptap',
      'tiptap',
      'codemirror',
      'codemirror',
      'tiptap',
    ],
  )
  assert.ok(
    report.samples.every(
      ({ status }) => status === 'complete' || status === 'unavailable',
    ),
  )
  assert.ok(
    report.samples.slice(4).every(({ status }) => status === 'complete'),
  )
  for (const sample of report.samples) {
    const events = JSON.parse(
      await readFile(join(directory, sample.trace), 'utf8'),
    ).traceEvents
    assert.ok(events.some(({ name }) => name === 'open:ready'))
    if (sample.status === 'unavailable') {
      assert.equal(sample.open.method, 'n/a')
      assert.equal(sample.open.readyMs, null)
      assert.equal(sample.open.paintMs, null)
      assert.deepEqual(sample.keys, [])
      assert.equal(sample.find, null)
      assert.equal(sample.scroll, null)
      assert.equal(sample.integrity.actualHash, report.fixtures[0].sha256)
      assert.equal(sample.integrity.expectedHash, report.fixtures[0].sha256)
      if (sample.engine === 'tiptap') {
        assert.equal(sample.open.afterSwitch.preview, true)
        assert.equal(sample.open.afterSwitch.editable, false)
        assert.ok(events.some(({ name }) => name === 'switch:unavailable'))
        assert.ok(!events.some(({ name }) => name === 'switch:ready'))
      } else assert.equal(sample.open.dependency, '#450')
    } else {
      assert.equal(sample.keys.length, 2)
      assert.equal(sample.integrity.actualHash, sample.integrity.expectedHash)
      assert.ok(
        sample.keys.every(
          ({ taskMs, readyMs }) =>
            Number.isFinite(taskMs) && Number.isFinite(readyMs),
        ),
      )
      assert.equal(sample.scroll.requestedPx, 3600)
      assert.ok(sample.scroll.actualPx > 0)
      assert.equal(sample.scroll.frames.length, 2)
      assert.equal(sample.scroll.mainThreadPerFrameMs, sample.scroll.taskMs / 2)
    }
  }
  const table = await readFile(join(directory, 'table.md'), 'utf8')
  assert.ok(table.includes('unavailable'))
  assert.equal(
    report.status,
    report.samples.some(({ status }) => status === 'unavailable')
      ? 'partial'
      : 'complete',
  )
})
