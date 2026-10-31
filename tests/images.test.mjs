import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import unit from 'node:test'
import { pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import {
  documentMediaPath,
  imageSources,
  readDocumentImage,
  resolveDocumentMediaPath,
} from '../src/main/images.ts'
import { electron, waitForFormattedEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

unit(
  'image references include Markdown and HTML images but exclude code examples',
  () => {
    const sources = imageSources(
      [
        '![garden](pixel.png)',
        '<img src="nested/pixel.png?x=1&amp;y=2">',
        '`![example](secret.png)`',
        '```html',
        '<img src="secret.png">',
        '```',
      ].join('\n\n'),
    )
    assert.deepEqual([...sources].sort(), [
      'nested/pixel.png?x=1&y=2',
      'pixel.png',
    ])
  },
)

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64',
)

unit(
  'website-root image paths fall back to workspace assets without replacing absolute-file behavior',
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hibi-root-images-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'uploads'))
    await mkdir(join(root, 'notes'))
    const image = join(root, 'uploads', 'shot with spaces.png'),
      note = join(root, 'notes', 'note.md')
    await writeFile(image, png)
    const source = '/uploads/shot%20with%20spaces.png'
    assert.equal(await resolveDocumentMediaPath(source, note, root), image)
    assert.equal(
      await readDocumentImage(source, note, root),
      `data:image/png;base64,${png.toString('base64')}`,
    )
    assert.equal(await readDocumentImage(source, note), null)
    assert.equal(
      await readDocumentImage(source, join(root, 'note.md')),
      `data:image/png;base64,${png.toString('base64')}`,
    )
    assert.equal(await resolveDocumentMediaPath(image, note, root), image)
    assert.equal(
      await resolveDocumentMediaPath(pathToFileURL(image).href, note, root),
      image,
    )
    assert.equal(
      await resolveDocumentMediaPath('/../outside.png', note, root),
      null,
    )
    assert.equal(documentMediaPath('%2F%2Fserver/image.png', note), null)
    assert.equal(documentMediaPath('assets/%00.png', note), null)
    await mkdir(join(root, 'public', 'uploads'), { recursive: true })
    const publicImage = join(root, 'public', 'uploads', 'site.png')
    await writeFile(publicImage, png)
    assert.equal(
      await resolveDocumentMediaPath('/uploads/site.png', note, root),
      publicImage,
    )
  },
)

