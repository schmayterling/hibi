import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['src/shared/addon-directory.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
})
const {
  addonGardenLink,
  directoryInstallUrl,
  directoryManifestMatches,
  parseAddonDirectory,
  parseAddonGardenLink,
} = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)

const metadata = {
  id: 'example',
  name: 'Example',
  description: 'Directory fixture',
  version: '1.0.0',
  apiVersion: 2,
  kind: 'extension',
  authors: [{ displayName: 'Author' }],
  license: 'MIT',
}
const commit = 'a'.repeat(40)
const entry = { ...metadata, path: 'addons/example' }

test('directory accepts mixed supported api versions and rejects malformed versions', () => {
  const entries = [1, 2, 3].map((apiVersion) => ({
    ...entry,
    id: `example-v${apiVersion}`,
    apiVersion,
  }))
  assert.deepEqual(parseAddonDirectory(entries), entries)
  for (const apiVersion of [0, -1, 3.1, '3', null, undefined])
    assert.throws(
      () => parseAddonDirectory([{ ...entry, apiVersion }]),
      /invalid entry/,
    )
})

test('a newer api entry does not hide supported garden entries', () => {
  const future = { ...entry, id: 'future', apiVersion: 4 }
  assert.deepEqual(parseAddonDirectory([entry, future]), [entry])
  assert.deepEqual(parseAddonDirectory([future, entry]), [entry])
  assert.deepEqual(parseAddonDirectory([future]), [])
})

test('directory sources bind repository commits or release bytes without granting trust', () => {
  const repository = {
    ...metadata,
    repository: {
      url: 'https://github.com/owner/repo',
      commit,
      path: 'nested/addon',
    },
  }
  const download = {
    ...metadata,
    download: {
      url: 'https://example.com/addon.zip',
      size: 123,
      sha256: 'a'.repeat(64),
    },
  }
  for (const value of [entry, repository, download])
    assert.deepEqual(parseAddonDirectory([value]), [value])
  assert.equal(
    directoryInstallUrl(entry),
    'https://github.com/hibigarden/addons-repository/tree/main/addons/example',
  )
  assert.equal(
    directoryInstallUrl(repository),
    `https://github.com/owner/repo/tree/${commit}/nested/addon`,
  )
  assert.equal(directoryInstallUrl(download), download.download.url)
  for (const bad of [
    { ...entry, signed: true },
    { ...entry, download: download.download },
    { ...metadata },
    { ...entry, path: '../escape' },
    { ...repository, repository: { ...repository.repository, commit: 'main' } },
    {
      ...repository,
      repository: { ...repository.repository, path: 'a/../escape' },
    },
    {
      ...repository,
      repository: {
        ...repository.repository,
        url: 'https://github.com/owner/../repo',
      },
    },
    { ...download, download: { ...download.download, size: 26 * 1024 * 1024 } },
    { ...download, download: { ...download.download, sha256: 'bad' } },
    {
      ...download,
      download: { ...download.download, url: 'http://example.com/addon.zip' },
    },
    { ...entry, homepage: 'https://user:secret@example.com' },
    { ...entry, authors: [] },
  ])
    assert.throws(() => parseAddonDirectory([bad]))
  assert.throws(() => parseAddonDirectory([entry, entry]), /invalid entry/)
  assert.throws(() => parseAddonDirectory({ addons: [entry] }), /invalid/)
})

test('directory package identity must match every listed manifest field', () => {
  assert.equal(directoryManifestMatches(entry, metadata), true)
  for (const [key, value] of Object.entries({
    id: 'other',
    name: 'Other',
    description: 'Other',
    version: '2.0.0',
    kind: 'theme',
    apiVersion: 1,
    authors: [{ displayName: 'Someone else' }],
  }))
    assert.equal(
      directoryManifestMatches(entry, { ...metadata, [key]: value }),
      false,
      key,
    )
  assert.equal(
    directoryManifestMatches(entry, { ...metadata, capabilities: [] }),
    true,
  )
})

