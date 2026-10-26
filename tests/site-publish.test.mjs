import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { SiteMedia } from '../src/addons/documentation/site-media.ts'
import { publishSiteFolder } from '../src/addons/documentation/site-publish.ts'

test('folder publication syncs copies and new directories before its entrypoint, at most sixteen files at once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-site-publish-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const staged = join(root, 'staged')
  const destination = join(root, 'output')
  await mkdir(join(staged, 'nested'), { recursive: true })
  await mkdir(destination)
  const files = [{ path: 'index.html', bytes: 5 }]
  await writeFile(join(staged, 'index.html'), 'index')
  for (let index = 0; index < 33; index++) {
    const path = 'nested/' + index + '.html'
    files.push({ path, bytes: 4 })
    await writeFile(join(staged, path), 'page')
  }
  const fs = process.getBuiltinModule('node:fs/promises')
  const original = fs.open
  const synced = []
  let active = 0,
    peak = 0
  fs.open = async (path, ...args) => {
    const file = await original(path, ...args)
    const sync = file.sync.bind(file)
    file.sync = async () => {
      active++
      peak = Math.max(peak, active)
      try {
        await new Promise(setImmediate)
        await sync()
        synced.push(
          relative(destination, path).split(String.fromCharCode(92)).join('/'),
        )
      } finally {
        active--
      }
    }
    return file
  }
  syncBuiltinESMExports()
  try {
    await publishSiteFolder(
      staged,
      destination,
      files,
      new SiteMedia('hibi-assets', false, new AbortController().signal),
    )
  } finally {
    fs.open = original
    syncBuiltinESMExports()
  }
  assert.ok(peak > 1 && peak <= 16, peak + ' concurrent syncs')
  const entry = synced.findIndex((path) =>
    /^\.index\.html\..*\.tmp$/.test(path),
  )
  assert.ok(entry >= 33)
  for (let index = 0; index < 33; index++)
    assert.ok(synced.indexOf('nested/' + index + '.html') < entry)
  if (process.platform !== 'win32') assert.ok(synced.indexOf('nested') < entry)
  assert.equal(await readFile(join(destination, 'index.html'), 'utf8'), 'index')
})