test('local images resolve from the note, validate content, and retain their Markdown paths', {
  timeout: 30000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-images-'))
  const assets = join(folder, 'assets')
  await mkdir(assets)
  const image = join(assets, 'my image.png')
  await writeFile(image, png)
  await writeFile(join(assets, 'fake.png'), 'private text is not image data')
  const first = join(folder, 'first.md')
  const original = `![relative](assets/my%20image.png)\n\n![absolute](<${image}>)\n\n![file](${pathToFileURL(image).href})\n\n![root](/assets/my%20image.png)\n\nbody`
  await writeFile(first, original)
  assert.equal(imageSources(original).size, 4)
  for (const source of imageSources(original)) {
    assert.equal(
      await readDocumentImage(source, first),
      `data:image/png;base64,${png.toString('base64')}`,
    )
  }
  assert.equal(await readDocumentImage('assets/my%20image.png', null), null)
  assert.equal(await readDocumentImage('assets/fake.png', first), null)
  assert.equal(
    await readDocumentImage('https://example.com/image.png', first),
    null,
  )
  assert.equal(await readDocumentImage('missing.png', first), null)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, first) => {
    dialog.showOpenDialog = async () => {
      await new Promise((resolve) => {
        globalThis.finishImageOpen = resolve
      })
      return { canceled: false, filePaths: [first] }
    }
  }, first)
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  const rich = await waitForFormattedEditor(app, page)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await clickMenu(app, 'Open…')
  await page.waitForFunction(
    () =>
      document.querySelector('.titlebar')?.getAttribute('aria-busy') === 'true',
  )
  const toolbar = await page.evaluate(async () => {
    const header = document.querySelector('.titlebar')
    const button = header.querySelector('.sidebar-toggle')
    const frames = []
    for (let frame = 0; frame < 3; frame++) {
      await new Promise(requestAnimationFrame)
      frames.push({
        same: header === document.querySelector('.titlebar'),
        opacity: getComputedStyle(button).opacity,
        busy: header.getAttribute('aria-busy'),
      })
    }
    return frames
  })
  await app.evaluate(() => globalThis.finishImageOpen())
  assert.ok(toolbar.some((frame) => frame.busy === 'true'))
  assert.ok(
    toolbar.every((frame) => frame.same && frame.opacity === '1'),
    JSON.stringify(toolbar),
  )
  await page.waitForFunction(() => {
    const images = [
      ...document.querySelectorAll('.rich-pane img:not(.cm-widgetBuffer)'),
    ]
    return (
      images.length === 4 &&
      images.every((image) => image.complete && image.naturalWidth === 1)
    )
  })
  const revision = (await page.evaluate(() => window.hibi.getDocument()))
    .revision
  assert.equal(
    await page.evaluate(
      (revision) => window.hibi.readDocumentImage('/etc/passwd', revision),
      revision,
    ),
    null,
  )
  assert.equal(
    await page.evaluate(
      (revision) =>
        window.hibi.readDocumentImage('assets/my%20image.png', revision - 1),
      revision,
    ),
    null,
  )

  await rich.focus()
  await rich.press('ControlOrMeta+End')

  await page.keyboard.type(' edited')
  const markdown = (await page.evaluate(() => window.hibi.getDocument()))
    .markdown
  assert.ok(markdown.includes('assets/my%20image.png'))
  assert.ok(imageSources(markdown).has(image))
  assert.ok(!markdown.includes('data:image'))
  await mkdir(join(folder, 'nested'))
  await writeFile(
    join(folder, 'nested', 'page.md'),
    '![root](/assets/my%20image.png)',
  )
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [`${folder}/nested/page.md`],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, folder)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+o`,
  )
  await page
    .locator('.rich-pane img[data-tooltip^="Could not load this media"]')
    .waitFor({ state: 'attached' })
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
  }, folder)
  const snapshot = await page.evaluate(async () => {
    await window.hibi.openWorkspace()
    return window.hibi.getWorkspaceSnapshot()
  })
  await page.waitForFunction(() => {
    const image = document.querySelector('.rich-pane img:not(.cm-widgetBuffer)')
    return image?.complete && image.naturalWidth === 1
  })
  assert.equal(
    snapshot.pages.find((page) => page.path === 'nested/page.md').images[
      '/assets/my%20image.png'
    ],
    `data:image/png;base64,${png.toString('base64')}`,
  )
})

/** A black PNG of this size, one bit per pixel. */
function blankPng(width, height) {
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
  header.writeUInt32BE(height, 4)
  header[8] = 1
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk(
      'IDAT',
      deflateSync(Buffer.alloc((Math.ceil(width / 8) + 1) * height)),
    ),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

unit(
  'a width or height alone keeps an <img> tag image in shape in a narrower column',
  {
    timeout: 30000,
  },
  async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-html-image-shape-'))
    await mkdir(join(folder, 'assets'))
    await writeFile(join(folder, 'assets', 'wide.png'), blankPng(1600, 900))
    const note = join(folder, 'note.md')
    await writeFile(
      note,
      [
        '<img src="assets/wide.png" alt="broad" width=1600>',
        '<img src="assets/wide.png" alt="high" height=900>',
      ].join('\n\n'),
    )
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(6500)
    await waitForFormattedEditor(app, page)
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
    const boxes = await page.waitForFunction(() => {
      const images = ['broad', 'high'].map((alt) =>
        document.querySelector(`.rich-pane img[alt="${alt}"]`),
      )
      if (!images.every((image) => image?.complete && image.naturalWidth))
        return null
      window.loadedAt ??= performance.now()
      const sizes = images.map((image) => {
        const { width, height } = image.getBoundingClientRect()
        return [width, height]
      })
      // A height alone sizes its image as it loads; give that a moment.
      return sizes[1][1] < 900 || performance.now() - window.loadedAt > 1500
        ? sizes
        : null
    })
    for (const [width, height] of await boxes.jsonValue()) {
      assert.ok(width < 1600, `fits the column: ${width}×${height}`)
      assert.ok(
        Math.abs(height - (width * 900) / 1600) < 1,
        `keeps 16:9: ${width}×${height}`,
      )
    }
  },
)

/**
 * Opens a note with a remote 1600×900 `<img>` sized only by its height above
 * 400 lines, from an https host that answers `delay` ms after each request.
 */
async function openTallRemoteImage(t, delay) {
  const image = blankPng(1600, 900)
  const requests = []
  let markServed
  /** Settles once the host has sent the image. */
  const served = new Promise((resolve) => {
    markServed = resolve
  })
  const server = createServer(
    {
      cert: await readFile('tests/fixtures/host-network-localhost-cert.pem'),
      key: await readFile('tests/fixtures/host-network-localhost-key.pem'),
    },
    (request, response) => {
      requests.push(request.url)
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'image/png' })
        response.end(image, markServed)
      }, delay)
    },
  )
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const folder = await mkdtemp(join(tmpdir(), 'hibi-remote-image-shape-'))
  const note = join(folder, 'note.md')
  const lines = Array.from(
    { length: 400 },
    (_, line) => `Line ${line} below the image.`,
  )
  await writeFile(
    note,
    `# Title\n\n<img src="https://127.0.0.1:${server.address().port}/wide.png" alt="high" height="900">\n\n${lines.join('\n\n')}\n`,
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    server.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ session }) =>
    session.defaultSession.setCertificateVerifyProc((_request, done) =>
      done(0),
    ),
  )
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  await waitForFormattedEditor(app, page)
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
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.rich-pane .cm-line')].some(
      (line) => line.textContent === 'Line 8 below the image.',
    ),
  )
  return { page, requests, served }
}

