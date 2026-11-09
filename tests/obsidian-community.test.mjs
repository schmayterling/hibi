import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { communityFixture } from './obsidian/community-fixture.mjs'
import { fixtureVault } from './obsidian/harness.mjs'

async function modules(t) {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  })
  t.after(() => server.close())
  return {
    ...(await server.ssrLoadModule('/src/addons/obsidian/community.ts')),
    ...(await server.ssrLoadModule('/src/addons/obsidian/community-types.ts')),
    ...(await server.ssrLoadModule('/src/addons/obsidian/store.ts')),
  }
}

test('official community directory fixtures support filtering, sorting, etag refresh and offline disk cache', async (t) => {
  const { CommunityService, filterCommunityEntries } = await modules(t)
  const vault = await fixtureVault(t)
  const transport = await communityFixture(t)
  const root = join(vault.overlay, 'directory')
  const service = new CommunityService(root, transport.fetch)
  const first = await service.directory()
  assert.equal(first.entries.length, 4)
  assert.deepEqual(
    filterCommunityEntries(
      first.entries,
      'plugin',
      'fixture author',
      'downloads',
    ).map((entry) => entry.id),
    ['host-smoke', 'mismatch'],
  )
  assert.deepEqual(
    filterCommunityEntries(first.entries, 'plugin', '', 'name').map(
      (entry) => entry.id,
    ),
    ['desktop-only', 'host-smoke', 'mismatch'],
  )
  assert.equal(
    filterCommunityEntries(first.entries, 'plugin', '', 'updated')[0].id,
    'mismatch',
  )
  assert.equal(
    filterCommunityEntries(first.entries, 'theme', 'light', 'name').length,
    0,
  )
  const refreshed = await service.directory(true)
  assert.deepEqual(refreshed.entries, first.entries)
  assert.equal(
    transport.requests.filter((request) => request.etag === '"fixture"').length,
    3,
  )
  assert.ok(
    transport.requests.every((request) => request.credentials === 'omit'),
  )
  transport.offline = true
  const offline = await new CommunityService(root, transport.fetch).directory(
    true,
  )
  assert.deepEqual(offline.entries, first.entries)
  assert.match(offline.error, /offline/)
  await vault.assertUnchanged()
})

test('community releases use pinned assets and the folder validation/store path, start disabled and retain overlay on update', async (t) => {
  const { CommunityService, ObsidianStore } = await modules(t)
  const vault = await fixtureVault(t)
  const transport = await communityFixture(t)
  const service = new CommunityService(
    join(vault.overlay, 'directory'),
    transport.fetch,
  )
  const entry = (await service.directory()).entries.find(
    (entry) => entry.id === 'host-smoke',
  )
  const signal = new AbortController().signal
  const downloaded = await service.plugin(entry, signal)
  assert.equal(downloaded.source.repo, entry.repo)
  assert.equal(downloaded.source.release, '1.0.0')
  assert.match(downloaded.source.hashes.main, /^[a-f0-9]{64}$/)
  assert.equal(
    downloaded.source.hashes.main,
    createHash('sha256').update(downloaded.packageData.main).digest('hex'),
  )
  assert.equal(
    downloaded.source.hashes.manifest,
    createHash('sha256')
      .update(downloaded.packageData.manifestBytes)
      .digest('hex'),
  )
  assert.equal(downloaded.source.hashes.styles, null)
  assert.ok(
    transport.requests.some((request) =>
      /releases\/latest\/download\/manifest.json$/.test(request.url),
    ),
  )
  assert.ok(
    transport.requests.some((request) =>
      /releases\/download\/1.0.0\/main.js$/.test(request.url),
    ),
  )
  assert.equal(
    transport.requests.some((request) =>
      request.url.endsWith('/latest/download/main.js'),
    ),
    false,
  )
  const store = new ObsidianStore(join(vault.overlay, 'packages'), vault.vault)
  const installed = await store.install(
    downloaded.packageData,
    () => {},
    downloaded.source,
  )
  assert.equal(installed.enabled, false)
  assert.deepEqual((await store.list())[0].source, downloaded.source)
  await store.saveData('host-smoke', { kept: 'overlay' })
  await store.setEnabled('host-smoke', true)
  transport.version = '2.0.0'
  const updated = await service.plugin(entry, signal)
  assert.notEqual(updated.packageData.hash, downloaded.packageData.hash)
  await store.install(updated.packageData, () => {}, updated.source)
  assert.equal((await store.list())[0].enabled, false)
  assert.equal((await store.list())[0].source.release, '2.0.0')
  assert.deepEqual(await store.loadData('host-smoke'), { kept: 'overlay' })
  await vault.assertUnchanged()
})