test('directory fetch is lazy, coalesced, cached offline and preserves good data on failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-directory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { outputFiles } = await build({
    entryPoints: ['src/main/addon-directory.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
  })
  let calls = 0,
    status = 200,
    body = JSON.stringify([entry])
  const desktop = {
    app: { isPackaged: true, getPath: () => root },
    net: {
      fetch: async (_url, options) => {
        calls++
        assert.equal(options.credentials, 'omit')
        return new Response(body, { status })
      },
    },
  }
  const require = createRequire(import.meta.url)
  const load = () => {
    const module = { exports: {} }
    new Function('require', 'module', 'exports', outputFiles[0].text)(
      (id) => (id === 'electron' ? desktop : require(id)),
      module,
      module.exports,
    )
    return module.exports
  }
  const api = load()
  assert.equal(calls, 0)
  const [one, two] = await Promise.all([
    api.getAddonDirectory(),
    api.getAddonDirectory(),
  ])
  assert.deepEqual(one, two)
  assert.equal(calls, 1)
  assert.deepEqual(one.entries, [entry])
  assert.equal((await api.directoryAddon('example')).id, 'example')
  assert.equal(calls, 1)
  status = 503
  const failed = await api.getAddonDirectory(true)
  assert.match(failed.error, /503/)
  assert.deepEqual(failed.entries, [entry])
  assert.deepEqual(await api.getAddonDirectory(), failed)
  assert.equal(calls, 2)
  const offline = load()
  assert.deepEqual((await offline.getAddonDirectory()).entries, [entry])
  assert.equal(calls, 2)
  status = 200
  body = JSON.stringify([{ ...entry, signed: true }])
  assert.match((await api.getAddonDirectory(true)).error, /invalid entry/)
  assert.deepEqual(
    JSON.parse(await readFile(join(root, 'addon-directory.json'), 'utf8'))
      .entries,
    [entry],
  )
  await assert.rejects(api.directoryAddon('../escape'), /Choose an addon/)
  await assert.rejects(api.directoryAddon('missing'), /invalid entry/)
})

test('detached signatures come from the catalog location without credentials and stay bounded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-directory-signature-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { outputFiles } = await build({
    entryPoints: ['src/main/addon-directory.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
  })
  const urls = []
  let body = '{"keyId":"k"}',
    status = 200
  const desktop = {
    app: { isPackaged: true, getPath: () => root },
    net: {
      fetch: async (url, options) => {
        urls.push(url)
        assert.equal(options.credentials, 'omit')
        return new Response(body, { status })
      },
    },
  }
  const require = createRequire(import.meta.url)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputFiles[0].text)(
    (id) => (id === 'electron' ? desktop : require(id)),
    module,
    module.exports,
  )
  const api = module.exports
  assert.deepEqual(await api.directorySignature('example'), Buffer.from(body))
  const requested = new URL(urls[0])
  assert.equal(
    `${requested.origin}${requested.pathname}`,
    'https://raw.githubusercontent.com/hibigarden/addons-repository/main/signatures/example.json',
  )
  assert.match(requested.searchParams.get('t'), /^\d+$/)
  await assert.rejects(api.directorySignature('../catalog'), /Choose an addon/)
  assert.equal(urls.length, 1)
  body = 'x'.repeat(5 * 1024 * 1024)
  assert.equal(
    (await api.directorySignature('example')).length,
    5 * 1024 * 1024,
  )
  for (const failure of [
    () => {
      status = 404
    },
    () => {
      status = 200
      body = 'x'.repeat(5 * 1024 * 1024 + 1)
    },
  ]) {
    failure()
    await assert.rejects(
      api.directorySignature('example'),
      /Could not download the Hibi signature/,
    )
  }
})

test('garden links accept only explicit addon ids and install or open actions', () => {
  for (const install of [true, false])
    assert.deepEqual(
      parseAddonGardenLink(addonGardenLink('example', install)),
      { id: 'example', install },
    )
  for (const value of [
    'https://hibi.garden/addons',
    'hibi://evil/install?id=example',
    'hibi://addons/install?id=../escape',
    'hibi://addons/install?id=example&id=other',
    'hibi://addons/install?id=example&url=https://evil.example/a.zip',
    'hibi://user@addons/install?id=example',
    'hibi://addons:443/install?id=example',
    'hibi://addons/install?id=example#fragment',
    'hibi://addons/enable?id=example',
    'hibi://addons/install',
    `hibi://addons/install?id=${'a'.repeat(513)}`,
  ])
    assert.equal(parseAddonGardenLink(value), null, value)
})
