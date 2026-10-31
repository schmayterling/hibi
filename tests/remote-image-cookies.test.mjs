import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

/**
 * An https image host that tracks readers as a hostile one could: it sets a
 * cookie and a cache tag (ETag, Last-Modified) on every image, asks for
 * revalidation on every use, and records the cookies and validators it gets.
 */
async function imageHost(t) {
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=',
    'base64',
  )
  const cookies = []
  const validators = []
  const paths = []
  const server = createServer(
    {
      cert: await readFile('tests/fixtures/host-network-localhost-cert.pem'),
      key: await readFile('tests/fixtures/host-network-localhost-key.pem'),
    },
    (request, response) => {
      paths.push(request.url)
      cookies.push(request.headers.cookie ?? null)
      const validator = [
        request.headers['if-none-match'],
        request.headers['if-modified-since'],
      ]
        .filter(Boolean)
        .join(' ')
      validators.push(validator || null)
      response.writeHead(validator ? 304 : 200, {
        'Content-Type': 'image/png',
        // Images under /cached/ may be reused for an hour.
        'Cache-Control': request.url.startsWith('/cached/')
          ? 'max-age=3600'
          : 'no-cache',
        ETag: '"reader-42"',
        'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        'Set-Cookie': 'tracker=1; SameSite=None; Secure',
      })
      response.end(validator ? undefined : pixel)
    },
  )
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const folder = await mkdtemp(join(tmpdir(), 'hibi-image-cookies-'))
  const host = {
    folder,
    cookies,
    validators,
    paths,
    origin: `https://127.0.0.1:${server.address().port}`,
    /** Starts the app, or restarts it on the same profile. */
    async launch() {
      await host.app?.close()
      host.app = await electron.launch({
        args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
      })
      host.page = await host.app.firstWindow()
      return host
    },
  }
  t.after(async () => {
    await host.app?.close()
    server.close()
    await rm(folder, { recursive: true, force: true })
  })
  return host.launch()
}

/** Shows an image in the app's page, as a note's image is. */
const show = (page, src) =>
  page.evaluate(
    (src) =>
      new Promise((done, fail) => {
        const image = new Image()
        image.onload = done
        image.onerror = () => fail(new Error(`${src} did not load`))
        image.src = src
      }),
    src,
  )

/** Trusts the test host's certificate in a session and gives it a cookie for the host. */
const trust = (app, origin, partition = null) =>
  app.evaluate(
    async ({ session }, [url, partition]) => {
      const target = partition
        ? session.fromPartition(partition, { cache: false })
        : session.defaultSession
      target.setCertificateVerifyProc((_request, done) => done(0))
      await target.cookies.set({
        url,
        name: 'existing',
        value: '1',
        secure: true,
        sameSite: 'no_restriction',
      })
    },
    [origin, partition],
  )

const stored = (app, origin, partition = null) =>
  app.evaluate(
    async ({ session }, [url, partition]) =>
      (
        await (partition
          ? session.fromPartition(partition, { cache: false })
          : session.defaultSession
        ).cookies.get({ url })
      ).map((cookie) => cookie.name),
    [origin, partition],
  )

