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
import { electron, waitForFormattedEditor } from './electron.mjs'
import { pressShortcut, splitTab } from './keyboard.mjs'
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
      await waitForFormattedEditor(host.app, host.page)
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

test('Refresh image, from a right-click, Shift+F10 or the menu key, fetches a remote image again, and notes outside a workspace keep images in the app data folder', {
  timeout: 90000,
}, async (t) => {
  const host = await imageHost(t)
  const note = join(host.folder, 'loose.md')
  await writeFile(note, `# Loose\n\n![garden](${host.source})\n`)
  // BBCode and HTML previews come from addons that start off.
  await mkdir(host.profile)
  await writeFile(
    join(host.profile, 'addons.json'),
    JSON.stringify({ bbcode: true, html: true }),
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
  // From the keyboard, Shift+F10 or the menu key with the caret in the image
  // offers it first.
  const choose = async () => {
    await host.page
      .getByRole('menuitem', { name: 'Refresh image', exact: true })
      .waitFor()
    await host.page.keyboard.press('Enter')
  }
  const editor = host.page.locator('.rich-pane .hibi-formatted .cm-content')
  await editor.press('ControlOrMeta+End')
  await editor.press('ArrowUp')
  for (const [key, width] of [
    ['Shift+F10', 4],
    ['ContextMenu', 5],
  ]) {
    host.width = width
    await editor.press(key)
    await choose()
    await host.shown(width)
  }
  assert.equal(host.requests.length, 4)

  // Format previews draw the same copy.
  const post = join(host.folder, 'post.bbcode')
  await writeFile(post, `[img]${host.source}[/img]`)
  await host.open(post)
  await host.page
    .getByRole('textbox', { name: 'BBCode editor', exact: true })
    .waitFor()
  await host.page.getByRole('button', { name: /^side-by-side$/i }).click()
  const previewed = (width) =>
    host.page.waitForFunction((width) => {
      const image = document.querySelector('.bbcode-content img')
      return image?.complete && image.naturalWidth === width
    }, width)
  await previewed(5)
  assert.equal(host.requests.length, 4)
  // And refresh it the same ways.
  host.width = 6
  await host.page.locator('.bbcode-content img').click({ button: 'right' })
  await host.page
    .getByRole('menuitem', { name: 'Refresh image', exact: true })
    .click()
  await previewed(6)
  for (const [key, width] of [
    ['Shift+F10', 7],
    ['ContextMenu', 8],
  ]) {
    host.width = width
    await host.page.locator('.bbcode-content img').press(key)
    await choose()
    await previewed(width)
  }
  assert.equal(host.requests.length, 7)
  // The image has no description, so its stop takes its file's name, and it
  // shows its focus with focus outlines off, as they start.
  const image = host.page.getByRole('img', { name: 'garden.png', exact: true })
  assert.equal(await image.count(), 1)
  await image.focus()
  await host.page.keyboard.press('Shift+Tab')
  await host.page.keyboard.press('Tab')
  assert.deepEqual(
    await image.evaluate((node) => ({
      focused: node.matches(':focus-visible'),
      outline: getComputedStyle(node).outlineStyle,
    })),
    { focused: true, outline: 'solid' },
  )
  // An image whose document asks for CORS still draws, as a plain image.
  const html = join(host.folder, 'page.html')
  await writeFile(
    html,
    `<p><img crossorigin="anonymous" alt="cors" src="${host.source}"></p>`,
  )
  await host.open(html)
  await host.page.waitForFunction(() => {
    const image = document.querySelector('.format-content img[alt="cors"]')
    return image?.complete && image.naturalWidth === 8
  })
  assert.equal(host.requests.length, 7)
})

test('pages show remote images, but their scripts can read neither the bytes nor the pixels', {
  timeout: 90000,
}, async (t) => {
  // The test host has a private address, which addon network access refuses.
  const host = await imageHost(t)
  const note = join(host.folder, 'note.md')
  await writeFile(note, `# Note\n\n![garden](${host.source})\n`)
  await host.launch()
  await host.open(note)
  await host.shown(1)
  const reads = await host.page.evaluate(async () => {
    const image = document.querySelector(
      '.rich-pane .hibi-formatted img[alt="garden"]',
    )
    const context = document.createElement('canvas').getContext('2d')
    context.drawImage(image, 0, 0)
    const read = async (work) => {
      try {
        await work()
        return 'read'
      } catch {
        return 'refused'
      }
    }
    return {
      bytes: await read(async () => (await fetch(image.src)).arrayBuffer()),
      pixels: await read(() => context.getImageData(0, 0, 1, 1)),
      // A CORS-mode copy is untainted unless the cache refuses it.
      corsPixels: await read(async () => {
        const copy = new Image()
        copy.crossOrigin = 'anonymous'
        copy.src = `${image.src}&copy`
        await copy.decode()
        const canvas = document.createElement('canvas').getContext('2d')
        canvas.drawImage(copy, 0, 0)
        canvas.getImageData(0, 0, 1, 1)
      }),
    }
  })
  assert.deepEqual(reads, {
    bytes: 'refused',
    pixels: 'refused',
    corsPixels: 'refused',
  })
})

test("a pane keeps its own note's remote images where that note keeps them, whichever note is active", {
  timeout: 120000,
}, async (t) => {
  const host = await imageHost(t)
  const { origin } = new URL(host.source)
  const workspace = join(host.folder, 'garden')
  await mkdir(workspace)
  const inside = join(workspace, 'inside.md')
  await writeFile(inside, `# Inside\n\n![inside](${origin}/inside.png)\n`)
  // Far enough down that the image is first drawn when the pane scrolls to it.
  const filler = Array.from(
    { length: 300 },
    (_, line) => `Line ${line} above the image.`,
  ).join('\n\n')
  const loose = join(host.folder, 'loose.md')
  await writeFile(
    loose,
    `# Loose\n\n${filler}\n\n![loose](${origin}/loose.png)\n`,
  )
  await host.launch()
  await host.open(inside, workspace)
  const tab = () =>
    host.page.evaluate(async () => (await window.hibi.getDocument()).tabId)
  const insideTab = await tab()
  await host.open(loose)
  const looseTab = await tab()
  await host.page.getByRole('tab', { name: 'inside.md', exact: true }).click()
  await waitForAsync(
    host.page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    insideTab,
  )
  await splitTab(host.app, host.page, looseTab)
  const left = host.page.locator('.editor-page[data-side="left"]')
  const right = host.page.locator('.editor-page[data-side="right"]')
  await right.locator('.hibi-formatted .cm-content').waitFor()
  await left.locator('[aria-label="Document editor"]').click()
  await waitForAsync(
    host.page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    insideTab,
  )
  // Scrolled without taking focus, the loose note's pane draws its image
  // while the workspace note stays active.
  await right.evaluate((pane) => {
    let node = pane.querySelector('.cm-content')
    while (
      node &&
      !(
        node.scrollHeight > node.clientHeight + 1 &&
        /auto|scroll/.test(getComputedStyle(node).overflowY)
      )
    )
      node = node.parentElement
    node.scrollTop = node.scrollHeight
  })
  const shown = (width) =>
    right.evaluate(
      (pane, width) =>
        new Promise((done) => {
          const check = () => {
            const image = pane.querySelector('img[alt="loose"]')
            if (image?.complete && image.naturalWidth === width) done()
            else requestAnimationFrame(check)
          }
          check()
        }),
      width,
    )
  await shown(1)
  assert.equal(await tab(), insideTab)
  const images = join(workspace, '.hibi', 'cache', 'images')
  const data = join(host.profile, 'image-cache')
  assert.deepEqual(host.requests.sort(), ['/inside.png', '/loose.png'])
  assert.equal((await readdir(images)).length, 2)
  assert.equal((await readdir(data)).length, 2)

  // Refresh image on that pane refreshes the loose note's copy.
  host.width = 3
  await right.locator('img[alt="loose"]').click({ button: 'right' })
  await host.page
    .getByRole('menuitem', { name: 'Refresh image', exact: true })
    .click()
  await shown(3)
  assert.equal(host.requests.length, 3)
  assert.equal((await readdir(images)).length, 2)
  assert.equal((await readdir(data)).length, 2)
})