test('desktop-only packages stay installable; mismatched release IDs refuse before downloading code', async (t) => {
  const { CommunityService } = await modules(t)
  const vault = await fixtureVault(t)
  const transport = await communityFixture(t)
  const service = new CommunityService(
    join(vault.overlay, 'directory'),
    transport.fetch,
  )
  const entries = (await service.directory()).entries
  const desktop = await service.plugin(
    entries.find((entry) => entry.id === 'desktop-only'),
    new AbortController().signal,
  )
  assert.equal(desktop.packageData.manifest.isDesktopOnly, true)
  for (const [id, reason] of [['mismatch', /does not match/]]) {
    transport.requests.length = 0
    await assert.rejects(
      service.plugin(
        entries.find((entry) => entry.id === id),
        new AbortController().signal,
      ),
      reason,
    )
    assert.equal(
      transport.requests.some((request) => request.url.endsWith('/main.js')),
      false,
    )
  }
})

test('community downloads refuse oversized or non-UTF8 code, unsafe CSS, HTTP and redirect escapes; API fallback works', async (t) => {
  const { CommunityService, fetchCommunityFile } = await modules(t)
  const vault = await fixtureVault(t)
  const transport = await communityFixture(t)
  const service = new CommunityService(
    join(vault.overlay, 'directory'),
    transport.fetch,
  )
  const entry = (await service.directory()).entries.find(
    (entry) => entry.id === 'host-smoke',
  )
  const signal = new AbortController().signal
  transport.badMain = Buffer.from([0xc3, 0x28])
  await assert.rejects(service.plugin(entry, signal), /encoding|encoded/)
  transport.badMain = null
  transport.css = '@import "https://example.test/remote.css";'
  await assert.rejects(service.plugin(entry, signal), /CSS/)
  await assert.rejects(
    fetchCommunityFile('http://github.com/a/b', 5, signal, transport.fetch),
    /HTTPS/,
  )
  await assert.rejects(
    fetchCommunityFile(
      'https://github.com/a/b',
      5,
      signal,
      async () => new Response('123456'),
    ),
    /limit/,
  )
  await assert.rejects(
    fetchCommunityFile(
      'https://github.com/a/b',
      5,
      signal,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.test/code' },
        }),
    ),
    /unapproved/,
  )
  transport.css = null
  service.fetch = async (url, init) =>
    String(url).includes('/latest/download/')
      ? new Response('Missing', { status: 404 })
      : transport.fetch(url, init)
  const fallback = await service.plugin(entry, signal)
  assert.equal(fallback.source.release, '1.0.0')
})

test('community downloads abort in flight without returning a partial package', async (t) => {
  const { fetchCommunityFile } = await modules(t)
  const controller = new AbortController()
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const work = fetchCommunityFile(
    'https://github.com/fixture/host-smoke',
    1000,
    controller.signal,
    async (_url, { signal }) => {
      started()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      )
    },
  )
  await ready
  controller.abort(new Error('Fixture cancellation.'))
  await assert.rejects(work, /Fixture cancellation/)
})