/** Opens a note from the host's folder as a tab. */
async function open({ app, page, folder }, name) {
  await app.evaluate(
    ({ dialog }, note) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [note],
      })
    },
    join(folder, name),
  )
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+o`,
  )
  await waitForAsync(
    page,
    async (name) => (await window.hibi.getDocument()).name === name,
    name,
  )
}

/** Waits until the formatted view draws the loaded image with this description. */
const shown = (page, alt) =>
  page.waitForFunction((alt) => {
    const image = document.querySelector(
      `.rich-pane .hibi-formatted img[alt="${alt}"]`,
    )
    return image?.complete && image.naturalWidth > 0
  }, alt)

test('remote https images neither send nor store cookies', {
  timeout: 45000,
}, async (t) => {
  const { app, page, origin, cookies } = await imageHost(t)
  await trust(app, origin)
  for (const path of ['/first.png', '/second.png'])
    await show(page, origin + path)
  assert.deepEqual(cookies, [null, null])
  assert.deepEqual(await stored(app, origin), ['existing'])
})

test('remote https images loaded straight from their host skip the cache, so hosts get no validators to recognize a reader by', {
  timeout: 90000,
}, async (t) => {
  const host = await imageHost(t)
  const src = `${host.origin}/tracked.png`
  await trust(host.app, host.origin)
  // A first view, a second after a reload, when the cache would revalidate
  // the image, and one more after a restart.
  await show(host.page, src)
  await host.page.reload()
  await show(host.page, src)
  await host.launch()
  await trust(host.app, host.origin)
  await show(host.page, src)
  assert.deepEqual(host.validators, [null, null, null])
  assert.deepEqual(host.cookies, [null, null, null])
})

test('a remote image drawn again after scrolling back or switching tabs is not downloaded again', {
  timeout: 90000,
}, async (t) => {
  const host = await imageHost(t)
  const { app, page, origin, folder, paths } = host
  await trust(app, origin)
  const editor = await waitForFormattedEditor(app, page)
  const filler = Array.from(
    { length: 300 },
    (_, line) => `Line ${line} between the images.`,
  ).join('\n\n')
  await writeFile(
    join(folder, 'images.md'),
    `![top](${origin}/cached/top.png)\n\n${filler}\n\n![bottom](${origin}/cached/bottom.png)\n`,
  )
  await writeFile(join(folder, 'other.md'), 'Another note')
  // Without a reference, an image the view no longer draws is collected.
  const cdp = await page.context().newCDPSession(page)
  const collect = () => cdp.send('HeapProfiler.collectGarbage')
  await open(host, 'images.md')
  await shown(page, 'top')
  await editor.focus()
  await editor.press('ControlOrMeta+End')
  await shown(page, 'bottom')
  await collect()
  await editor.press('ControlOrMeta+Home')
  await shown(page, 'top')
  await open(host, 'other.md')
  await collect()
  await page.getByRole('tab', { name: 'images.md', exact: true }).click()
  await shown(page, 'top')
  assert.deepEqual(paths.filter((path) => path.startsWith('/cached/')).sort(), [
    '/cached/bottom.png',
    '/cached/top.png',
  ])
})

test('held remote images keep no editor view alive, and a closed tab holds none', {
  timeout: 120000,
}, async (t) => {
  const host = await imageHost(t)
  const { app, page, origin, folder, paths } = host
  await trust(app, origin)
  await waitForFormattedEditor(app, page)
  // Each image is drawn only while the view is at its own section.
  const filler = Array.from(
    { length: 300 },
    (_, line) => `Line ${line} between the images.`,
  ).join('\n\n')
  const images = [
    `![s0](${origin}/cached/s0.png)`,
    `![s1](${origin}/cached/s1.png)`,
    // A tag with only a height takes its width as it loads.
    `<img src="${origin}/cached/s2.png" alt="s2" height="40">`,
    `![s3](${origin}/cached/s3.png)`,
  ]
  await writeFile(
    join(folder, 'images.md'),
    images.map((image) => `${image}\n\n${filler}`).join('\n\n'),
  )
  await writeFile(join(folder, 'other.md'), 'Another note')
  const cdp = await page.context().newCDPSession(page)
  /** Counts live objects with a prototype after collections, until `done` or 5 s pass. */
  const live = async (prototype, count, done) => {
    const objectGroup = 'live'
    for (const end = Date.now() + 5000; ; ) {
      for (let pass = 0; pass < 3; pass++)
        await cdp.send('HeapProfiler.collectGarbage')
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: prototype,
        objectGroup,
      })
      const { objects } = await cdp.send('Runtime.queryObjects', {
        prototypeObjectId: result.objectId,
        objectGroup,
      })
      const { result: counted } = await cdp.send('Runtime.callFunctionOn', {
        objectId: objects.objectId,
        functionDeclaration: count,
        returnByValue: true,
      })
      // The inspector keeps what it found alive until it is released.
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup })
      if (done(counted.value) || Date.now() > end) return counted.value
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  const views = (done) =>
    live(
      "Object.getPrototypeOf(document.querySelector('.rich-pane .cm-content').cmTile.root.view)",
      'function () { return this.length }',
      done,
    )
  const select = async (name) => {
    await page.getByRole('tab', { name, exact: true }).click()
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      name,
    )
    await page.waitForFunction(
      () => !!document.querySelector('.rich-pane .cm-content')?.cmTile,
    )
  }
  await open(host, 'images.md')
  await shown(page, 's0')
  // The note's view and any others the window keeps.
  const before = await views(() => true)
  const noViewLeft = async (when) => {
    const after = await views((count) => count <= before)
    assert.ok(
      after <= before,
      `${after} editor views ${when}, ${before} before`,
    )
  }
  // A tab switched away from keeps its images but no view.
  await open(host, 'other.md')
  await noViewLeft('after leaving s0')
  for (const alt of ['s1', 's2', 's3']) {
    await select('images.md')
    await page.evaluate((path) => {
      const { view } = document.querySelector('.rich-pane .cm-content').cmTile
        .root
      view.dispatch({
        effects: view.constructor.scrollIntoView(
          view.state.doc.toString().indexOf(path),
          { y: 'center' },
        ),
      })
    }, `/cached/${alt}.png`)
    await shown(page, alt)
    await select('other.md')
    await noViewLeft(`after leaving ${alt}`)
  }
  // Closed, the note holds none of its images, nor its last view.
  await select('images.md')
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+w`,
  )
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'other.md',
  )
  assert.equal(
    await live(
      'HTMLImageElement.prototype',
      "function () { return this.filter((image) => image.src.startsWith('app://remote-image/?')).length }",
      (count) => count === 0,
    ),
    0,
  )
  await noViewLeft('after closing the note')
  // Held while the note was open, each image was downloaded once.
  assert.deepEqual(
    paths.filter((path) => path.startsWith('/cached/s')).sort(),
    ['/cached/s0.png', '/cached/s1.png', '/cached/s2.png', '/cached/s3.png'],
  )
})

test('PDF exports draw remote images from the image cache, which sends image hosts no cookies and keeps none', {
  timeout: 60000,
}, async (t) => {
  const { app, page, origin, cookies, validators, folder } = await imageHost(t)
  await waitForDocumentEditor(app, page)
  // An empty untitled note is not a tab yet, so export an opened one.
  const note = join(folder, 'note.md')
  await writeFile(note, 'Remote images')
  await app.evaluate(({ dialog }, note) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [note] })
  }, note)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+o`,
  )
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  // The cache downloads in the app's own session.
  await trust(app, origin)
  for (const name of ['first', 'second']) {
    const target = join(folder, `${name}.pdf`)
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: target,
      })
    }, target)
    assert.equal(
      await page.evaluate(
        async (html) =>
          window.hibi.exportPdf((await window.hibi.getDocument()).tabId, html),
        `<img src="${origin}/tracked.png">`,
      ),
      target,
    )
  }
  // The second export draws the copy the first one kept.
  assert.deepEqual(cookies, [null])
  assert.deepEqual(validators, [null])
  assert.deepEqual(await stored(app, origin), ['existing'])
})
