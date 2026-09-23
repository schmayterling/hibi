import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  parseObsidianManifest,
  wrapObsidianPlugin,
} from '../src/addons/obsidian-plugin-loader/package.ts'
import {
  installObsidianPlugin,
  listObsidianPlugins,
  obsidianPluginAsset,
  readObsidianPackage,
  readObsidianPluginData,
  setObsidianPluginEnabled,
  writeObsidianPluginData,
} from '../src/addons/obsidian-plugin-loader/store.ts'

const manifest = {
  id: 'sample-plugin',
  name: 'Sample Plugin',
  version: '1.0.0',
  description: 'Sample plugin.',
  author: 'Obsidian',
  minAppVersion: '1.0.0',
  isDesktopOnly: false,
}

test('accepts browser-compatible Obsidian manifests and rejects unsafe packages', () => {
  assert.deepEqual(parseObsidianManifest(manifest), manifest)
  assert.throws(
    () => parseObsidianManifest({ ...manifest, id: '../other' }),
    /valid Obsidian plugin manifest/,
  )
  assert.throws(
    () => parseObsidianManifest({ ...manifest, isDesktopOnly: true }),
    /Node.js or Electron/,
  )
})

test('loads CommonJS plugin through the Obsidian API without eval', () => {
  let loaded
  const api = { Plugin: class Plugin {} }
  runInNewContext(
    wrapObsidianPlugin(
      "const { Plugin } = require('obsidian'); module.exports = class Example extends Plugin {};",
      'sample-plugin:hash',
    ),
    {
      globalThis: {
        __hibiObsidianApiFor: () => api,
        __hibiObsidianLoaded: (identity, exported) => {
          loaded = { identity, exported }
        },
      },
    },
  )
  assert.equal(loaded.identity, 'sample-plugin:hash')
  assert.equal(Object.getPrototypeOf(loaded.exported), api.Plugin)
  assert.throws(
    () =>
      runInNewContext(wrapObsidianPlugin("require('fs')", 'blocked'), {
        globalThis: { __hibiObsidianApiFor: () => api },
      }),
    /Unsupported Obsidian plugin import: fs/,
  )
})

test('installs plugin privately, serves only enabled version, and keeps data on replacement', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-obsidian-plugin-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const source = join(temp, 'source')
  const root = join(temp, 'installed')
  await mkdir(source)
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(
    join(source, 'main.js'),
    "module.exports = class Example extends require('obsidian').Plugin {}",
  )
  await writeFile(join(source, 'styles.css'), '.example { color: red }')
  const selected = await readObsidianPackage(source)
  const first = await installObsidianPlugin(root, selected)
  assert.equal(first.backup, null)
  assert.equal(first.plugin.enabled, false)
  assert.equal(await obsidianPluginAsset(root, first.plugin.url), null)
  const active = await setObsidianPluginEnabled(root, manifest.id, true)
  assert.match(
    await obsidianPluginAsset(root, active.url),
    /__hibiObsidianLoaded/,
  )
  assert.equal(
    await obsidianPluginAsset(root, active.styleUrl),
    '.example { color: red }',
  )
  await writeObsidianPluginData(root, manifest.id, { count: 3 })
  assert.deepEqual(await readObsidianPluginData(root, manifest.id), {
    count: 3,
  })
  await writeFile(join(source, 'main.js'), 'module.exports = class Updated {}')
  const second = await installObsidianPlugin(
    root,
    await readObsidianPackage(source),
  )
  assert.ok(second.backup)
  assert.equal(second.plugin.enabled, false)
  assert.equal(await obsidianPluginAsset(root, active.url), null)
  assert.deepEqual(await readObsidianPluginData(root, manifest.id), {
    count: 3,
  })
  assert.deepEqual(
    (await listObsidianPlugins(root)).map((plugin) => plugin.manifest.id),
    [manifest.id],
  )
  assert.match(
    await readFile(join(root, manifest.id, 'main.js'), 'utf8'),
    /Updated/,
  )
})

test('rejects symlinked plugin entry files', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-obsidian-plugin-link-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  await writeFile(join(temp, 'manifest.json'), JSON.stringify(manifest))
  await symlink(join(temp, 'manifest.json'), join(temp, 'main.js'))
  await assert.rejects(readObsidianPackage(temp), /unsupported file/)
})