unit(
  'a remote <img> with only a height, drawn again from memory above the text, is in shape as it is drawn',
  {
    timeout: 60000,
  },
  async (t) => {
    const { page } = await openTallRemoteImage(t, 0)
    await page.waitForFunction(() => {
      const image = document.querySelector('.rich-pane img[alt="high"]')
      return !!image?.complete && image.getBoundingClientRect().height < 900
    })
    // Far down, its widget is gone and the loaded image is held in memory.
    await page.evaluate(() => {
      const pane = document.querySelector('.rich-pane')
      pane.scrollTop = pane.scrollHeight
    })
    await page.waitForFunction(
      () => !document.querySelector('.rich-pane img[alt="high"]'),
    )
    // Back with "Line 8" at the top, the image is drawn again just above it.
    const { boxes, lines } = await page.evaluate(async () => {
      const pane = document.querySelector('.rich-pane')
      const content = pane.querySelector('.cm-content')
      const { view } = content.cmTile.root
      // Its size as drawn, before its load event can run.
      const boxes = []
      const drawn = new MutationObserver(() => {
        const image = content.querySelector('img[alt="high"]')
        if (!image) return
        const { width, height } = image.getBoundingClientRect()
        boxes.push([width, height])
      })
      drawn.observe(content, { childList: true, subtree: true })
      view.dispatch({
        effects: view.constructor.scrollIntoView(
          view.state.doc.toString().indexOf('Line 8 below'),
          { y: 'start' },
        ),
      })
      const lines = []
      for (let frame = 0; frame < 30; frame++) {
        await new Promise(requestAnimationFrame)
        const line = [...content.querySelectorAll('.cm-line')].find(
          (line) => line.textContent === 'Line 12 below the image.',
        )
        lines.push(
          line &&
            Math.round(
              line.getBoundingClientRect().top -
                pane.getBoundingClientRect().top,
            ),
        )
      }
      drawn.disconnect()
      return { boxes, lines }
    })
    assert.ok(boxes.length, 'drawn again')
    for (const [width, height] of boxes)
      assert.ok(
        Math.abs(height - (width * 900) / 1600) < 1,
        `keeps 16:9 as drawn: ${JSON.stringify(boxes)}`,
      )
    // So the text below it holds still.
    assert.equal(new Set(lines).size, 1, JSON.stringify(lines))
  },
)

unit(
  'a slow remote <img> with only a height takes its shape above the text as soon as its size is known',
  {
    timeout: 60000,
  },
  async (t) => {
    const { page, requests, served } = await openTallRemoteImage(t, 1500)
    // Before the image arrives, "Line 8" goes to the top, the image above it.
    await page.evaluate(() => {
      const pane = document.querySelector('.rich-pane')
      const line = [...pane.querySelectorAll('.cm-line')].find(
        (line) => line.textContent === 'Line 8 below the image.',
      )
      pane.scrollTop +=
        line.getBoundingClientRect().top - pane.getBoundingClientRect().top
    })
    // There, out of sight, its line takes the image's shape once it arrives.
    // The wait starts when the host has sent it, so a slow machine doesn't
    // spend it before the image exists. The widget's own <img> can't be
    // watched: once shaped, the line's widget is redrawn and the loaded
    // image moves out of the page to the tab's held images.
    await served
    const lineHeight = () =>
      page.evaluate(() => {
        const { view } = document.querySelector('.rich-pane .cm-content').cmTile
          .root
        return view.lineBlockAt(view.state.doc.toString().indexOf('<img'))
          .height
      })
    const height = await page
      .waitForFunction(
        () => {
          const { view } = document.querySelector('.rich-pane .cm-content')
            .cmTile.root
          const { height } = view.lineBlockAt(
            view.state.doc.toString().indexOf('<img'),
          )
          return height < 900 ? height : null
        },
        null,
        { timeout: 15000 },
      )
      .then((shaped) => shaped.jsonValue(), lineHeight)
    assert.ok(height < 900, `image line shaped, not 900 px tall: ${height}`)
    // Scrolled to, even after a collection, it shows in shape at once and
    // without another download.
    const cdp = await page.context().newCDPSession(page)
    for (let pass = 0; pass < 2; pass++)
      await cdp.send('HeapProfiler.collectGarbage')
    const frames = await page.evaluate(async () => {
      const pane = document.querySelector('.rich-pane')
      pane.scrollTop = 0
      const frames = []
      for (let frame = 0; frame < 20; frame++) {
        await new Promise(requestAnimationFrame)
        const image = pane
          .querySelector('img[alt="high"]')
          ?.getBoundingClientRect()
        frames.push(image && [image.width, image.height])
      }
      return frames
    })
    const drawn = frames.filter(Boolean)
    assert.ok(drawn.length, JSON.stringify(frames))
    for (const [width, height] of drawn)
      assert.ok(
        Math.abs(height - (width * 900) / 1600) < 1,
        `keeps 16:9 in every frame: ${JSON.stringify(frames)}`,
      )
    assert.deepEqual(requests, ['/wide.png'])
  },
)

