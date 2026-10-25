import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { parse } from '@babel/parser'
import { collectLicenses } from '../scripts/licenses.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const { version: appVersion } = JSON.parse(
  await readFile('package.json', 'utf8'),
)
const { rollup } = createRequire(import.meta.resolve('vite'))('rollup')

test('main builds keep fresh licenses, bundled production workers and dev externals', {
  timeout: 5000,
}, async (t) => {
  const source = await readFile('electron.vite.config.ts', 'utf8')
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  const property = (object, key) =>
    object.properties.find((item) => item.key?.name === key)?.value
  const config = ast.program.body.find(
    (item) => item.type === 'ExportDefaultDeclaration',
  ).declaration.arguments[0]
  const policy = property(
    property(property(config, 'main'), 'build'),
    'externalizeDeps',
  )
  const externalize = new Function(
    'process',
    'return (' +
      (policy ? source.slice(policy.start, policy.end) : 'true') +
      ')',
  )
  const worker = parse(
    await readFile('src/addons/_shared/format-worker.ts', 'utf8'),
    {
      sourceType: 'module',
      plugins: ['typescript'],
      createImportExpressions: true,
    },
  )
  const { devDependencies } = JSON.parse(await readFile('package.json', 'utf8'))
  const imports = []
  function visit(node) {
    if (
      (node.type === 'ImportDeclaration' && node.importKind !== 'type') ||
      (node.type === 'ImportExpression' && node.source.type === 'StringLiteral')
    )
      imports.push(node.source.value)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child)
      } else if (value?.type) visit(value)
    }
  }
  visit(worker)
  const dependencies = imports
    .map((source) => source.match(/^(@[^/]+\/[^/]+|[^/]+)/)[0])
    .filter((name) => Object.hasOwn(devDependencies, name))
  assert.equal(
    externalize({ env: {} }),
    true,
    'unset mode keeps default externals',
  )
  assert.equal(
    externalize({ env: { NODE_ENV_ELECTRON_VITE: 'production' } }),
    true,
    'production keeps default externals',
  )
  assert.deepEqual(
    new Set(
      externalize({ env: { NODE_ENV_ELECTRON_VITE: 'development' } }).include,
    ),
    new Set(dependencies),
    'development externals match worker devDependencies',
  )
  const plugin = property(property(config, 'main'), 'plugins').elements.find(
    (item) =>
      item.type === 'ObjectExpression' &&
      property(item, 'name')?.value === 'app-licenses',
  )
  const state = ast.program.body.filter(
    (item) =>
      item.type === 'VariableDeclaration' &&
      item.declarations.some((declaration) =>
        ['licenseBuild', 'drainLicenses'].includes(declaration.id.name),
      ),
  )
  const makePlugin = new Function(
    'writeLicenses',
    `${stripTypeScriptTypes(
      `${state.map((node) => source.slice(node.start, node.end)).join('\n')}
const plugin = (${source.slice(plugin.start, plugin.end)})`,
    )}\nreturn plugin`,
  )
  const root = await mkdtemp(join(tmpdir(), 'hibi-license-build-'))
  let gate,
    operation,
    bundle,
    calls = 0,
    completed = 0
  t.after(async () => {
    gate?.resolve()
    await operation
    await bundle?.close()
    await rm(root, { recursive: true, force: true })
  })
  const licensing = makePlugin(async () => {
    const call = ++calls
    await gate.promise
    completed = call
  })
  for (const round of [1, 2]) {
    gate = Promise.withResolvers()
    const graphFinished = Promise.withResolvers()
    let finished = false
    operation = rollup({
      input: 'entry',
      plugins: [
        licensing,
        {
          name: 'license-build-proof',
          resolveId(id) {
            if (id === 'entry') return '\0entry'
          },
          load(id) {
            if (id === '\0entry') return `export default ${round}`
          },
          buildEnd() {
            graphFinished.resolve()
          },
          generateBundle() {
            assert.equal(completed, round)
          },
          writeBundle() {
            assert.equal(completed, round)
          },
        },
      ],
    })
      .then(async (result) => {
        bundle = result
        await result.write({ file: join(root, 'entry.js'), format: 'esm' })
      })
      .then(
        () => {
          finished = true
        },
        (error) => {
          finished = true
          return error
        },
      )
    await graphFinished.promise
    t.signal.throwIfAborted()
    await nextTurn()
    assert.equal(calls, round, 'each build starts fresh license work')
    assert.equal(completed, round - 1, 'graph finishes while licensing waits')
    assert.equal(finished, false, 'output remains gated by licensing')
    gate.resolve()
    const error = await operation
    if (error) throw error
    assert.equal(completed, round)
    assert.match(
      await readFile(join(root, 'entry.js'), 'utf8'),
      new RegExp(`= ${round}`),
    )
    await bundle.close()
  }
})

