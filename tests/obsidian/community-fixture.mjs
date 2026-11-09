import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { readFixturePlugin } from './harness.mjs'

export async function communityFixture(t) {
  const root = new URL('./fixtures/community/', import.meta.url)
  const files = new Map()
  for (const name of [
    'community-plugins.json',
    'community-plugin-stats.json',
    'community-css-themes.json',
    'release.json',
    'README.md',
  ])
    files.set(
      name,
      await readFile(
        new URL(
          name === 'community-css-themes.json'
            ? 'host-community-css-themes.json'
            : name,
          root,
        ),
        'utf8',
      ),
    )
  const plugin = await readFixturePlugin('host-smoke')
  const fixture = {
    requests: [],
    version: '1.0.0',
    offline: false,
    badMain: null,
    css: null,
  }
  fixture.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const headers = new Headers(init.headers)
    fixture.requests.push({
      url: url.href,
      etag: headers.get('if-none-match'),
      credentials: init.credentials,
    })
    init.signal?.throwIfAborted()
    if (fixture.offline) throw new Error('Fixture offline.')
    const name = url.pathname.split('/').at(-1)
    if (
      url.hostname === 'raw.githubusercontent.com' &&
      files.has(name) &&
      name !== 'release.json'
    ) {
      if (headers.get('if-none-match') === '"fixture"')
        return new Response(null, { status: 304 })
      return new Response(files.get(name), {
        headers: {
          etag: '"fixture"',
          'content-type': 'text/plain; charset=utf-8',
        },
      })
    }
    const repo =
      url.hostname === 'api.github.com'
        ? url.pathname.split('/').slice(2, 4).join('/')
        : url.pathname.split('/').slice(1, 3).join('/')
    if (url.hostname === 'api.github.com') {
      const release = JSON.parse(files.get('release.json'))
      release.tag_name = fixture.version
      release.assets = release.assets.map((asset) => ({
        ...asset,
        browser_download_url: asset.browser_download_url
          .replace('fixture/host-smoke', repo)
          .replace('1.0.0', fixture.version),
      }))
      return Response.json(release)
    }
    if (url.pathname.includes('/releases/latest/download/'))
      return new Response(null, {
        status: 302,
        headers: {
          location:
            'https://github.com/' +
            repo +
            '/releases/download/' +
            fixture.version +
            '/' +
            name,
        },
      })
    if (name === 'manifest.json')
      return Response.json({
        ...plugin.manifest,
        id: repo.endsWith('desktop-only') ? 'desktop-only' : plugin.manifest.id,
        version: fixture.version,
        isDesktopOnly: repo.endsWith('desktop-only'),
      })
    if (name === 'main.js') return new Response(fixture.badMain ?? plugin.main)
    if (name === 'styles.css' && fixture.css !== null)
      return new Response(fixture.css)
    return new Response('Not found', { status: 404 })
  }
  fixture.server = async () => {
    const server = createServer(async (req, res) => {
      try {
        const path = new URL(req.url, 'http://fixture').pathname
        const slash = path.indexOf('/', 1)
        const url = 'https://' + path.slice(1, slash) + path.slice(slash)
        if (fixture.holdNextMain && url.endsWith('/main.js')) {
          fixture.holdNextMain = false
          fixture.onHold?.()
          return
        }
        const response = await fixture.fetch(url, { headers: req.headers })
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
      } catch (error) {
        res.writeHead(503)
        res.end(error.message)
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(resolve))
    })
    return 'http://127.0.0.1:' + server.address().port
  }
  return fixture
}
