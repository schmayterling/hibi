import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('public documentation exports exclude agent notes', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-docs-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  await mkdir(join(folder, 'ai-agents'))
  const source =
    '---\ntitle: Getting started\ndescription: Public guide.\n---\n\n# User guide\n\n[Source](https://github.com/schmayterling/hibi/blob/main/src/addons/api.ts)'
  await writeFile(join(folder, 'README.md'), source)
  await writeFile(join(folder, 'ai-agents', 'README.md'), '# Internal notes')
  const output = join(folder, 'index.html')
  const revision = 'a'.repeat(40)
  execFileSync(process.execPath, ['scripts/export-docs.mjs', folder, output], {
    env: { ...process.env, HIBI_SOURCE_REVISION: revision },
  })
  const html = await readFile(output, 'utf8')
  const data = JSON.parse(
    html.match(/<script id="workspace-data"[^>]*>([\s\S]*?)<\/script>/)[1],
  )
  assert.deepEqual(
    data.pages.map((page) => page.path),
    ['README.md'],
  )
  assert.equal(data.pages[0].markdown, source)
  assert.equal(data.pages[0].title, 'Getting started')
  assert.ok(data.pages[0].html.includes(`/blob/${revision}/src/addons/api.ts`))
  assert.doesNotMatch(data.pages[0].html, /title:|description:/)
  const staticOutput = join(folder, 'website')
  const args = [
    'scripts/export-docs.mjs',
    folder,
    staticOutput,
    '--static',
    '--url',
    'https://example.com/docs/',
  ]
  execFileSync(process.execPath, args)
  assert.match(
    await readFile(join(staticOutput, 'README.md', 'index.html'), 'utf8'),
    /<h1[^>]*>User guide<\/h1>/,
  )
  assert.match(
    await readFile(join(staticOutput, 'sitemap.xml'), 'utf8'),
    /<loc>https:\/\/example.com\/docs\/<\/loc>/,
  )
  assert.throws(
    () => execFileSync(process.execPath, args, { stdio: 'pipe' }),
    /new output folder/i,
  )
})
