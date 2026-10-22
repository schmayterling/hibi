import assert from 'node:assert/strict'
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
