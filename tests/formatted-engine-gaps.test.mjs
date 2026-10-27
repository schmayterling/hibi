import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

test('formatted product gaps are counted and ledgered before the default changes', async (t) => {
  const directory = new URL('.', import.meta.url)
  const gaps = []
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.test.mjs')) continue
    const source = await readFile(new URL(file, directory), 'utf8')
    for (const match of source.matchAll(
      /formatted gap ([a-z0-9-]+): ([^'"\n]+)/g,
    ))
      gaps.push({
        id: match[1],
        file,
        line: source.slice(0, match.index).split('\n').length,
      })
  }
  assert.equal(
    new Set(gaps.map(({ id }) => id)).size,
    gaps.length,
    'gap ids must be unique',
  )
  const ledger = await readFile(
    new URL('formatted-engine-gaps.md', directory),
    'utf8',
  )
  const ledgerIds = [...ledger.matchAll(/^\| ([a-z][a-z0-9-]*) \|/gm)].map(
    (match) => match[1],
  )
  assert.deepEqual(gaps.map(({ id }) => id).sort(), ledgerIds.sort())
  for (const gap of gaps)
    assert.ok(
      ledger.includes(`${gap.file}:${gap.line}`),
      `${gap.id} needs its current test location`,
    )
  t.diagnostic(
    `${gaps.length} formatted gap todo annotations; the default flip requires zero`,
  )
  if (process.env.HIBI_EXPECT_FORMATTED_GAPS !== undefined)
    assert.equal(gaps.length, Number(process.env.HIBI_EXPECT_FORMATTED_GAPS))
})