test('license collection reads each manifest once and starts fresh next time', async (t) => {
  const source = await readFile('scripts/licenses.ts', 'utf8')
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  const declarations = ast.program.body.flatMap((node) => {
    const value = node.declaration ?? node
    return value.id?.name === 'collectLicenses' ||
      value.declarations?.some((item) => item.id.name === 'buildTools')
      ? [source.slice(value.start, value.end)]
      : []
  })
  const reads = new Map()
  const collect = new Function(
    'readFile',
    'readdir',
    'basename',
    'dirname',
    'join',
    'resolve',
    'themeLicenses',
    `${stripTypeScriptTypes(declarations.join('\n'))}\nreturn collectLicenses`,
  )(
    async (path, ...args) => {
      reads.set(path, (reads.get(path) ?? 0) + 1)
      return readFile(path, ...args)
    },
    readdir,
    basename,
    dirname,
    join,
    resolve,
    {},
  )
  const root = await mkdtemp(join(tmpdir(), 'hibi-license-inputs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { a: '1', b: '1', node_modules: '1' } }),
  )
  for (const name of ['a', 'b', 'shared', 'node_modules']) {
    const folder = join(root, 'node_modules', name)
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'package.json'),
      JSON.stringify({
        name,
        version: '1',
        ...(name === 'shared' ? {} : { dependencies: { shared: '1' } }),
      }),
    )
    await writeFile(join(folder, 'LICENSE'), `notice ${name}`)
  }
  const manifest = join(root, 'node_modules/shared/package.json')
  const notice = join(root, 'node_modules/shared/LICENSE')
  const first = await collect(root)
  assert.equal(first.length, 4)
  assert.equal(
    reads.has(
      join(root, 'node_modules', 'node_modules', 'shared', 'package.json'),
    ),
    false,
    'ancestor node_modules does not add another node_modules lookup',
  )
  assert.ok(first.some((entry) => entry.name === 'node_modules'))
  assert.equal(
    reads.get(manifest),
    1,
    'shared manifest is read once across dependency links',
  )
  assert.ok(
    [...reads]
      .filter(([path]) => path.endsWith('/package.json'))
      .every(([, count]) => count === 1),
  )
  await writeFile(notice, 'changed notice without a version change')
  reads.clear()
  assert.match(
    (await collect(root)).find((entry) => entry.name === 'shared').text,
    /changed notice without a version change/,
  )
  assert.equal(
    reads.get(manifest),
    1,
    'next collection reads installed metadata again',
  )
  await writeFile(manifest, '{')
  await assert.rejects(collect(root), SyntaxError)
  await writeFile(manifest, JSON.stringify({ name: 'shared', version: '2' }))
  assert.equal(
    (await collect(root)).find((entry) => entry.name === 'shared').version,
    '2',
  )
})

test('license catalog retains dependency and palette notices, excluding build tools', async () => {
  const entries = await collectLicenses()
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length)
  assert.match(
    entries.find((entry) => entry.name === 'isarray').text,
    /Copyright.*Julian Gruber/,
  )
  for (const name of [
    'react',
    'react-dom',
    'electron',
    'geist',
    'dompurify',
    'pele',
    '@codemirror/view',
    '@tiptap/core',
    '@tiptap/extension-drag-handle',
    '@tiptap/extension-node-range',
    '@tiptap/extension-collaboration',
    '@tiptap/y-tiptap',
    'yjs',
    'y-protocols',
    'lib0',
    '@replit/codemirror-vim',
    'catppuccin colorscheme',
  ])
    assert.ok(entries.some((entry) => entry.name === name && entry.text.trim()))
  for (const name of [
    'typescript',
    'playwright',
    'electron-builder',
    '@electron/get',
    'next',
    '@next/env',
  ])
    assert.equal(
      entries.some((entry) => entry.name === name),
      false,
    )
  assert.ok(
    entries
      .find((entry) => entry.name === 'react')
      .text.includes(await readFile('node_modules/react/LICENSE', 'utf8')),
  )
  assert.ok(
    entries
      .find((entry) => entry.name === 'dompurify')
      .text.includes(
        await readFile('node_modules/dompurify/LICENSE-MPL', 'utf8'),
      ),
  )
  // Pele's notice also covers the Lucide icon it bundles.
  assert.ok(
    entries
      .find((entry) => entry.name === 'pele')
      .text.includes(await readFile('node_modules/pele/LICENSE', 'utf8')),
  )
})

