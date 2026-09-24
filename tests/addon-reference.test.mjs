import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { parse } from '@babel/parser'
import { marked } from 'marked'
import {
  parseDeclarations,
  referencePages,
  referenceRoot,
} from '../scripts/addon-reference.mjs'
import { defineColorscheme } from '../src/shared/colorschemes.ts'
import { electron, waitForElectronShutdown } from './electron.mjs'

test('windows profile cleanup waits for electron transport closure', async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
  })
  let closeTransport
  const transport = new Promise((resolve) => {
    closeTransport = resolve
  })
  let settled = false
  const shutdown = waitForElectronShutdown(child, transport, 'win32').then(
    () => {
      settled = true
    },
  )
  child.exitCode = 0
  child.emit('exit', 0, null)
  await Promise.resolve()
  assert.equal(settled, false)
  closeTransport()
  await shutdown
  assert.equal(settled, true)

  const crashed = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
  })
  const failure = waitForElectronShutdown(crashed, Promise.resolve(), 'win32')
  crashed.signalCode = 'SIGKILL'
  crashed.emit('exit', null, 'SIGKILL')
  await assert.rejects(failure, /signal SIGKILL/)
})

test('API reference extracts signatures, nested members, comments, and type links without function bodies', () => {
  const records = parseDeclarations(
    'src/example.ts',
    [
      '/** A saved result. */',
      'type Result = { value: string }',
      '/** Tools for notes. */',
      'export type Tools = {',
      '  readonly settings?: { enabled: boolean }',
      "  'aria-label': string",
      '  editor: {',
      '    /** Read a note.',
      '     * @param name A workspace-relative name.',
      '     * @returns The matching note, if one exists.',
      '     */',
      '    read: <T extends Result>(name: string, fallback?: T) => Promise<T | null>',
      '  }',
      '}',
      'export interface Loader { load(name: string): Result }',
      '/** Build tools.',
      ' * @example const tools = createTools()',
      ' */',
      'export function createTools(): Tools { throw new Error("private implementation") }',
    ].join('\n'),
    'Example',
  )
  const pages = referencePages(records)
  const tools = pages.get(`${referenceRoot}/Tools.md`)
  assert.match(tools, /## Methods[\s\S]*### editor.read/)
  assert.match(tools, /Readonly · Optional/)
  assert.match(tools, /'aria-label': string/)
  assert.ok(!tools.includes('readonly editor.read'))
  assert.match(tools, /<code>fallback\?<\/code>/)
  assert.match(tools, /A workspace-relative name/)
  assert.match(tools, /Promise&lt;T &#124; null&gt;/)
  assert.match(tools, /The matching note, if one exists/)
  assert.match(tools, /\[Result\]\(Result.md\)/)
  assert.match(pages.get(`${referenceRoot}/Result.md`), /Supporting type/)
  const loader = pages.get(`${referenceRoot}/Loader.md`)
  assert.match(loader, /## Methods[\s\S]*### load/)
  assert.match(
    loader,
    /\*\*Returns:\*\* <code><a href="Result.md">Result<\/a><\/code>/,
  )
  const create = pages.get(`${referenceRoot}/createTools.md`)
  assert.match(create, /function createTools\(\): Tools/)
  assert.match(create, /## Examples[\s\S]*const tools = createTools\(\)/)
  assert.ok(!create.includes('private implementation'))
})

test('development guide examples parse and the sample theme validates', async () => {
  const files = await readdir('docs/development/addons')
  let samples = 0
  for (const file of files) {
    const source = await readFile(join('docs/development/addons', file), 'utf8')
    for (const token of marked.lexer(source)) {
      if (token.type !== 'code') continue
      if (['typescript', 'tsx', 'javascript'].includes(token.lang)) {
        assert.doesNotThrow(
          () =>
            parse(token.text, {
              sourceType: 'module',
              plugins: ['typescript', 'jsx'],
            }),
          file,
        )
        samples++
      }
      if (token.lang === 'json') {
        const manifest = JSON.parse(token.text)
        if ('id' in manifest) {
          assert.equal(manifest.apiVersion, 2)
          assert.ok(manifest.version)
        }
        if (manifest.themes) manifest.themes.forEach(defineColorscheme)
        samples++
      }
    }
  }
  assert.ok(samples >= 8)
})

test('published development docs render linked, highlighted API pages offline at desktop and mobile sizes', {
  timeout: 60000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-reference-'))
  let app
  t.after(async () => {
    try {
      await app?.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  const output = join(directory, 'index.html')
  await promisify(execFile)(process.execPath, [
    'scripts/export-docs.mjs',
    'docs',
    output,
  ])
  const html = await readFile(output, 'utf8')
  const data = JSON.parse(
    html.match(
      /<script id="workspace-data" type="application\/json">([\s\S]*?)<\/script>/,
    )[1],
  )
  assert.ok(
    data.pages.some(
      (page) => page.path === 'development/addons/creating-your-first-addon.md',
    ),
  )
  assert.ok(!data.pages.some((page) => page.path.startsWith('ai-agents/')))
  const dialog = data.pages.find(
    (page) => page.path === 'development/addon-api-reference/DialogApi.md',
  )
  assert.match(dialog.html, /hibi-token-keyword/)
  app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(directory, 'profile')}`],
    colorScheme: null,
  })
  await app.firstWindow()
  const next = app.waitForEvent('window')
  await app.evaluate(
    ({ BrowserWindow }, url) => {
      const viewer = new BrowserWindow({
        width: 1280,
        height: 900,
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      })
      void viewer.loadURL(url)
    },
    `${pathToFileURL(output).href}#page=development%2Faddon-api-reference%2FDialogApi.md`,
  )
  const page = await next
  await page.getByRole('heading', { name: 'DialogApi', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => typeof window.hibi), 'undefined')
  assert.ok(await page.locator('article pre .hibi-token-keyword').count())
  await page
    .locator('article a')
    .filter({ hasText: /^prompt$/ })
    .click()
  await page.waitForFunction(
    () => document.querySelector('.site-content').scrollTop > 0,
  )
  assert.match(await page.url(), /anchor=prompt/)
  await page
    .locator('article table a')
    .filter({ hasText: /^PromptDialogOptions$/ })
    .click()
  await page
    .getByRole('heading', { name: 'PromptDialogOptions', exact: true })
    .waitFor()
  await page
    .getByRole('button', { name: 'Search documentation', exact: true })
    .click()
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('DialogApi')
  await page
    .getByRole('option', { name: /DialogApi/ })
    .first()
    .click()
  await page.getByRole('heading', { name: 'DialogApi', exact: true }).waitFor()
  await mkdir('test-results', { recursive: true })
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    if (width < 700)
      await page.waitForFunction(
        () =>
          document.querySelector('.documentation-site').dataset.sidebar ===
            'false' &&
          document.querySelector('.sidebar').getBoundingClientRect().right <=
            1 &&
          getComputedStyle(document.querySelector('.site-nav-scrim'))
            .visibility === 'hidden',
      )
    const geometry = await page
      .locator('.site-content')
      .evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
      }))
    assert.ok(
      geometry.scrollWidth <= geometry.width + 1,
      'the page must not scroll sideways',
    )
    assert.equal(geometry.pageOverflow, false)
    await page.screenshot({ path: `test-results/api-reference-${width}.png` })
  }
  assert.deepEqual(await page.pageErrors(), [])
})
