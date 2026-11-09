import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  communityScreenshot,
  installCommunityTheme,
  parseCommunityThemes,
} from '../src/addons/obsidian-themes/community.ts'
import {
  installedThemes,
  themeCss,
} from '../src/addons/obsidian-themes/store.ts'

const fixtures = fileURLToPath(new URL('./obsidian/fixtures/', import.meta.url))
const fixture = (path) => readFile(join(fixtures, path))
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
)
const sha = 'a'.repeat(40)

// Recorded GitHub answers by URL; anything else is a 404. No network.
function github(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const href = String(url)
    calls.push(href)
    init.signal?.throwIfAborted()
    const route = routes[href]
    if (typeof route === 'function') return route(init)
    if (!route) return new Response('Not Found', { status: 404 })
    return new Response(route.body ?? route, {
      status: route.status ?? 200,
      headers: route.headers ?? {},
    })
  }
  return { fetch, calls }
}

async function store(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-obsidian-community-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const raw = (repo, ref, file) =>
  `https://raw.githubusercontent.com/${repo}/${ref}/${file}`
const deps = (fetch) => ({ fetch, signal: new AbortController().signal })

test('a theme without a release installs from its branch, with commit and license, and is not applied', async (t) => {
  const root = await store(t)
  const repo = 'hibi-fixtures/heavy-grid'
  const { fetch, calls } = github({
    [raw(repo, 'HEAD', 'manifest.json')]: await fixture(
      'themes/heavy-grid/manifest.json',
    ),
    [raw(repo, 'HEAD', 'theme.css')]: await fixture(
      'themes/heavy-grid/theme.css',
    ),
    [`https://api.github.com/repos/${repo}/commits/HEAD`]: sha,
    [raw(repo, sha, 'LICENSE')]: 'Unlicense fixture text',
  })
  const result = await installCommunityTheme(
    root,
    { repo, name: 'Heavy Grid' },
    deps(fetch),
  )
  assert.equal(result.ok, true)
  const { theme } = result
  assert.equal(theme.source, 'community')
  assert.equal(theme.repository, repo)
  assert.equal(theme.ref, 'HEAD')
  assert.equal(theme.commit, sha)
  assert.equal(theme.manifest.version, '3.0.1')
  assert.equal(theme.manifest.license, 'Unlicense fixture text')
  // The same checks as any theme: remote URLs and imports are gone, and
  // local assets the download doesn't include are reported.
  const css = await themeCss(root, theme.id)
  assert.doesNotMatch(css, /https?:|@import/)
  assert.ok(
    theme.dropped.some((entry) => /missing local asset/.test(entry.reason)),
  )
  assert.deepEqual(
    (await installedThemes(root)).map((item) => item.id),
    [theme.id],
  )
  // Nothing chosen, nothing left behind.
  assert.deepEqual((await readdir(root)).sort(), ['incoming', 'themes'])
  assert.deepEqual(await readdir(join(root, 'incoming')), [])
  for (const url of calls)
    assert.match(
      url,
      /^https:\/\/(api\.)?github|^https:\/\/raw\.githubusercontent\.com\//,
    )
})

test("a release's own assets win over the branch, following GitHub's redirect", async (t) => {
  const root = await store(t)
  const repo = 'hibi-fixtures/paper-lantern'
  const download = `https://github.com/${repo}/releases/download/1.2.0`
  const asset =
    'https://release-assets.githubusercontent.com/github-production-release-asset/1'
  const { fetch, calls } = github({
    [`https://api.github.com/repos/${repo}/releases/latest`]: await fixture(
      'community/paper-lantern-release.json',
    ),
    [`${download}/manifest.json`]: {
      status: 302,
      body: null,
      headers: { location: `${asset}/manifest` },
    },
    [`${asset}/manifest`]: await fixture('themes/paper-lantern/manifest.json'),
    [`${download}/theme.css`]: {
      status: 302,
      body: null,
      headers: { location: `${asset}/theme` },
    },
    [`${asset}/theme`]: await fixture('themes/paper-lantern/theme.css'),
    [raw(repo, '1.2.0', 'LICENSE')]: await fixture(
      'themes/paper-lantern/LICENSE',
    ),
  })
  const result = await installCommunityTheme(
    root,
    { repo, name: 'Paper Lantern', branch: 'main' },
    deps(fetch),
  )
  assert.equal(result.ok, true)
  assert.equal(result.theme.ref, '1.2.0')
  assert.equal(result.theme.commit, undefined)
  assert.match(result.theme.manifest.license, /MIT License/)
  assert.ok(!calls.some((url) => url.includes('/main/')))
  assert.match(
    await themeCss(root, result.theme.id),
    /--background-primary: #fbf3e4/,
  )
})

test('downloads stay on GitHub, within limits, and match the directory', async (t) => {
  const root = await store(t)
  const repo = 'hibi-fixtures/heavy-grid'
  const manifest = await fixture('themes/heavy-grid/manifest.json')
  const failure = async (routes, input = {}) => {
    const { fetch, calls } = github(routes)
    const result = await installCommunityTheme(
      root,
      { repo, name: 'Heavy Grid', ...input },
      deps(fetch),
    )
    return { ...result, calls }
  }
  // A redirect off GitHub is refused before it is followed.
  const away = await failure({
    [raw(repo, 'HEAD', 'manifest.json')]: {
      status: 302,
      body: null,
      headers: { location: 'https://evil.test/manifest.json' },
    },
  })
  assert.equal(away.code, 'unsafe')
  assert.ok(!away.calls.some((url) => url.includes('evil.test')))
  // So is plain HTTP on GitHub.
  const plain = await failure({
    [raw(repo, 'HEAD', 'manifest.json')]: {
      status: 301,
      body: null,
      headers: { location: 'http://raw.githubusercontent.com/x' },
    },
  })
  assert.equal(plain.code, 'unsafe')
  // A release asset from another repository is ignored.
  const foreign = await failure({
    [`https://api.github.com/repos/${repo}/releases/latest`]: JSON.stringify({
      tag_name: 'v9',
      assets: [
        {
          name: 'theme.css',
          browser_download_url:
            'https://github.com/other/repo/releases/download/v9/theme.css',
        },
        {
          name: 'manifest.json',
          browser_download_url:
            'https://github.com/other/repo/releases/download/v9/manifest.json',
        },
      ],
    }),
  })
  assert.equal(foreign.code, 'not-found')
  assert.ok(!foreign.calls.some((url) => url.includes('other/repo')))
  // Too large, by declared length or by what arrives.
  const declared = await failure({
    [raw(repo, 'HEAD', 'manifest.json')]: manifest,
    [raw(repo, 'HEAD', 'theme.css')]: {
      body: 'a',
      headers: { 'content-length': String(6 * 1024 * 1024) },
    },
  })
  assert.equal(declared.code, 'too-large')
  const streamed = await failure({
    [raw(repo, 'HEAD', 'manifest.json')]: manifest,
    [raw(repo, 'HEAD', 'theme.css')]: 'a'.repeat(5 * 1024 * 1024 + 1),
  })
  assert.equal(streamed.code, 'too-large')
  // The manifest must name the theme the directory lists.
  const renamed = await failure({
    [raw(repo, 'HEAD', 'manifest.json')]: JSON.stringify({ name: 'Other' }),
    [raw(repo, 'HEAD', 'theme.css')]: 'a{}',
  })
  assert.equal(renamed.code, 'name-mismatch')
  // Invalid input makes no request at all.
  for (const input of [
    { repo: '../etc' },
    { repo: 'a/b/c' },
    { repo: 'https://github.com/a/b' },
    { branch: '../../x' },
    { branch: 'a//b' },
    { name: '' },
  ]) {
    const result = await failure({}, input)
    assert.equal(result.code, 'invalid', JSON.stringify(input))
    assert.deepEqual(result.calls, [])
  }
  assert.deepEqual(await installedThemes(root), [])
})

test('a pre-0.16 theme installs from obsidian.css', async (t) => {
  const root = await store(t)
  const repo = 'hibi-fixtures/legacy-ink'
  const { fetch } = github({
    [raw(repo, 'master', 'manifest.json')]: JSON.stringify({
      name: 'Legacy Ink',
    }),
    [raw(repo, 'master', 'obsidian.css')]: await fixture(
      'themes/legacy-ink/obsidian.css',
    ),
  })
  const result = await installCommunityTheme(
    root,
    { repo, name: 'Legacy Ink', branch: 'master' },
    deps(fetch),
  )
  assert.equal(result.ok, true)
  assert.equal(result.theme.ref, 'master')
  assert.equal(result.theme.manifest.license, undefined)
})

test('cancelling stops a download and stores nothing', async (t) => {
  const root = await store(t)
  const repo = 'hibi-fixtures/heavy-grid'
  const controller = new AbortController()
  let started
  const waiting = new Promise((resolve) => {
    started = resolve
  })
  const { fetch } = github({
    [raw(repo, 'HEAD', 'manifest.json')]: (init) =>
      new Promise((_resolve, reject) => {
        started()
        init.signal.addEventListener('abort', () => reject(init.signal.reason))
      }),
  })
  const pending = installCommunityTheme(
    root,
    { repo, name: 'Heavy Grid' },
    { fetch, signal: controller.signal },
  )
  await waiting
  controller.abort()
  assert.deepEqual(await pending, {
    ok: false,
    code: 'cancelled',
    message: 'The theme download was cancelled.',
  })
  assert.deepEqual(await installedThemes(root), [])
})

test('screenshots load on request as checked image data URLs', async () => {
  const repo = 'hibi-fixtures/heavy-grid'
  const { fetch, calls } = github({
    [raw(repo, 'HEAD', 'screenshot.png')]: png,
    [raw(repo, 'main', 'images/shot.webp')]: '<html><script>x</script></html>',
  })
  const shot = await communityScreenshot(
    { repo, path: 'screenshot.png' },
    deps(fetch),
  )
  assert.equal(shot.ok, true)
  assert.match(shot.dataUrl, /^data:image\/png;base64,iVBOR/)
  const html = await communityScreenshot(
    { repo, path: 'images/shot.webp', branch: 'main' },
    deps(fetch),
  )
  assert.equal(html.code, 'unsafe')
  const missing = await communityScreenshot(
    { repo, path: 'gone.png' },
    deps(fetch),
  )
  assert.equal(missing.code, 'not-found')
  const before = calls.length
  for (const path of [
    '../../../etc/passwd',
    'https://evil.test/a.png',
    '',
    null,
  ])
    assert.equal(
      (await communityScreenshot({ repo, path }, deps(fetch))).code,
      'invalid',
    )
  assert.equal(calls.length, before)
})

test('the community directory keeps only well-formed entries', async () => {
  const entries = parseCommunityThemes(
    JSON.parse(
      await readFile(
        join(fixtures, 'community/community-css-themes.json'),
        'utf8',
      ),
    ),
  )
  assert.deepEqual(entries, [
    {
      name: 'Heavy Grid',
      author: 'Hibi fixtures',
      repo: 'hibi-fixtures/heavy-grid',
      screenshot: 'screenshot.png',
      modes: ['dark', 'light'],
    },
    {
      name: 'Paper Lantern',
      author: 'Hibi fixtures',
      repo: 'hibi-fixtures/paper-lantern',
      screenshot: 'images/shot.webp',
      modes: ['light'],
      branch: 'main',
    },
    {
      name: 'Escaping Shot',
      author: 'x',
      repo: 'a/c',
      screenshot: null,
      modes: ['dark'],
    },
  ])
  assert.deepEqual(parseCommunityThemes({ not: 'a list' }), [])
})