test('licenses open on their own settings page and dialogs stay readable', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-about-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await clickMenu(app, 'Settings')
  const sidebar = page.getByRole('tablist', { name: /settings categories/i })
  assert.equal(
    await sidebar.getByRole('tab').first().innerText(),
    'Workspace settings',
  )
  await sidebar.getByRole('tab', { name: 'About', exact: true }).click()
  assert.equal(
    await page
      .getByRole('tab', { name: /^about$/i, exact: true })
      .getAttribute('aria-selected'),
    'true',
  )
  const panel = page.getByRole('tabpanel', { name: /^about$/i, exact: true })
  await panel.getByText(`Version ${appVersion}`, { exact: true }).waitFor()
  assert.equal(await panel.locator('.license-row').count(), 0)
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      globalThis.openedUrl = url
    }
  })
  for (const [name, url] of [
    ['may', 'https://github.com/schmayterling'],
    [
      'beloved contributors',
      'https://github.com/schmayterling/hibi/graphs/contributors',
    ],
  ]) {
    await panel.getByRole('link', { name, exact: true }).press('Enter')
    assert.equal(await app.evaluate(() => globalThis.openedUrl), url)
  }
  await panel
    .getByRole('link', { name: /support hibi development/i })
    .press('Enter')
  assert.equal(
    await app.evaluate(() => globalThis.openedUrl),
    'https://github.com/sponsors/schmayterling',
  )
  await panel.getByRole('link', { name: /^docs$/i }).click()
  assert.equal(
    await app.evaluate(() => globalThis.openedUrl),
    'https://docs.hibi.garden/',
  )
  await panel.getByRole('link', { name: /^report an issue$/i }).click()
  assert.equal(
    await app.evaluate(() => globalThis.openedUrl),
    'https://github.com/schmayterling/hibi/issues',
  )
  await panel.getByRole('link', { name: /^contribute$/i }).click()
  assert.equal(
    await app.evaluate(() => globalThis.openedUrl),
    'https://github.com/schmayterling/hibi',
  )
  await panel.getByRole('link', { name: /^join the discord$/i }).click()
  assert.equal(
    await app.evaluate(() => globalThis.openedUrl),
    'https://discord.gg/v9r4cABUP2',
  )
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/hibi-settings.png',
    animations: 'disabled',
  })
  await sidebar.getByRole('tab', { name: 'Credits' }).click()
  const licensesPanel = page.getByRole('tabpanel', {
    name: 'Credits',
  })
  await licensesPanel.getByRole('heading', { name: 'Credits' }).waitFor()
  const react = licensesPanel
    .getByRole('button')
    .filter({ has: page.locator('.license-name', { hasText: /^react19/ }) })
  await react.waitFor()
  await page.evaluate(() => document.fonts.ready)
  assert.deepEqual(
    await react.evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.borderRadius, style.paddingLeft, style.paddingRight]
    }),
    ['0px', '16px', '16px'],
  )
  const catalog = await page.evaluate(() => window.hibi.getLicenses())
  const hoverBounds = await react.evaluate((element) => {
    const row = element.getBoundingClientRect(),
      card = element.parentElement.getBoundingClientRect()
    return [row.left - card.left, card.right - row.right]
  })
  assert.ok(
    hoverBounds.every((value) => Math.abs(value - 1) < 1),
    JSON.stringify(hoverBounds),
  )
  assert.equal(
    await licensesPanel.locator('.license-row').count(),
    catalog.length,
  )
  assert.ok(catalog.every((entry) => !('text' in entry)))
  const licenseFilter = licensesPanel.getByRole('searchbox', {
    name: /filter licenses/i,
  })
  await licenseFilter.fill('REACT')
  await react.waitFor()
  const dompurify = licensesPanel
    .getByRole('button')
    .filter({ has: page.locator('.license-name', { hasText: /^dompurify/ }) })
  assert.equal(await dompurify.isVisible(), false)
  await licenseFilter.fill(
    catalog.find((entry) => entry.name === 'react').version,
  )
  await react.waitFor()
  assert.equal(await dompurify.isVisible(), false)
  await licenseFilter.fill('MPL')
  await dompurify.waitFor()
  assert.equal(await react.isVisible(), false)
  await licenseFilter.fill('no-such-license-130')
  await licensesPanel
    .getByText('No matching licenses', { exact: true })
    .waitFor()
  assert.equal(await licensesPanel.locator('.license-row:visible').count(), 0)
  await licenseFilter.fill('')
  await react.waitFor()
  assert.equal(
    await licensesPanel.locator('.license-row').count(),
    catalog.length,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.getLicense('../package.json')),
    /This license is no longer available\./,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.getLicense(42)),
    /Choose a license to view\./,
  )
  await page.screenshot({
    path: 'test-results/licenses-settings.png',
    animations: 'disabled',
  })
  await react.press('Enter')
  const dialog = page.getByRole('dialog', { name: /^react$/i, exact: true })
  await dialog.locator('.license-text').waitFor()
  assert.ok(
    (await dialog.locator('.license-text').innerText()).includes(
      await readFile('node_modules/react/LICENSE', 'utf8'),
    ),
  )
  await page.screenshot({
    path: 'test-results/license-dialog.png',
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(
    await react.evaluate((el) => el === document.activeElement),
    true,
  )
  for (const width of [480, 1000]) {
    await page.setViewportSize({ width, height: 720 })
    assert.equal(
      await licensesPanel.evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
    )
    await react.press('Enter')
    await dialog.locator('.license-text').waitFor()
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
    )
    await page.mouse.click(3, 3)
    await dialog.waitFor({ state: 'hidden' })
  }
  assert.deepEqual(errors, [])
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  assert.equal(await page.locator('.colorscheme-license').count(), 0)
})
