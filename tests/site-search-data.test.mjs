import assert from 'node:assert/strict'
import test from 'node:test'
import { exportOptions } from '../src/addons/documentation/options.ts'
import { prepareSite, siteFiles } from '../src/addons/documentation/site.ts'

const pageSearch = (html) =>
  prepareSite(
    { name: 'notes', pages: [{ path: 'note.md', markdown: '# top', html }] },
    exportOptions(),
  ).pages[0].search

test('export search data uses unicode labels and canonical heading anchors without copying body text', () => {
  const site = prepareSite(
    {
      name: 'notes',
      pages: [
        {
          path: '日本語.md',
          markdown: '# top',
          html: '<h1>Top</h1><h2>foo_bar</h2><p>first <strong>body</strong> words</p><h2>foo_bar</h2><h2>日本語 &amp; café</h2><h2 class="sr-only" id="footnote-label">Footnotes</h2><script>privateAttack()</script>',
        },
      ],
    },
    exportOptions(),
  )
  const search = site.pages[0].search
  assert.equal(search.version, 1)
  assert.equal('text' in search, false, 'body text is already in markdown')
  assert.deepEqual(search.headings, [
    { depth: 2, label: 'foo_bar', anchor: 'foo_bar' },
    { depth: 2, label: 'foo_bar', anchor: 'foo_bar-1' },
    { depth: 2, label: '日本語 & café', anchor: '日本語-café' },
  ])
})

test('search anchor allocation includes h1, empty headings and historical collisions', () => {
  assert.deepEqual(
    pageSearch('<h1>ab</h1><h2>a_b</h2><h2>ab</h2><h2></h2><h3>one<br>two</h3>')
      .headings,
    [
      { depth: 2, label: 'a_b', anchor: 'a_b' },
      { depth: 2, label: 'ab', anchor: 'ab-2' },
      { depth: 3, label: 'onetwo', anchor: 'onetwo' },
    ],
  )
})

test('versioned records travel in static and single-file output', async () => {
  const template =
    '<html lang="en"><head><title>site</title></head><body><div id="root"></div><script id="workspace-data" type="application/json">__HIBI_WORKSPACE_DATA__</script></body></html>'
  for (const singleFile of [true, false]) {
    const site = prepareSite(
      {
        name: 'notes',
        pages: [
          {
            path: 'note.md',
            markdown: '# Title\n\n## Heading\n\nneedle prose',
          },
        ],
      },
      exportOptions({ singleFile }),
    )
    const files = await siteFiles(template, site)
    const data = singleFile
      ? files.get('index.html')
      : files.get('hibi-assets/workspace.js')
    assert.match(data, /"search":\{"version":1/)
    assert.match(data, /"anchor":"heading"/)
    assert.match(data, /needle prose/)
  }
})

test('heading attributes do not become search labels or anchors', () => {
  const search = pageSearch(
    '<h2 title="1>0">A <code>x_y</code></h2><p>first</p><p>second<br>line</p>',
  )
  assert.deepEqual(search.headings, [
    { depth: 2, label: 'A x_y', anchor: 'a-x_y' },
  ])
  assert.deepEqual(
    pageSearch('<h2>safe<script>bad()</script> heading</h2>').headings,
    [{ depth: 2, label: 'safe heading', anchor: 'safe-heading' }],
  )
})
