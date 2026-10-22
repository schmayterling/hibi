import assert from 'node:assert/strict'
import test from 'node:test'
import { exportOptions } from '../src/addons/documentation/options.ts'
import { prepareSite, siteFiles } from '../src/addons/documentation/site.ts'
import { registrationBatch } from '../src/renderer/src/registration-batch.ts'
import { siteContributions } from '../src/renderer/src/site-contributions.ts'

test('site contributions activate after startup, transform in order, and disappear on stop', async () => {
  const batch = registrationBatch(true)
  batch.register('site', () =>
    siteContributions.register('test-addon', 'Test addon', {
      description: 'Adds an exported banner.',
      css: '.banner { color: red }',
      transform: async (rendered, page) => ({
        ...rendered,
        html: `${rendered.html}<p class="banner">${page.path}</p>`,
      }),
    }),
  )
  assert.equal(siteContributions.snapshot().length, 0)
  batch.commit()
  const selected = siteContributions.snapshot()
  const rendered = await siteContributions.render(
    { html: '<h1>Note</h1>', css: '' },
    { path: 'note.md', markdown: '# Note' },
    selected,
  )
  assert.match(rendered.html, /class="banner">note.md/)
  assert.match(selected[0].css, /color: red/)
  batch.dispose()
  assert.equal(siteContributions.snapshot().length, 0)
  await assert.rejects(
    siteContributions.render(
      rendered,
      { path: 'note.md', markdown: '' },
      selected,
    ),
    /Enabled addons changed/,
  )
})

test('stopping an addon during a transform aborts its export', async () => {
  let finish
  const remove = siteContributions.register('test-stopping', 'Stopping', {
    description: 'Waits for compilation.',
    transform: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  })
  const pending = siteContributions.render(
    { html: '', css: '' },
    { path: 'note.md', markdown: '' },
    siteContributions.snapshot(),
  )
  remove()
  finish({ html: '<p>stale</p>', css: '' })
  await assert.rejects(pending, /Enabled addons changed/)
})

test('static sites carry addon palettes, chosen home, safe HTML and selected CSS only', async () => {
  const scheme = {
    id: 'custom-theme.blue',
    name: 'Blue',
    appearance: 'light',
    author: 'Author',
    license: { name: 'MIT', text: 'Theme license.' },
    colors: {
      background: '#eef4ff',
      surface: '#e0e8ff',
      ink: '#112244',
      muted: '#445577',
      accent: '#2244aa',
      border: '#aabbcc',
    },
  }
  const snapshot = {
    name: 'Notes',
    colorschemes: [scheme],
    addons: [
      { id: 'banner', name: 'Banner', css: '.banner{color:red}' },
      { id: 'disabled', name: 'Disabled', css: '.disabled{color:green}' },
    ],
    pages: [
      { path: 'README.md', markdown: '# Automatic home' },
      {
        path: 'guide.md',
        markdown: '# Chosen home',
        html: '<h1>Chosen home</h1><svg viewBox="0 0 8 8"><path d="M0 0L8 8"/></svg><math><mi>x</mi></math><script>attack()</script>',
      },
    ],
  }
  const options = exportOptions({
    singleFile: false,
    homePage: 'guide.md',
    graph: false,
    theme: { mode: 'light', light: scheme.id, dark: 'hibi-dark' },
    addons: { disabled: false },
    footer: '<&> footer',
    contentWidth: 'wide',
    css: '.banner{color:blue}',
  })
  for (const path of [
    'index.html',
    'robots.txt',
    'sitemap.xml',
    'INDEX.HTML/note.md',
  ])
    assert.throws(
      () =>
        prepareSite(
          {
            name: 'Reserved name',
            pages: [{ path, markdown: '# Note' }],
          },
          exportOptions({ singleFile: false }),
        ),
      /top-level/,
    )
  const site = prepareSite(snapshot, options)
  const template =
    '<!doctype html><html lang="en"><head><title>site</title><style>body{}</style></head><body><div id="root"></div><script id="workspace-data" type="application/json">__HIBI_WORKSPACE_DATA__</script><script>void 0</script></body></html>'
  const files = await siteFiles(template, site)
  assert.match(files.get('index.html'), /Chosen home/)
  assert.match(files.get('index.html'), /data-width="wide"/)
  assert.match(files.get('index.html'), /&lt;&amp;&gt; footer/)
  assert.match(files.get('index.html'), /<svg[^>]*>.*<path/)
  assert.match(files.get('index.html'), /<math><mi>x/)
  assert.doesNotMatch(files.get('index.html'), /attack\(\)/)
  const css = files.get('hibi-assets/custom.css')
  assert.match(css, /--background:#eef4ff/)
  assert.ok(
    css.indexOf('.banner{color:blue}') > css.indexOf('.banner{color:red}'),
  )
  assert.doesNotMatch(css, /disabled/)
  assert.deepEqual(
    site.addons.map((addon) => addon.id),
    ['banner'],
  )
  assert.throws(
    () => prepareSite(snapshot, exportOptions({ homePage: 'missing.md' })),
    /home page/,
  )
  assert.throws(
    () =>
      prepareSite(
        {
          ...snapshot,
          colorschemes: [
            {
              ...scheme,
              colors: {
                ...scheme.colors,
                background: 'url(https://example.com)',
              },
            },
          ],
        },
        options,
      ),
    /hex color/,
  )
})
