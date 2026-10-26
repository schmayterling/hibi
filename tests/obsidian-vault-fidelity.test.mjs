import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'
import {
  diffVault,
  fixtureVault,
  paragraph,
  replaceBytes,
  replacement,
  snapshotManifest,
  snapshotVault,
  vaultSettings,
} from './vault-fidelity.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const formats = [
  'syntax.md',
  'crlf.md',
  'bom.md',
  'mixed-eol.md',
  'no-final-newline.md',
]

// This is a strict compatibility specification. Existing app violations fail it.
// HIBI_FIDELITY_REPORT writes evidence even when assertions fail.
test('obsidian vault fidelity through real desktop operations', async (t) => {
  const folder = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-vault-fidelity-')),
  )
  const profile = join(folder, 'profile')
  const observations = []
  const retained = []
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    for (const { root, before, changes, result } of retained) {
      const final = await snapshotVault(root)
      result.afterClose = snapshotManifest(final)
      result.violationsAfterClose = diffVault(before, final, changes)
    }
    if (process.env.HIBI_FIDELITY_REPORT) {
      const destination = resolve(process.env.HIBI_FIDELITY_REPORT)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(
        destination,
        `${JSON.stringify(
          {
            revision: execFileSync('git', ['rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).trim(),
            platform: process.platform,
            runtime: process.version,
            settings: vaultSettings,
            scenarios: observations,
          },
          null,
          2,
        )}\n`,
      )
    }
    await rm(folder, { recursive: true, force: true })
    for (const result of observations)
      assert.deepEqual(
        result.violationsAfterClose,
        result.violations,
        `${result.name}: late vault writes`,
      )
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
  let activeEngine = 'rich'

  async function openVault(root, engine) {
    if (activeEngine !== engine) {
      await clickMenu(app, 'New')
      await waitForAsync(
        page,
        async () => !(await window.hibi.getDocument()).canAutosave,
      )
      await page.getByRole('button', { name: 'normal', exact: true }).click()
      await waitForDocumentEditor(app, page)
      await page.evaluate((engine) => {
        if (engine === 'formatted')
          localStorage.setItem('hibi:formatted-engine', 'codemirror')
        else localStorage.removeItem('hibi:formatted-engine')
      }, engine)
      await page.reload()
      await waitForDocumentEditor(app, page)
      activeEngine = engine
    }
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [root],
      })
    }, root)
    await pressShortcut(app, `${mod}+Shift+o`)
    const warning = page.getByRole('dialog', {
      name: 'Back up this Obsidian vault',
    })
    await warning
      .locator('.dialog-footer')
      .getByRole('button', { name: 'Continue', exact: true })
      .click()
    await warning.waitFor({ state: 'hidden' })
    await page.locator('.app[aria-busy="false"]').waitFor()
  }

  async function openNote(path, mode = 'rich') {
    const parts = path.split('/')
    for (const folder of parts.slice(0, -1)) {
      const item = page.getByRole('treeitem', { name: folder, exact: true })
      if ((await item.getAttribute('aria-expanded')) !== 'true')
        await item.click()
    }
    await page
      .getByRole('treeitem', { name: parts.at(-1), exact: true })
      .click()
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      parts.at(-1),
    )
    const viewButton = page.getByRole('button', {
      name: mode === 'source' ? 'Source view' : 'normal',
      exact: true,
    })
    assert.equal(
      await viewButton.isEnabled(),
      true,
      `${mode} view unavailable for ${path}`,
    )
    await viewButton.click()
    await waitForDocumentEditor(app, page, {
      name: mode === 'source' ? 'Markdown editor' : 'Document editor',
    })
  }

  async function scenario(name, operation, settings = {}, engine = 'rich') {
    await t.test(name, async () => {
      const root = join(folder, `vault-${observations.length}`)
      const capabilities = await fixtureVault(root, settings)
      const before = await snapshotVault(root)
      const result = {
        name,
        settings: { ...vaultSettings, ...settings },
        capabilities,
        before: snapshotManifest(before),
      }
      observations.push(result)
      let changes = {}
      try {
        await openVault(root, engine)
        changes = await operation({ root, before, result })
      } catch (error) {
        result.operationError = error.message
        throw error
      } finally {
        const after = await snapshotVault(root)
        result.after = snapshotManifest(after)
        result.expectedChangedPaths = Object.keys(changes)
        result.violations = diffVault(before, after, changes)
        retained.push({ root, before, changes, result })
      }
      assert.deepEqual(
        result.violations,
        [],
        `${name}: ${JSON.stringify(result.violations)}`,
      )
    })
  }

  await scenario(
    'open, browse, index, metadata and search write no vault files',
    async ({ result }) => {
      for (const path of formats) await openNote(path, 'source')
      result.queries = await page.evaluate(async () => {
        const index = await window.hibi.getWorkspaceIndex(true)
        const subscription = await window.hibi.subscribeWorkspaceChanges(
          () => {},
        )
        try {
          const target = subscription.snapshot.target
          const metadata = await window.hibi.queryWorkspaceReferences({
            kind: 'headings',
            path: 'syntax.md',
            target,
          })
          const search = await window.hibi.queryWorkspaceReferences({
            kind: 'search-text',
            query: 'paragraph',
            target,
          })
          return { indexed: index.pages.length, metadata, search }
        } finally {
          subscription.dispose()
        }
      })
      assert.equal(
        await page.evaluate(() => globalThis.__fidelityVaultPluginExecuted),
        undefined,
      )
      assert.ok(result.queries.indexed > 0)
      assert.equal(result.queries.metadata.ok, true)
      assert.equal(result.queries.search.ok, true)
      return {}
    },
  )

  await scenario(
    'table view metadata stays outside vault',
    async ({ result }) => {
      await openNote('table.md')
      const cell = page.locator('.tiptap table th').first()
      await cell.scrollIntoViewIfNeeded()
      const box = await cell.boundingBox()
      const x = box.x + box.width - 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.locator('.tiptap[data-table-resize="column"]').waitFor()
      await page.mouse.down()
      for (let step = 1; step <= 4; step++)
        await page.mouse.move(x + step * 10, y)
      await page.mouse.up()
      await waitForAsync(
        page,
        async () =>
          (
            await window.hibi.readTableLayout(
              (
                await window.hibi.getDocument()
              ).tabId,
            )
          )?.length === 1,
      )
      result.tableLayout = await page.evaluate(async () =>
        window.hibi.readTableLayout((await window.hibi.getDocument()).tabId),
      )
      return {}
    },
  )

  for (const mode of ['source', 'rich', 'formatted']) {
    for (const path of mode === 'source'
      ? formats
      : formats.map((path) => `editable-${path}`)) {
      await scenario(
        `${mode}: edit one paragraph in ${path}`,
        async ({ before, result }) => {
          await openNote(path, mode)
          await page.evaluate(
            ({ mode, paragraph }) => {
              if (mode === 'rich') {
                const editor =
                  document.querySelector('.rich-pane .tiptap').editor
                let from = -1
                editor.state.doc.descendants((node, position) => {
                  if (node.isText && node.text.includes(paragraph))
                    from = position + node.text.indexOf(paragraph)
                })
                if (from < 0)
                  throw new Error('fixture paragraph missing in rich editor')
                editor.commands.setTextSelection({
                  from,
                  to: from + paragraph.length,
                })
                editor.view.focus()
              } else {
                const selector =
                  mode === 'source'
                    ? '.source-pane .cm-content'
                    : '.rich-pane .cm-content'
                const view = document.querySelector(selector).cmTile.root.view
                const from = view.state.doc.toString().indexOf(paragraph)
                if (from < 0)
                  throw new Error('fixture paragraph missing in codemirror')
                view.dispatch({
                  selection: { anchor: from, head: from + paragraph.length },
                })
                view.focus()
              }
            },
            { mode, paragraph },
          )
          await page.keyboard.insertText(replacement)
          await waitForAsync(
            page,
            async (replacement) =>
              (await window.hibi.getDocument()).markdown.includes(replacement),
            replacement,
          )
          await clickMenu(app, 'Save')
          await waitForAsync(
            page,
            async () => !(await window.hibi.getDocument()).dirty,
          )
          result.historyVersions = await page.evaluate(
            async () => (await window.hibi.listVersions()).length,
          )
          assert.ok(result.historyVersions > 0)
          return { [path]: replaceBytes(before, path, paragraph, replacement) }
        },
        {},
        mode === 'formatted' ? 'formatted' : 'rich',
      )
    }
  }

  for (const mode of ['rich', 'formatted']) {
    await scenario(
      `${mode}: footnote document permits editing`,
      async () => {
        await openNote('syntax.md', mode)
        return {}
      },
      {},
      mode === 'formatted' ? 'formatted' : 'rich',
    )
  }

  for (const action of ['rename', 'move']) {
    for (const alwaysUpdateLinks of [true, false]) {
      await scenario(
        `${action}: alwaysUpdateLinks=${alwaysUpdateLinks}`,
        async ({ before, result }) => {
          const destination =
            action === 'rename' ? 'Renamed.md' : 'moved/Target.md'
          const path = action === 'rename' ? 'nested/Renamed.md' : destination
          result.reply = await page.evaluate(
            ({ action, destination }) =>
              window.hibi.workspaceAction({
                action,
                path: 'nested/Target.md',
                destination,
              }),
            { action, destination },
          )
          assert.equal(result.reply.path, path)
          const changes = {
            'nested/Target.md': null,
            [path]: before.get('nested/Target.md'),
          }
          if (alwaysUpdateLinks) {
            for (const note of [
              ...formats,
              ...formats.map((path) => `editable-${path}`),
            ])
              changes[note] = {
                kind: 'file',
                bytes: Buffer.from(
                  before
                    .get(note)
                    .bytes.toString()
                    .replaceAll('nested/Target', path),
                ),
              }
            const referrer = before.get('nested/Referrer.md').bytes.toString()
            changes['nested/Referrer.md'] = {
              kind: 'file',
              bytes: Buffer.from(
                referrer
                  .slice(0, referrer.indexOf('`'))
                  .replace(
                    /(\[\[|\]\()Target/g,
                    `$1${action === 'rename' ? 'Renamed' : '../moved/Target'}`,
                  ) + referrer.slice(referrer.indexOf('`')),
              ),
            }
          }
          return changes
        },
        { alwaysUpdateLinks },
      )
    }
  }

  for (const newFileLocation of ['folder', 'current', 'root']) {
    await scenario(
      `new note: newFileLocation=${newFileLocation}`,
      async ({ root, result }) => {
        await openNote(
          newFileLocation === 'current' ? 'nested/Target.md' : 'table.md',
        )
        const relative =
          newFileLocation === 'folder'
            ? 'inbox/untitled.md'
            : newFileLocation === 'current'
              ? 'nested/untitled.md'
              : 'untitled.md'
        const expected = join(root, relative)
        await app.evaluate(({ dialog }, root) => {
          dialog.showSaveDialog = async (_window, options) => {
            globalThis.fidelitySaveDefault = options.defaultPath
            // Observe the app's default; only anchor relative paths to this fixture.
            const { isAbsolute, join } = process.getBuiltinModule('path')
            return {
              canceled: false,
              filePath: isAbsolute(options.defaultPath)
                ? options.defaultPath
                : join(root, options.defaultPath),
            }
          }
        }, root)
        await clickMenu(app, 'New')
        await waitForAsync(
          page,
          async () => !(await window.hibi.getDocument()).canAutosave,
        )
        await clickMenu(app, 'Save')
        await waitForAsync(page, async () => {
          const document = await window.hibi.getDocument()
          return document.canAutosave && !document.dirty
        })
        result.saveDefault = await app.evaluate(
          () => globalThis.fidelitySaveDefault,
        )
        result.expectedDestination = expected
        return {
          [relative]: { kind: 'file', bytes: Buffer.alloc(0) },
        }
      },
      { newFileLocation },
    )
  }

  await scenario(
    'attachment follows attachmentFolderPath',
    async ({ root, before, result }) => {
      await openNote('syntax.md', 'source')
      const media = join(folder, 'attached.svg')
      const bytes = before.get('attachments/pixel.svg').bytes
      await writeFile(media, bytes)
      await app.evaluate(({ dialog }, media) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [media],
        })
      }, media)
      result.attachment = await page.evaluate(async () =>
        window.hibi.attachMedia(
          null,
          (await window.hibi.getDocument()).revision,
        ),
      )
      assert.equal(result.attachment.attachments.length, 1)
      assert.equal(
        await readFile(
          join(root, result.attachment.attachments[0].url),
          'utf8',
        ),
        bytes.toString(),
      )
      return { 'attachments/attached.svg': { kind: 'file', bytes } }
    },
  )

  for (const trashOption of ['local', 'system']) {
    await scenario(
      `delete: trashOption=${trashOption}`,
      async ({ root, before, result }) => {
        const systemTrash = join(folder, `system-trash-${trashOption}`)
        await mkdir(systemTrash)
        await app.evaluate(({ shell }, systemTrash) => {
          globalThis.fidelityTrashCalls = []
          shell.trashItem = async (path) => {
            globalThis.fidelityTrashCalls.push(path)
            const { rename } = process.getBuiltinModule('fs/promises')
            const { join, basename } = process.getBuiltinModule('path')
            await rename(path, join(systemTrash, basename(path)))
          }
        }, systemTrash)
        result.reply = await page.evaluate(() =>
          window.hibi.workspaceAction({ action: 'delete', path: 'delete.md' }),
        )
        result.systemTrashCalls = await app.evaluate(
          () => globalThis.fidelityTrashCalls,
        )
        assert.equal(result.reply.path, 'delete.md')
        const changes = { 'delete.md': null }
        if (trashOption === 'local') {
          changes['.trash'] = { kind: 'directory' }
          changes['.trash/delete.md'] = before.get('delete.md')
        } else {
          assert.deepEqual(result.systemTrashCalls, [join(root, 'delete.md')])
          assert.deepEqual(
            await readFile(join(systemTrash, 'delete.md')),
            before.get('delete.md').bytes,
          )
        }
        return changes
      },
      { trashOption },
    )
  }
})
