import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const notice =
  'Mixed features has features made for the previous formatted editor. Those features are off until it is updated; source view is unaffected.'

test('partially migrated addons keep each legacy feature literal through registration and activation changes', {
  timeout: 90000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-legacy-features-'))
  const profile = join(root, 'profile')
  const addon = join(profile, 'installed-addons', 'mixed-features')
  const file = join(root, 'note.md')
  const source = '# Title\n\n**one** and *two*\n'
  await mkdir(addon, { recursive: true })
  await writeFile(file, source)
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'mixed-features',
      name: 'Mixed features',
      description: 'Mixed feature fixture',
      apiVersion: 3,
      version: '1.0.0',
      kind: 'extension',
      authors: [{ displayName: 'Test' }],
      capabilities: ['formatted', 'source'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default sdk => ({
      start(context) {
        window.mixedStarts = (window.mixedStarts || 0) + 1
        const formatted = new Map()
        for (const [id, node, token] of [['one', 'StrongEmphasis', 'strong'], ['two', 'Emphasis', 'em']]) {
          context.editor.registerSyntax({ id, label: id, group: 'Mixed', level: 'inline', nodes: [node], matches: value => value.type === token })
          context.editor.registerRich({ id, attach: () => () => {} })
        }
        window.mixedFeatures = {
          migrate(id, fail = false) {
            formatted.get(id)?.()
            formatted.set(id, context.editor.registerFormatted({ id, create() {
              if (fail) throw Error('Mixed feature attachment failed')
              return sdk.codeMirror.view.EditorView.editorAttributes.of({ ['data-mixed-' + id]: 'yes' })
            } }))
          },
          remove(id) { formatted.get(id)?.(); formatted.delete(id) }
        }
        window.mixedFeatures.migrate('one')
        context.editor.registerSource({ id: 'source', create: () => sdk.codeMirror.view.EditorView.editorAttributes.of({ 'data-mixed-source': 'yes' }) })
        if (window.failMixedStart) throw Error('Mixed feature activation failed')
      },
      stop() { window.mixedStops = (window.mixedStops || 0) + 1 }
    })`,
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'mixed-features': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'codemirror')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await waitForAsync(
    page,
    async (source) => (await window.hibi.getDocument()).markdown === source,
    source,
  )
  await waitForDocumentEditor(app, page)
  const activeNotices = page
    .locator('.toast:not([data-closing="true"])')
    .filter({ hasText: notice })
  const compatibility = async (expected, name = 'Document editor') => {
    await waitForAsync(
      page,
      ({ notice, expected }) =>
        [
          ...document.querySelectorAll('.toast:not([data-closing="true"])'),
        ].filter((node) => node.textContent.includes(notice)).length ===
        Number(expected),
      { notice, expected },
    )
    assert.equal(await activeNotices.count(), Number(expected))
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    assert.equal(
      await page
        .locator('[data-formatted-compatibility="mixed-features"]')
        .count(),
      Number(expected),
    )
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await waitForDocumentEditor(app, page, { name })
  }
  const toggleAddon = async () => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    await page.locator('#addon-mixed-features').click()
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  }
  const literal = async (one, two) => {
    await waitForAsync(
      page,
      ({ one, two }) =>
        !!document.querySelector('.rich-pane .hibi-lp-strong') === !one &&
        !!document.querySelector('.rich-pane .hibi-lp-em') === !two,
      { one, two },
    )
    const text = await page.locator('.rich-pane .cm-content').innerText()
    if (one) assert.ok(text.includes('**one**'))
    if (two) assert.ok(text.includes('*two*'))
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      source,
    )
  }
  await page.locator('.rich-pane [data-mixed-one="yes"]').waitFor()
  await compatibility(true)
  await literal(false, true)
  await page.evaluate(() => window.mixedFeatures.migrate('two'))
  await compatibility(false)
  await literal(false, false)
  await page.evaluate(() => window.mixedFeatures.remove('one'))
  await compatibility(true)
  await literal(true, false)
  await page.evaluate(() => window.mixedFeatures.remove('two'))
  await literal(true, true)
  await page.evaluate(() => window.mixedFeatures.migrate('two'))
  await literal(true, false)
  await compatibility(true)
  await page.evaluate(() => window.mixedFeatures.migrate('one'))
  await compatibility(false)
  await literal(false, false)

  await page.evaluate(() => window.mixedFeatures.migrate('two', true))
  await page
    .getByText('Mixed features could not start its formatted editor feature.', {
      exact: true,
    })
    .waitFor()
  await compatibility(true)
  await literal(false, true)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  const input = page.locator(
    '.source-pane [data-mixed-source="yes"] .cm-content',
  )
  await input.waitFor()
  assert.equal(await page.locator('.source-pane [data-mixed-one]').count(), 0)
  await input.press(`${mod}+End`)
  await input.type('x')
  await waitForAsync(
    page,
    async (source) =>
      (await window.hibi.getDocument()).markdown === `${source}x`,
    source,
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (source) => (await window.hibi.getDocument()).markdown === source,
    source,
  )
  await toggleAddon()
  await waitForAsync(page, () => !document.querySelector('[data-mixed-source]'))
  await compatibility(false, 'Markdown editor')
  await page.evaluate(() => {
    window.failMixedStart = true
  })
  await toggleAddon()
  await page
    .getByText('Mixed feature activation failed', { exact: true })
    .waitFor()
  await compatibility(false, 'Markdown editor')
  assert.equal(await page.locator('[data-mixed-source]').count(), 0)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    source,
  )
  await toggleAddon()
  await page.evaluate(() => {
    window.failMixedStart = false
  })
  await toggleAddon()
  await input.waitFor()
  await compatibility(true, 'Markdown editor')
  await page.getByRole('button', { name: 'normal', exact: true }).click()
  await page.locator('.rich-pane [data-mixed-one="yes"]').waitFor()
  await literal(false, true)
  assert.equal(await page.evaluate(() => window.mixedStarts), 3)
  assert.equal(await page.evaluate(() => window.mixedStops), 2)
})

test('legacy flavor views survive scope cleanup, lazy re-enable and node selectors', {
  timeout: 90000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-legacy-flavor-views-'))
  const profile = join(root, 'profile')
  const file = join(root, 'note.md')
  const source = '# Title\n\n*two* words\n'
  const message =
    'Beta flavor has features made for the previous formatted editor.'
  await writeFile(file, source)
  const beta = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import { Mark } from '@tiptap/core'
export default sdk => ({
  start(context) {
    window.betaStarts = (window.betaStarts || 0) + 1
    window.betaViewCalls = 0
    window.betaLayoutCalls = 0
    const betaMark = Mark.create({ name: 'betaMark' })
    context.editor.registerSyntax({
      id: 'mark', label: 'Mark', group: 'Beta', level: 'inline',
      nodes: ['Emphasis'], extensions: ['betaMark'],
      matches: token => token.type === 'em',
    })
    context.editor.registerFlavor({
      id: 'proof', name: 'Proof', kind: 'syntax', description: 'Proof',
      detect: () => true, richExtensions: [betaMark],
      syntax: { props: [sdk.codeMirror.common.NodeProp.group.add({ Emphasis: ['Inline'] })] },
      render: [{
        nodes: [window.betaMode === 'group' ? 'Inline' : window.betaMode === 'child' ? 'EmphasisMark' : 'Emphasis'],
        decorate(node, out) {
          if (window.betaThrow) throw Error('Beta renderer failed')
          window.betaViewCalls++
          out.mark(node.from, node.to, { 'data-beta-view': node.name })
        },
        layout() { window.betaLayoutCalls++ },
      }],
    })
  },
})`,
    },
    bundle: true,
    write: false,
    format: 'esm',
  })
  for (const [id, name, capabilities, code] of [
    ['beta-flavor', 'Beta flavor', ['formatted'], beta.outputFiles[0].text],
    ['alpha-plain', 'Alpha plain', [], 'export default () => ({ start() {} })'],
    [
      'foreign-view',
      'Foreign view',
      ['formatted'],
      "export default () => ({ start(context) { context.editor.registerFlavor({ id: 'child', name: 'Child', kind: 'syntax', description: 'Child', detect: () => true, render: [{ nodes: ['EmphasisMark'], decorate(node, out) { out.mark(node.from, node.to, { 'data-foreign-child': 'yes' }) } }] }) } })",
    ],
  ]) {
    const folder = join(profile, 'installed-addons', id)
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'hibi-addon.json'),
      JSON.stringify({
        id,
        name,
        description: 'Flavor compatibility fixture',
        kind: 'extension',
        apiVersion: 3,
        version: '1.0.0',
        authors: [{ displayName: 'Test' }],
        capabilities,
        entry: 'index.js',
      }),
    )
    await writeFile(join(folder, 'index.js'), code)
    await writeFile(
      join(folder, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: ['hibi-addon.json', 'index.js'],
        source: 'local',
      }),
    )
  }
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({
      'beta-flavor': true,
      'alpha-plain': true,
      'foreign-view': true,
    }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'codemirror')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await waitForAsync(
    page,
    async (source) => (await window.hibi.getDocument()).markdown === source,
    source,
  )
  await waitForDocumentEditor(app, page)
  await page.locator('.rich-pane [data-beta-view="Emphasis"]').waitFor()
  const toggle = async (id) => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    await page.locator(`#addon-${id}`).click()
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await waitForDocumentEditor(app, page)
  }
  const notices = () =>
    page
      .locator('.toast:not([data-closing="true"])')
      .filter({ hasText: message })
  const activate = async (mode) => {
    await toggle('beta-flavor')
    await page.evaluate((mode) => {
      window.betaMode = mode
    }, mode)
    await toggle('beta-flavor')
  }
  await t.test('re-enable inserts no migration notice', async () => {
    await toggle('beta-flavor')
    await page.evaluate((message) => {
      window.betaNoticeInsertions = 0
      window.betaNoticeObserver = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (node.nodeType === 1) {
              const toasts = node.matches('.toast')
                ? [node]
                : [...node.querySelectorAll('.toast')]
              window.betaNoticeInsertions += toasts.filter((toast) =>
                toast.textContent.includes(message),
              ).length
            }
      })
      window.betaNoticeObserver.observe(document.body, {
        childList: true,
        subtree: true,
      })
    }, message)
    try {
      await toggle('beta-flavor')
      await page.locator('.rich-pane [data-beta-view="Emphasis"]').waitFor()
      assert.equal(await page.evaluate(() => window.betaNoticeInsertions), 0)
      assert.equal(await notices().count(), 0)
    } finally {
      await page.evaluate(() => window.betaNoticeObserver.disconnect())
    }
  })
  await t.test('same-owner Lezer group views cover their syntax', async () => {
    await activate('group')
    await page.locator('.rich-pane [data-beta-view="Emphasis"]').waitFor()
    assert.equal(await notices().count(), 0)
  })
  await t.test(
    'same-owner child views run inside legacy literal syntax',
    async () => {
      await activate('child')
      await page
        .locator('.rich-pane [data-beta-view="EmphasisMark"]')
        .first()
        .waitFor()
      assert.equal(await notices().count(), 1)
      assert.equal(await page.locator('.rich-pane .hibi-lp-em').count(), 0)
      assert.equal(
        await page.locator('.rich-pane [data-foreign-child]').count(),
        0,
      )
      await waitForAsync(page, () => window.betaLayoutCalls > 0)
      await clickMenu(app, 'Settings')
      await page.getByRole('tab', { name: 'Syntax', exact: true }).click()
      const feature = page.getByRole('checkbox', { name: 'Mark', exact: true })
      await feature.click()
      await page.evaluate(() => {
        window.betaLayoutCalls = 0
      })
      await page
        .getByRole('button', { name: 'Back to app', exact: true })
        .click()
      await waitForDocumentEditor(app, page)
      assert.equal(await page.locator('.rich-pane [data-beta-view]').count(), 0)
      assert.equal(
        await page.locator('.rich-pane [data-foreign-child]').count(),
        0,
      )
      assert.equal(await page.evaluate(() => window.betaLayoutCalls), 0)
      await clickMenu(app, 'Settings')
      await page.getByRole('tab', { name: 'Syntax', exact: true }).click()
      await feature.click()
      await page
        .getByRole('button', { name: 'Back to app', exact: true })
        .click()
      await page
        .locator('.rich-pane [data-beta-view="EmphasisMark"]')
        .first()
        .waitFor()
    },
  )
  await t.test(
    'unrelated scope disposal cannot hide a failed renderer',
    async () => {
      await activate('named')
      await page.locator('.rich-pane [data-beta-view="Emphasis"]').waitFor()
      await toggle('alpha-plain')
      await page.evaluate(() => {
        window.betaThrow = true
      })
      const content = page.locator('.rich-pane .cm-content')
      await content.click()
      await content.press(`${mod}+End`)
      await content.type('x')
      await page
        .getByText('Beta renderer failed', { exact: false })
        .first()
        .waitFor()
      await waitForAsync(
        page,
        (message) =>
          [
            ...document.querySelectorAll('.toast:not([data-closing="true"])'),
          ].some((node) => node.textContent.includes(message)),
        message,
      )
      assert.equal(await notices().count(), 1)
      assert.equal(await page.locator('.rich-pane .hibi-lp-em').count(), 0)
      assert.equal(await page.locator('.rich-pane [data-beta-view]').count(), 0)
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        `${source}x`,
      )
    },
  )
})
