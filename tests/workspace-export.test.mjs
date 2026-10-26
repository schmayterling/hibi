import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('header-only workspace reads preserve export options, snapshots and disk exports', {
  timeout: 30000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-workspace-export-'))
  const workspace = join(directory, 'notes')
  const output = join(directory, 'output')
  const profile = join(directory, 'profile')
  const probe = join(profile, 'installed-addons', 'snapshot-probe')
  await mkdir(probe, { recursive: true })
  await writeFile(
    join(probe, 'hibi-addon.json'),
    JSON.stringify({
      id: 'snapshot-probe',
      name: 'Snapshot probe',
      description: 'Workspace snapshot fixture.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
      capabilities: [],
      defaultEnabled: true,
    }),
  )
  await writeFile(
    join(probe, 'index.js'),
    `export default () => ({
      start(context) { window.snapshotProbe = () => context.workspace.snapshot() },
      stop() { delete window.snapshotProbe },
    })`,
  )
  await writeFile(
    join(probe, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'snapshot-probe': true }),
  )
  await mkdir(join(workspace, 'nested'), { recursive: true })
  await mkdir(output)
  await writeFile(join(workspace, 'README.md'), '# Garden')
  await writeFile(join(workspace, 'nested', 'other.md'), '# Other')
  await writeFile(join(workspace, '.private.md'), '# Hidden sentinel')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [workspace],
    })
  }, workspace)
  await page.evaluate(() => window.hibi.openWorkspace())
  const draft = await page.evaluate(() =>
    window.hibi.workspaceAction({ action: 'new-file', path: 'nested' }),
  )
  const markdown = '# Pending export sentinel'
  await page.evaluate((text) => window.hibi.updateDocument(text), markdown)
  const paths = ['README.md', 'nested/other.md', draft.path].sort()
  const header = await page.evaluate(() => window.hibi.getWorkspaceHeader())
  assert.equal(Object.hasOwn(header, 'entries'), false)

  await t.test(
    'options list every supported page including pending drafts',
    async () => {
      const options = await page.evaluate(() =>
        window.hibi.queryAddon('documentation', 'options'),
      )
      assert.deepEqual(options.pages.map((page) => page.path).sort(), paths)
    },
  )

  await t.test(
    'legacy snapshot reads real disk pages and pending source',
    async () => {
      const snapshot = await page.evaluate(() =>
        window.hibi.getWorkspaceSnapshot(),
      )
      assert.deepEqual(snapshot.pages.map((page) => page.path).sort(), paths)
      assert.equal(
        snapshot.pages.find((page) => page.path === draft.path).markdown,
        markdown,
      )
      assert.equal(
        snapshot.pages.find((page) => page.path === 'nested/other.md').markdown,
        '# Other',
      )
    },
  )

  await t.test(
    'addon sdk snapshot includes disk pages and pending source',
    async () => {
      await page.waitForFunction(
        () => typeof window.snapshotProbe === 'function',
      )
      const snapshot = await page.evaluate(() => window.snapshotProbe())
      assert.deepEqual(snapshot.pages.map((page) => page.path).sort(), paths)
      assert.equal(
        snapshot.pages.find((page) => page.path === draft.path).markdown,
        markdown,
      )
      assert.equal(
        snapshot.pages.find((page) => page.path === 'nested/other.md').markdown,
        '# Other',
      )
    },
  )

  await t.test(
    'disk export stages and verifies every page before writing',
    async () => {
      await app.evaluate(({ dialog }, output) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [output],
        })
      }, output)
      const result = await page.evaluate(async (target) => {
        const query = (method, input) =>
          window.hibi.queryAddon('documentation', method, input)
        const session = await query('begin', {
          target,
          options: { singleFile: false, graph: false },
        })
        try {
          for (const path of session.paths) {
            const source = await query('page', session)
            if (source.path !== path) throw new Error('Unexpected export page')
            await query('stage', {
              ...session,
              page: { ...source, html: `<p>${source.markdown}</p>` },
            })
          }
          const prepared = { ...session, css: '', colorschemes: [], addons: [] }
          await query('seal', prepared)
          return await window.hibi.invokeAddon(
            'documentation',
            'export',
            prepared,
          )
        } finally {
          await query('cancel', session)
        }
      }, header.target)
      assert.equal(result.pages, paths.length)
      assert.match(
        await readFile(join(result.path, 'index.html'), 'utf8'),
        /Garden/,
      )
      const data = await readFile(
        join(result.path, 'hibi-assets', 'workspace.js'),
        'utf8',
      )
      for (const path of paths) assert.ok(data.includes(path), path)
      assert.match(data, /Pending export sentinel/)
      assert.match(data, /Other/)
      assert.doesNotMatch(data, /Hidden sentinel|\.private\.md/)
    },
  )

  await assert.rejects(readFile(join(workspace, draft.path)), {
    code: 'ENOENT',
  })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )
})
