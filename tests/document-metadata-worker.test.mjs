import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  stopElectronTree,
  waitForDocumentEditor,
} from './electron.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'

test('native module worker loads metadata lazily, shares find, and releases parser owners', {
  timeout: 30000,
}, async (t) => {
  const asset = (await readdir(resolve('out/renderer/assets'))).find((name) =>
    /^document\.worker-.+\.js$/.test(name),
  )
  assert.ok(asset, 'Build the document worker before running this test.')
  const profile = await mkdtemp(join(tmpdir(), 'hibi-metadata-worker-'))
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'word-count': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const watchdog = setTimeout(() => stopElectronTree(app.process()), 25000)
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => {})
    clearTimeout(watchdog)
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: 'Document editor', exact: true }),
    'one two',
  )
  await page.getByText('2 words · 7 characters', { exact: true }).waitFor()
  const header = '---\r\nname: hibi\r\n---\r\n\r\n'
  const result = await page.evaluate(async (asset) => {
    const header = '---\r\nname: hibi\r\n---\r\n\r\n'
    const worker = new Worker(new URL(`./assets/${asset}`, location.href), {
      type: 'module',
    })
    const request = (message, type) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error(`Missing ${type} reply`)),
          5000,
        )
        const receive = (event) => {
          if (event.data.type === 'error') finish(new Error(event.data.message))
          else if (event.data.type === type) finish(null, event.data)
        }
        const fail = (event) =>
          finish(new Error(event.message || 'Worker module failed to load'))
        const finish = (error, value) => {
          clearTimeout(timer)
          worker.removeEventListener('message', receive)
          worker.removeEventListener('error', fail)
          if (error) reject(error)
          else resolve(value)
        }
        worker.addEventListener('message', receive)
        worker.addEventListener('error', fail)
        worker.postMessage(message)
      })
    const source = '# one\r\n\r\none paragraph\r\n',
      epoch = 'native-probe',
      document = { tabId: 'probe', revision: 0 }
    const load = async (epoch, source) => {
      const streamId = crypto.randomUUID(),
        head = {
          ...document,
          contentVersion: 0,
          streamId,
          length: source.length,
        }
      let reply = await request({ type: 'load-start', epoch, head }, 'load-ack')
      for (let from = 0; from < source.length || from === 0; from += 65536) {
        const done = from + 65536 >= source.length
        reply = await request(
          {
            type: 'load-chunk',
            epoch,
            chunk: {
              ...reply.request,
              chunks: [source.slice(from, from + 65536)],
              done,
            },
          },
          'load-ack',
        )
        if (done) break
      }
      await request(
        { type: 'load-finish', epoch, request: reply.request },
        'ack',
      )
    }
    try {
      await load(epoch, source)
      const first = await request(
        {
          type: 'metadata',
          epoch,
          id: 1,
          version: 0,
          dialect: 'commonmark',
          from: 0,
          to: source.length,
          limit: 2,
        },
        'metadata',
      )
      const find = await request(
        {
          type: 'find',
          epoch,
          id: 1,
          version: 0,
          query: 'one',
          from: 0,
          to: 0,
        },
        'find',
      )
      await request(
        {
          type: 'edit',
          epoch,
          operation: {
            document,
            operationId: 'prefix',
            baseVersion: 0,
            contentVersion: 1,
            origin: 'source',
            historyGroup: 'prefix',
            changes: [{ from: 0, to: 0, insert: '# prefix\r\n\r\n' }],
          },
        },
        'ack',
      )
      const second = await request(
        {
          type: 'metadata',
          epoch,
          id: 2,
          version: 1,
          dialect: 'commonmark',
          from: 0,
          to: 10,
          limit: 2,
        },
        'metadata',
      )
      const canceled = await request(
        { type: 'cancel-metadata', epoch, id: 2, release: true },
        'metadata-canceled',
      )
      const reopened = await request(
        {
          type: 'metadata',
          epoch,
          id: 3,
          version: 1,
          dialect: 'commonmark',
          from: 0,
          to: 10,
          limit: 2,
        },
        'metadata',
      )
      const projected = header + '# body\r\n'
      await load('frontmatter', projected)
      const frontmatter = await request(
        {
          type: 'metadata',
          epoch: 'frontmatter',
          id: 1,
          version: 0,
          dialect: 'gfm',
          frontmatter: true,
          from: 0,
          to: projected.length,
          limit: 2,
        },
        'metadata',
      )
      return {
        first: {
          complete: first.page.complete,
          rows: first.page.rows.length,
          from: first.page.rows[0].from,
          to: first.page.rows[0].to,
        },
        matches: find.location.total,
        second: {
          version: second.page.version,
          to: second.page.rows[0].to,
          sameOwners: second.page.epoch === first.page.epoch,
        },
        released: canceled.release,
        newOwners: reopened.page.epoch !== second.page.epoch,
        frontmatter: {
          dialect: frontmatter.page.dialect,
          kind: frontmatter.page.rows[0].owner.kind,
          to: frontmatter.page.rows[0].to,
          headingFrom: frontmatter.page.rows[1].from,
        },
      }
    } finally {
      worker.terminate()
    }
  }, asset)
  assert.deepEqual(result, {
    first: { complete: true, rows: 2, from: 0, to: 5 },
    matches: 2,
    second: { version: 1, to: 8, sameOwners: true },
    released: true,
    newOwners: true,
    frontmatter: {
      dialect: 'gfm+frontmatter',
      kind: 'markdown:Frontmatter',
      to: header.length,
      headingFrom: header.length,
    },
  })
})

test('a cold reference lookup resolves the outline of a 50 MiB source note', {
  timeout: 120000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-cold-reference-'))
  const file = join(folder, 'linked.md')
  const block = `## [heading][ref]\n\n${`${'plain text body '.repeat(15)}\n`.repeat(16)}\n\n`
  const prefix = '[ref]: /target\n\n'
  const source = (
    prefix +
    block.repeat(Math.floor((50 * 1024 * 1024 - prefix.length) / block.length))
  ).padEnd(50 * 1024 * 1024, ' ')
  await writeFile(file, source)
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
  const page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  await page.setViewportSize({ width: 1100, height: 800 })
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await page
    .getByRole('textbox', { name: 'Markdown editor', exact: true })
    .waitFor()
  await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
  await page.getByRole('button', { name: /^right sidebar views$/i }).click()
  await page
    .getByRole('menuitem', { name: 'On this page', exact: true })
    .click()
  const handle = await page.waitForFunction(() => {
    const outline = document.querySelector(
      '.outline-sidebar[data-side="right"][data-open="true"]',
    )
    const labels = [...(outline?.querySelectorAll('.sidebar-label') ?? [])].map(
      (node) => node.textContent,
    )
    const text = outline?.textContent ?? ''
    if (labels.length || text.includes('could not')) return { labels, text }
  })
  const result = await handle.jsonValue()
  assert.ok(result.labels.length, result.text)
  assert.ok(result.labels.every((label) => label === 'heading'))
  const canonical = await page.evaluate(
    async () => (await window.hibi.getDocument()).markdown,
  )
  assert.ok(canonical === source, 'reference lookup preserves exact source')
})