test('details fetch README only on demand and report desktop restrictions and minimum app version', async (t) => {
  const { CommunityService } = await modules(t)
  const vault = await fixtureVault(t)
  const transport = await communityFixture(t)
  const service = new CommunityService(
    join(vault.overlay, 'directory'),
    transport.fetch,
  )
  const entries = (await service.directory()).entries
  assert.equal(
    transport.requests.some((request) => request.url.endsWith('README.md')),
    false,
  )
  const details = await service.details(
    entries.find((entry) => entry.id === 'host-smoke'),
    new AbortController().signal,
  )
  assert.match(details.readme, /Fixture community readme/)
  assert.equal(details.release, '1.0.0')
  assert.equal(details.minAppVersion, '1.0.0')
  const desktop = await service.details(
    entries.find((entry) => entry.id === 'desktop-only'),
    new AbortController().signal,
  )
  assert.equal(desktop.desktopOnly, true)
  const theme = entries.find((entry) => entry.kind === 'theme')
  assert.equal(
    (await service.details(theme, new AbortController().signal)).release,
    '1.0.0',
  )
  const branch = new CommunityService(
    join(vault.overlay, 'branch-directory'),
    async (url, init) => {
      if (String(url).endsWith('/releases/latest'))
        return new Response('Not found', { status: 404 })
      if (String(url).includes('/commits/'))
        return Response.json({ sha: 'd'.repeat(40) })
      return transport.fetch(url, init)
    },
  )
  assert.equal(
    (await branch.details(theme, new AbortController().signal)).release,
    'd'.repeat(40),
  )
})

test('README API fallback stays in the selected repository and refuses forged download URLs', async (t) => {
  const { CommunityService } = await modules(t)
  const vault = await fixtureVault(t)
  const transport = await communityFixture(t)
  const service = new CommunityService(
    join(vault.overlay, 'directory'),
    transport.fetch,
  )
  const entry = (await service.directory()).entries.find(
    (entry) => entry.id === 'host-smoke',
  )
  let forged = false
  service.fetch = async (url, init) => {
    if (String(url).endsWith('/HEAD/README.md'))
      return new Response('Missing', { status: 404 })
    if (String(url).endsWith('/readme'))
      return Response.json({
        download_url: forged
          ? 'https://raw.githubusercontent.com/another/repo/main/readme.md'
          : 'https://raw.githubusercontent.com/fixture/host-smoke/main/readme.md',
      })
    if (String(url).endsWith('/main/readme.md'))
      return new Response('# Lowercase readme')
    return transport.fetch(url, init)
  }
  const details = await service.details(entry, new AbortController().signal)
  assert.equal(details.readme, '# Lowercase readme')
  assert.equal(
    details.readmeUrl,
    'https://raw.githubusercontent.com/fixture/host-smoke/main/readme.md',
  )
  forged = true
  const invalid = await service.details(entry, new AbortController().signal)
  assert.equal(invalid.readme, '')
  assert.match(invalid.error, /repository/)
})

test('directory accepts GitHub repository leading symbols and an empty optional theme screenshot', async (t) => {
  const { parseCommunityEntries } = await modules(t)
  const plugin = {
    id: 'leading-symbol',
    name: 'Leading symbol',
    author: 'Fixture author',
    repo: 'fixture/-leading',
    description: 'Portable fixture.',
  }
  assert.equal(
    parseCommunityEntries([plugin], 'plugin')[0].repo,
    'fixture/-leading',
  )
  assert.equal(
    parseCommunityEntries(
      [
        {
          name: 'No screenshot',
          author: 'Fixture author',
          repo: 'fixture/.theme',
          screenshot: '',
        },
      ],
      'theme',
    )[0].screenshot,
    undefined,
  )
  for (const repo of [
    'fixture/..',
    'fixture/.',
    'fixture/../escape',
    'https://evil.test/a/b',
  ])
    assert.throws(
      () => parseCommunityEntries([{ ...plugin, repo }], 'plugin'),
      /invalid/,
    )
})
