import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { electron } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

/** A black PNG this many pixels wide and one high. */
function png(width) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([head, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 1
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(Math.ceil(width / 8) + 1))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * An https host for one image, `width` pixels wide, that records each request
 * with the ETag it was asked to match, and answers 304 when it matches.
 */
async function imageHost(t) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-image-cache-'))
  const sockets = new Set()
  const server = createServer(
    {
      cert: await readFile('tests/fixtures/host-network-localhost-cert.pem'),
      key: await readFile('tests/fixtures/host-network-localhost-key.pem'),
    },
    (request, response) => {
      const match = request.headers['if-none-match']
      host.requests.push(`${request.url}${match ? ` ${match}` : ''}`)
      const etag = `"${host.width}"`
      response.writeHead(match === etag ? 304 : 200, {
        'Content-Type': 'image/png',
        ETag: etag,
      })
      response.end(match === etag ? undefined : png(host.width))
    },
  )
  server.on('secureConnection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const host = {
    folder,
    width: 1,
    requests: [],
    profile: join(folder, 'profile'),
    source: `https://127.0.0.1:${server.address().port}/garden.png`,
    /** Starts the app, or restarts it on the same profile, trusting the host. */
    async launch() {
      await host.app?.close()
      host.app = await electron.launch({
        args: [resolve('.'), `--user-data-dir=${host.profile}`],
      })
      host.page = await host.app.firstWindow()
      await host.app.evaluate(({ session }) =>
        session.defaultSession.setCertificateVerifyProc((_request, done) =>
          done(0),
        ),
      )
      await selectFormattedEngine(host.app, host.page, 'codemirror')
      return host
    },
    /** Opens `note`, inside the workspace at `workspace` if one is named. */
    async open(note, workspace) {
      const { app, page } = host
      if (workspace) {
        await app.evaluate(({ dialog }, workspace) => {
          dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [workspace],
          })
        }, workspace)
        await page.evaluate(() => window.hibi.openWorkspace())
      }
      await app.evaluate(({ dialog }, note) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [note],
        })
      }, note)
      await pressShortcut(
        app,
        `${process.platform === 'darwin' ? 'Meta' : 'Control'}+o`,
      )
      await waitForAsync(
        page,
        async (name) => (await window.hibi.getDocument()).name === name,
        note.split(/[\\/]/).pop(),
      )
    },
    /** Waits until the note shows the image at this width. */
    shown: (width) =>
      host.page.waitForFunction((width) => {
        const image = document.querySelector(
          '.rich-pane .hibi-formatted img[alt="garden"]',
        )
        return image?.complete && image.naturalWidth === width
      }, width),
    /** Takes the host offline. */
    stop() {
      server.close()
      for (const socket of sockets) socket.destroy()
    },
  }
  t.after(async () => {
    await host.app?.close()
    host.stop()
    await rm(folder, { recursive: true, force: true })
  })
  return host
}

/** Moves the last check of each image kept in `folder` a day and an hour into the past. */
async function age(folder) {
  for (const name of await readdir(folder)) {
    if (!name.endsWith('.json')) continue
    const kept = JSON.parse(await readFile(join(folder, name), 'utf8'))
    kept.checked -= 25 * 60 * 60 * 1000
    await writeFile(join(folder, name), JSON.stringify(kept))
  }
}

test('a workspace note keeps remote images in its .hibi cache, draws them from disk until a day old, and shows them offline', {
  timeout: 120000,
}, async (t) => {
  const host = await imageHost(t)
  const workspace = join(host.folder, 'garden')
  await mkdir(workspace)
  const note = join(workspace, 'note.md')
  await writeFile(note, `# Garden\n\n![garden](${host.source})\n`)
  const cache = join(workspace, '.hibi', 'cache')
  const images = join(cache, 'images')

  await host.launch()
  await host.open(note, workspace)
  await host.shown(1)
  assert.deepEqual(host.requests, ['/garden.png'])
  assert.equal(await readFile(join(cache, '.gitignore'), 'utf8'), '*\n')
  assert.equal((await readdir(images)).length, 2)

  // Drawn again after a reload and after a restart, the copy comes from disk.
  await host.page.reload()
  await host.shown(1)
  await host.launch()
  await host.open(note, workspace)
  await host.shown(1)
  assert.deepEqual(host.requests, ['/garden.png'])

  // A day later the host is asked whether the image changed; it hasn't.
  await age(images)
  await host.page.reload()
  await host.shown(1)
  assert.deepEqual(host.requests, ['/garden.png', '/garden.png "1"'])

  // Offline, the day-old copy still shows.
  host.stop()
  await age(images)
  await host.page.reload()
  await host.shown(1)
  assert.equal(host.requests.length, 2)
})

test('right-clicking a remote image refreshes it, and notes outside a workspace keep images in the app data folder', {
  timeout: 90000,
}, async (t) => {
  const host = await imageHost(t)
  const note = join(host.folder, 'loose.md')
  await writeFile(note, `# Loose\n\n![garden](${host.source})\n`)
  // BBCode previews come from an addon that starts off.
  await mkdir(host.profile)
  await writeFile(
    join(host.profile, 'addons.json'),
    JSON.stringify({ bbcode: true }),
  )
  await host.launch()
  await host.open(note)
  await host.shown(1)
  const data = await host.app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal((await readdir(join(data, 'image-cache'))).length, 2)
  assert.ok(!(await readdir(host.folder)).includes('.hibi'))

  // The host's image changed; a refresh fetches it whatever the copy's age.
  host.width = 3
  await host.page
    .locator('.rich-pane .hibi-formatted img[alt="garden"]')
    .click({ button: 'right' })
  await host.page
    .getByRole('menuitem', { name: 'Refresh image', exact: true })
    .click()
  await host.shown(3)
  assert.deepEqual(host.requests, ['/garden.png', '/garden.png'])

  // Format previews draw the same copy.
  const post = join(host.folder, 'post.bbcode')
  await writeFile(post, `[img]${host.source}[/img]`)
  await host.open(post)
  await host.page
    .getByRole('textbox', { name: 'BBCode editor', exact: true })
    .waitFor()
  await host.page.getByRole('button', { name: /^side-by-side$/i }).click()
  await host.page.waitForFunction(() => {
    const image = document.querySelector('.bbcode-content img')
    return image?.complete && image.naturalWidth === 3
  })
  assert.equal(host.requests.length, 2)
})
