import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import test from 'node:test'
import { writeInputProfile } from '../scripts/benchmark-flows.mjs'

test('comparison samplers carry every local helper they import', async () => {
  const workflow = await readFile('.github/workflows/benchmarks.yml', 'utf8')
  const copied = new Set(workflow.match(/for file in (.+); do/)[1].split(/\s+/))
  for (const file of copied) {
    const source = await readFile(file, 'utf8')
    for (const [, dependency] of source.matchAll(/from ['"](\.[^'"]+)['"]/g)) {
      const target = posix.normalize(
        posix.join(posix.dirname(file), dependency),
      )
      assert.ok(
        copied.has(target),
        `Comparison sampler imports uncopied helper: ${target}`,
      )
    }
  }
})

for (const [name, requested, analysisLoad, expected] of [
  [
    'requested addons',
    ['graph', 'keybeats'],
    false,
    { graph: true, keybeats: true },
  ],
  ['analysis only', [], true, { 'analysis-load': true }],
  [
    'requested addons with analysis',
    ['graph', 'keybeats'],
    true,
    { graph: true, keybeats: true, 'analysis-load': true },
  ],
  [
    'duplicate addon requests with analysis',
    ['graph', 'graph', 'analysis-load'],
    true,
    { graph: true, 'analysis-load': true },
  ],
  ['default addons', [], false, null],
]) {
  test(`input profile composes ${name}`, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-input-fixture-'))
    t.after(() => rm(profile, { recursive: true, force: true }))
    await writeInputProfile(profile, requested, analysisLoad)
    const enabled = await readFile(join(profile, 'addons.json'), 'utf8').then(
      JSON.parse,
      (error) => {
        if (error.code === 'ENOENT') return null
        throw error
      },
    )
    assert.deepEqual(enabled, expected)
    if (analysisLoad) {
      const folder = join(profile, 'installed-addons', 'analysis-load')
      const manifest = JSON.parse(
        await readFile(join(folder, 'hibi-addon.json'), 'utf8'),
      )
      const inventory = JSON.parse(
        await readFile(join(folder, '.hibi-install.json'), 'utf8'),
      )
      assert.equal(manifest.id, 'analysis-load')
      assert.deepEqual(manifest.analysis, { entry: 'analysis.js' })
      assert.equal(inventory.hash, 'a'.repeat(64))
      for (const file of inventory.files)
        assert.ok(await readFile(join(folder, file), 'utf8'))
    }
  })
}
