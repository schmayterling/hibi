import assert from 'node:assert/strict'
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { uiName } from './ui.mjs'

test('format plugins render natively, keep previews inert, and run only on request', {
  timeout: 180000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-format-renderers-'))
  const profile = join(temp, 'profile')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(profile)
  const ids = [
    'mdx',
    'math',
    'rst',
    'asciidoc',
    'org',
    'html',
    'mediawiki',
    'rmarkdown',
    'quarto',
    'mdsvex',
    'markdoc',
    'djot',
    'textile',
    'creole',
  ]
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify(Object.fromEntries(ids.map((id) => [id, true]))),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const query = (id, method, input) =>
    page.evaluate(
      ({ id, method, input }) => window.hibi.queryAddon(id, method, input),
      { id, method, input },
    )
  const pandoc = !(await query('rst', 'tools')).diagnostics.includes(
    'Install pandoc',
  )
  const samples = [
    ['rst', 'Heading\n=======\n\n**bold**'],
    ['asciidoc', '= Heading\n\n*bold*'],
    ['org', '* Heading\n\n*bold*'],
    ['mediawiki', "= Heading =\n\n'''bold'''"],
    ['rmarkdown', '# Heading\n\n```{r}\nstop("must not run")\n```'],
    [
      'quarto',
      '# Heading\n\n```{python}\nraise Exception("must not run")\n```',
    ],
    ['djot', '# Heading\n\n*bold*'],
    ['textile', 'h1. Heading\n\n*bold*'],
    ['creole', '= Heading =\n\n**bold**'],
  ]
  for (const [id, source] of samples)
    await t.test(`${id} native preview`, { skip: !pandoc }, async () => {
      const result = await query(id, 'render', { source })
      assert.match(result.html, /<h1[^>]*>Heading<\/h1>/)
    })
  const markdoc = await query('markdoc', 'render', {
    source: '# Heading\n\n**bold**',
  })
  assert.match(markdoc.html, /<strong>bold<\/strong>/)
  const open = async (name, source, label) => {
    const file = join(temp, name)
    await writeFile(file, source)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await pressShortcut(app, `${mod}+o`)
    await page
      .getByRole('textbox', { name: `${label} editor`, exact: true })
      .waitFor()
    await page.waitForFunction(
      () =>
        document.querySelector('.format-preview')?.getAttribute('aria-busy') ===
        'false',
    )
    return file
  }
  await open(
    'safe.html',
    '<h1>Heading</h1><script>window.compromised = true</script><img onerror="window.compromised=true" src="missing.png">',
    'HTML',
  )
  assert.equal(await page.evaluate(() => window.compromised), undefined)
  assert.equal(
    await page
      .locator('.format-content script, .format-content [onerror]')
      .count(),
    0,
  )
  await t.test(
    'native formatting is undoable and preview actions stay pinned',
    async () => {
      const source =
        '<h1>Heading</h1>\n' + '<p>Scrollable paragraph.</p>\n'.repeat(60)
      await open('toolbar.html', source, 'HTML')
      const editor = page.getByRole('textbox', {
        name: 'HTML editor',
        exact: true,
      })
      await editor.press(`${mod}+a`)
      await page.getByRole('button', { name: /^bold$/i, exact: true }).click()
      assert.match(await editor.textContent(), /^<strong><h1>Heading/)
      await editor.press(`${mod}+z`)
      assert.equal(
        (await editor.locator('.cm-line').allTextContents()).join('\n'),
        source,
      )
      await page.waitForFunction(
        () => document.querySelectorAll('.format-content p').length === 60,
      )
      const geometry = await page
        .locator('.rich-pane')
        .evaluate(async (pane) => {
          pane.scrollTop = 400
          await new Promise(requestAnimationFrame)
          const toolbar = pane.querySelector('.preview-toolbar')
          return {
            scroll: pane.scrollTop,
            paneTop: pane.getBoundingClientRect().top,
            toolbarTop: toolbar.getBoundingClientRect().top,
            mask: getComputedStyle(pane.parentElement).maskImage,
          }
        })
      assert.ok(geometry.scroll > 0)
      assert.ok(Math.abs(geometry.paneTop - geometry.toolbarTop) < 1)
      assert.equal(geometry.mask, 'none')
      await page
        .getByRole('toolbar', { name: 'Preview actions', exact: true })
        .getByRole('button', { name: 'Export HTML', exact: true })
        .waitFor()
    },
  )
  for (const [id, extension, label] of [
    ['mdx', 'mdx', 'MDX'],
    ['mdsvex', 'svx', 'MDsveX'],
  ]) {
    const marker = join(temp, `${id}-executed`)
    const code = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`
    const source =
      id === 'mdx'
        ? `import { writeFileSync } from 'node:fs';\nexport const value = (writeFileSync(${JSON.stringify(marker)}, 'ran'), 8);\n\n# Heading\n\n<span>{value}</span>`
        : `<script>${code}let value = 8;</script>\n\n# Heading\n\n<span>{value}</span>`
    await open(`run.${extension}`, source, label)
    await assert.rejects(access(marker))
    await page
      .getByRole('button', { name: 'Run document', exact: true })
      .click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Run document', exact: true })
      .click()
    await page
      .locator('.format-content span')
      .filter({ hasText: /^8$/ })
      .waitFor()
      .catch(async (error) => {
        throw new Error(
          `${id} preview: ${(await page.locator('.format-preview').innerText()).slice(0, 2000)}`,
          { cause: error },
        )
      })
    assert.equal(await readFile(marker, 'utf8'), 'ran')
    const output = join(temp, `${id}.html`)
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    }, output)
    await page.getByRole('button', { name: 'Export HTML', exact: true }).click()
    await page.getByText(uiName(`Exported to ${output}`, true)).waitFor()
    const exported = await readFile(output, 'utf8')
    assert.match(exported, /<span>8<\/span>/)
    assert.doesNotMatch(exported, /writeFileSync|<script/)
  }
  const tools = await query('math', 'tools')
  await t.test(
    'LaTeX compiles project inputs and exports a real PDF',
    {
      // A fresh profile downloads Tectonic's bundle from the network.
      skip:
        process.env.HIBI_TEST_LATEX !== '1' ||
        tools.diagnostics.includes('Install tectonic'),
    },
    async () => {
      await writeFile(join(temp, 'included.tex'), 'Included equation: $x^2$.')
      const source =
        '\\documentclass{article}\n\\usepackage{amsmath,amssymb,graphicx,xcolor}\n\\begin{document}\n\\textcolor{teal}{Package color}\\input{included.tex}\n\\end{document}'
      await open('document.tex', source, 'LaTeX')
      assert.equal(await page.locator('.format-content').count(), 0)
      assert.equal(await page.locator('.format-message').count(), 0)
      assert.equal(
        await page
          .getByRole('button', { name: 'Export PDF', exact: true })
          .isDisabled(),
        true,
      )
      await page
        .getByRole('button', { name: 'Compile document', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Compile document', exact: true })
        .click()
      await page.locator('.format-pdf canvas').waitFor({ timeout: 100000 })
      await mkdir('test-results', { recursive: true })
      await page.screenshot({ path: 'test-results/latex-preview.png' })
      const output = join(temp, 'document.pdf')
      await app.evaluate(({ dialog }, file) => {
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: file,
        })
      }, output)
      await page
        .getByRole('button', { name: 'Export PDF', exact: true })
        .click()
      await page.getByText(uiName(`Exported to ${output}`, true)).waitFor()
      assert.equal((await readFile(output)).subarray(0, 5).toString(), '%PDF-')
      await pressShortcut(app, `${mod}+,`)
      await page.getByRole('tab', { name: 'LaTeX', exact: true }).click()
      await page
        .getByRole('textbox', { name: 'Search LaTeX packages' })
        .fill('xcolor')
      await page.getByRole('button', { name: 'Search', exact: true }).click()
      const packageRow = page
        .getByRole('listitem')
        .filter({ has: page.locator('code').filter({ hasText: /^xcolor$/ }) })
      await packageRow.waitFor({ timeout: 100000 })
      await packageRow
        .getByRole('button', { name: 'Download xcolor', exact: true })
        .click()
      await packageRow.getByText('Downloaded', { exact: true }).waitFor()
      await assert.rejects(query('math', 'download-package', '../bad'))
      await mkdir('test-results', { recursive: true })
      await page.screenshot({ path: 'test-results/latex-packages.png' })
      await page.setViewportSize({ width: 480, height: 720 })
      assert.ok(
        await page
          .locator('#settings-plugin-math')
          .evaluate((panel) => panel.scrollWidth <= panel.clientWidth + 1),
      )
      await page.setViewportSize({ width: 1000, height: 720 })
      await page
        .getByRole('button', { name: 'Clear downloads', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Clear downloads', exact: true })
        .click()
      await packageRow
        .getByText('Downloaded', { exact: true })
        .waitFor({ state: 'hidden' })
      await assert.rejects(access(join(profile, 'latex-packages', 'files')))
      assert.equal(await readFile(join(temp, 'document.tex'), 'utf8'), source)
      await page.evaluate(async () => {
        await window.hibi.setAddonEnabled('math', false)
        await window.hibi.setAddonEnabled('math', true)
      })
      assert.ok((await query('math', 'packages')).names.includes('xcolor'))
    },
  )
  assert.equal(
    (await readdir(temp)).some((name) => name.startsWith('.hibi-run-')),
    false,
  )
})