unit(
  'formatted view shows raw HTML images at their size and place, and reveals their source at the caret',
  {
    timeout: 30000,
  },
  async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-html-images-'))
    await mkdir(join(folder, 'assets'))
    await writeFile(join(folder, 'assets', 'pixel.png'), png)
    const note = join(folder, 'note.md')
    await writeFile(
      note,
      [
        '<img src="assets/pixel.png" alt="block">',
        '### Heading',
        '<img src="assets/pixel.png" alt="tag">',
        '### Heading',
        '![markdown](assets/pixel.png)',
        'text <img src=assets/pixel.png alt="inline" width=3 height=2>',
        'wide <img src=assets/pixel.png alt="wide" width=4000 height=1000>',
      ].join('\n\n'),
    )
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(6500)
    const editor = await waitForFormattedEditor(app, page)
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
    const loaded = () =>
      page.waitForFunction(() => {
        const images = [
          ...document.querySelectorAll('.rich-pane img:not(.cm-widgetBuffer)'),
        ]
        return (
          images.map((image) => image.alt).join() ===
            'block,tag,markdown,inline,wide' &&
          images.every((image) => image.complete && image.naturalWidth === 1)
        )
      })
    await loaded()
    // A tag alone on its line sits where a Markdown image would, and a tag
    // sizes its image, keeping its shape in a narrower column.
    const { gaps, size, wide } = await page.evaluate(() => {
      const content = document.querySelector(
        '.rich-pane .hibi-formatted .cm-content',
      )
      const headings = [...content.querySelectorAll('.hibi-lp-heading')].map(
        (heading) => heading.closest('.cm-line'),
      )
      const box = (alt) =>
        content.querySelector(`img[alt="${alt}"]`).getBoundingClientRect()
      const inline = content.querySelector('img[alt="inline"]')
      return {
        gaps: ['tag', 'markdown'].map(
          (alt, index) =>
            box(alt).top - headings[index].getBoundingClientRect().bottom,
        ),
        size: [
          inline.getAttribute('width'),
          inline.getAttribute('height'),
          box('inline').width,
          box('inline').height,
        ],
        wide: [box('wide').width, box('wide').height],
      }
    })
    // A triple-click on a tag's image selects the tag, as on a Markdown image.
    const image = await page
      .locator('.rich-pane img[alt="wide"]:not(.cm-widgetBuffer)')
      .boundingBox()
    await page.mouse.click(
      image.x + image.width / 2,
      image.y + image.height / 2,
      { clickCount: 3 },
    )
    assert.equal(
      await page.evaluate(() => {
        const { view } = document.querySelector(
          '.rich-pane [aria-label="Document editor"]',
        ).cmTile.root
        const { from, to } = view.state.selection.main
        return view.state.sliceDoc(from, to)
      }),
      '<img src=assets/pixel.png alt="wide" width=4000 height=1000>',
    )
    assert.equal(gaps[0], gaps[1])
    assert.deepEqual(size, ['3', '2', 3, 2])
    assert.ok(wide[0] < 4000, `wide image fits the column: ${wide}`)
    assert.ok(
      Math.abs(wide[1] - wide[0] / 4) < 1,
      `wide image keeps 4:1: ${wide}`,
    )
    // At the caret, a tag shows as source with its image still beside it.
    const shown = async (key, source, hidden) => {
      await editor.press(key)
      await page.waitForFunction(
        ([source, hidden]) => {
          const text = document.querySelector(
            '.rich-pane .hibi-formatted .cm-content',
          ).textContent
          return text.includes(source) && !text.includes(hidden)
        },
        [source, hidden],
      )
      await loaded()
    }
    await editor.focus()
    await shown(
      'ControlOrMeta+Home',
      '<img src="assets/pixel.png" alt="block">',
      'alt="inline"',
    )
    await shown(
      'ControlOrMeta+End',
      '<img src=assets/pixel.png alt="wide" width=4000 height=1000>',
      'alt="block"',
    )
  },
)
