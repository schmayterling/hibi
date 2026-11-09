import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
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

  async function openVault(root) {
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

  async function openNote(path, mode = 'formatted') {
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

  async function scenario(
    name,
    operation,
    settings = {},
    configDir = '.obsidian',
    setup,
  ) {
    if (
      process.env.HIBI_FIDELITY_SCENARIO &&
      !name.includes(process.env.HIBI_FIDELITY_SCENARIO)
    )
      return
    await t.test(name, async () => {
      const root = join(folder, `vault-${observations.length}`)
      const capabilities = await fixtureVault(root, settings)
      const configs = Array.isArray(configDir) ? configDir : [configDir]
      if (configs[0] !== '.obsidian')
        await rename(join(root, '.obsidian'), join(root, configs[0]))
      for (const config of configs.slice(1)) {
        await mkdir(join(root, config))
        await writeFile(join(root, config, 'appearance.json'), '{}')
        await writeFile(
          join(root, config, 'app.json'),
          '{"attachmentFolderPath":"wrong"}',
        )
      }
      if (setup) await setup(root)
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
        await openVault(root)
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
      const cell = page.locator('.hibi-lp-table th').first()
      await cell.scrollIntoViewIfNeeded()
      const box = await cell.boundingBox()
      const x = box.x + box.width - 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.locator('.hibi-lp-table[data-table-resize="column"]').waitFor()
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

  for (const mode of ['source', 'formatted']) {
    for (const path of mode === 'source'
      ? formats
      : formats.map((path) => `editable-${path}`)) {
      await scenario(
        `${mode}: edit one paragraph in ${path}`,
        async ({ before, result }) => {
          await openNote(path, mode)
          await page.evaluate(
            ({ mode, paragraph }) => {
              {
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
      )
    }
  }

  for (const mode of ['formatted']) {
    await scenario(
      `${mode}: footnote document permits editing`,
      async () => {
        await openNote('syntax.md', mode)
        return {}
      },
      {},
    )
  }

  await scenario(
    'rename supported attachment updates wiki and markdown image targets',
    async ({ before }) => {
      await page.evaluate(() =>
        window.hibi.workspaceAction({
          action: 'rename',
          path: 'attachments/pixel.svg',
          destination: 'renamed.svg',
        }),
      )
      const changes = {
        'attachments/pixel.svg': null,
        'attachments/renamed.svg': before.get('attachments/pixel.svg'),
      }
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
              .replaceAll('attachments/pixel.svg', 'attachments/renamed.svg'),
          ),
        }
      return changes
    },
  )
  await scenario(
    'trash supported attachment follows local trash policy',
    async ({ before }) => {
      await page.evaluate(() =>
        window.hibi.workspaceAction({
          action: 'delete',
          path: 'attachments/pixel.svg',
        }),
      )
      return {
        'attachments/pixel.svg': null,
        '.trash': { kind: 'directory' },
        '.trash/pixel.svg': before.get('attachments/pixel.svg'),
      }
    },
  )

  await scenario(
    'binary files copy rename and trash without changing their bytes',
    async ({ before }) => {
      await page.evaluate(async () => {
        await window.hibi.workspaceAction({
          action: 'copy',
          path: 'attachments/binary.bin',
          destination: 'moved/binary.bin',
        })
        await window.hibi.workspaceAction({
          action: 'rename',
          path: 'moved/binary.bin',
          destination: 'renamed.bin',
        })
        await window.hibi.workspaceAction({
          action: 'delete',
          path: 'moved/renamed.bin',
        })
      })
      return {
        '.trash': { kind: 'directory' },
        '.trash/renamed.bin': before.get('attachments/binary.bin'),
      }
    },
  )

  if (process.platform !== 'win32') {
    await scenario(
      'nonregular paths never reach trash',
      async () => {
        await app.evaluate(({ shell }) => {
          shell.trashItem = async () => {
            throw new Error('nonregular path reached trash')
          }
        })
        const message = await page.evaluate(() =>
          window.hibi
            .workspaceAction({
              action: 'delete',
              path: 'pipe.md',
            })
            .then(
              () => '',
              (error) => error.message,
            ),
        )
        assert.match(message, /regular file or folder/)
        return {}
      },
      { trashOption: 'system' },
      '.obsidian',
      (root) => {
        execFileSync('mkfifo', [join(root, 'pipe.md')])
      },
    )
  }

  await scenario(
    'unicode source alias preserves active note and all reference bytes',
    async ({ result }) => {
      if (result.capabilities.distinctNormalization) {
        result.skip = 'filesystem distinguishes unicode normalization'
        return {}
      }
      await openNote('cafe\u0301.md', 'source')
      const reply = await page.evaluate(() =>
        window.hibi.workspaceAction({
          action: 'move',
          path: 'café.md',
          destination: 'moved/Été.md',
        }),
      )
      assert.equal(reply.document.name, 'Été.md')
      return {
        'cafe\u0301.md': null,
        'moved/Été.md': {
          kind: 'file',
          bytes: Buffer.from('\ufeff[[Été#H]]\r\n'),
        },
        'unicode-ref.md': {
          kind: 'file',
          bytes: Buffer.from('[[Été#H|alias]]\r\n'),
        },
      }
    },
    {},
    '.obsidian',
    async (root) => {
      await writeFile(join(root, 'cafe\u0301.md'), '\ufeff[[café#H]]\r\n')
      await writeFile(join(root, 'unicode-ref.md'), '[[CAFÉ#H|alias]]\r\n')
    },
  )

  for (const title of [false, true]) {
    await scenario(
      `case-only rename through ${title ? 'document title' : 'explorer'}`,
      async ({ before }) => {
        if (title) {
          await openNote('case/Case.md', 'source')
          await page.evaluate(() => window.hibi.renameDocument('CASE.md'))
        } else {
          await page.evaluate(() =>
            window.hibi.workspaceAction({
              action: 'rename',
              path: 'case/Case.md',
              destination: 'CASE.md',
            }),
          )
        }
        return {
          'case/Case.md': null,
          'case/CASE.md': before.get('case/Case.md'),
        }
      },
    )
  }

  await scenario(
    'save-as cannot overwrite obsidian configuration',
    async ({ root }) => {
      await openNote('syntax.md', 'source')
      await app.evaluate(
        ({ dialog }, path) => {
          dialog.showSaveDialog = async () => ({
            canceled: false,
            filePath: path,
          })
        },
        join(root, '.obsidian/app.json'),
      )
      const message = await page.evaluate(() =>
        window.hibi.saveDocument(true).then(
          () => '',
          (error) => error.message,
        ),
      )
      assert.match(message, /configuration is read-only/)
      return {}
    },
  )

  async function selectParagraph(mode) {
    await page.evaluate(
      ({ mode, paragraph }) => {
        const editor = document.querySelector(
          mode === 'source'
            ? '.source-pane .cm-content'
            : '.rich-pane .cm-content',
        )
        const view = editor.cmTile.root.view
        const from = view.state.doc.toString().indexOf(paragraph)
        view.dispatch({
          selection: { anchor: from, head: from + paragraph.length },
        })
        view.focus()
      },
      { mode, paragraph },
    )
  }
  for (const mode of ['source', 'formatted']) {
    await scenario(
      `pasted image follows vault policy in ${mode}`,
      async ({ before }) => {
        const note = mode === 'source' ? 'crlf.md' : 'editable-bom.md'
        await openNote(note, mode)
        await selectParagraph(mode)
        const bytes = before.get('attachments/pixel.svg').bytes
        const markup =
          mode === 'source'
            ? '![[images/deep/pasted.svg|pasted]]'
            : '![pasted](/attachments/pasted.svg)'
        await page.evaluate(
          ({ bytes, mode }) => {
            const data = new DataTransfer()
            data.items.add(
              new File([new Uint8Array(bytes)], 'pasted.svg', {
                type: 'image/svg+xml',
              }),
            )
            const editor = document.querySelector(
              mode === 'source'
                ? '.source-pane .cm-content'
                : '.rich-pane .cm-content',
            )
            editor.dispatchEvent(
              new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: data,
              }),
            )
          },
          { bytes: [...bytes], mode },
        )
        await waitForAsync(
          page,
          async (markup) =>
            (await window.hibi.getDocument()).markdown.includes(markup),
          markup,
        )
        await clickMenu(app, 'Save')
        await waitForAsync(
          page,
          async () => !(await window.hibi.getDocument()).dirty,
        )
        return {
          [note]: replaceBytes(before, note, paragraph, markup),
          ...(mode === 'source'
            ? {
                images: { kind: 'directory' },
                'images/deep': { kind: 'directory' },
                'images/deep/pasted.svg': { kind: 'file', bytes },
              }
            : { 'attachments/pasted.svg': { kind: 'file', bytes } }),
        }
      },
      {
        attachmentFolderPath:
          mode === 'source' ? './images/deep' : 'attachments',
        useMarkdownLinks: mode !== 'source',
        newLinkFormat: mode === 'source' ? 'relative' : 'absolute',
      },
      mode === 'source' ? '.profile-日本語' : '.obsidian',
    )
  }

  await scenario(
    'inserted note link follows wiki/absolute settings',
    async ({ before }) => {
      await openNote('editable-bom.md', 'formatted')
      await selectParagraph('formatted')
      await page
        .locator('.editor-toolbar [data-toolbar-id="format.link"]')
        .click()
      const dialog = page.getByRole('dialog', {
        name: 'Insert link',
        exact: true,
      })
      await dialog
        .getByLabel('Link destination', { exact: true })
        .fill('unicode/café.md#Heading')
      await dialog.getByRole('button', { name: 'Insert', exact: true }).click()
      const markup = `[[unicode/café#Heading|${paragraph}]]`
      await waitForAsync(
        page,
        async (markup) =>
          (await window.hibi.getDocument()).markdown.includes(markup),
        markup,
      )
      await clickMenu(app, 'Save')
      await waitForAsync(
        page,
        async () => !(await window.hibi.getDocument()).dirty,
      )
      return {
        'editable-bom.md': replaceBytes(
          before,
          'editable-bom.md',
          paragraph,
          markup,
        ),
      }
    },
    { useMarkdownLinks: false, newLinkFormat: 'absolute' },
  )

  await scenario(
    'ambiguous profiles show notice and use safe defaults',
    async ({ root, before }) => {
      await page
        .getByText(/Multiple Obsidian configuration folders found/)
        .waitFor()
      await openNote('syntax.md', 'source')
      const bytes = before.get('attachments/pixel.svg').bytes
      const media = join(folder, 'ambiguous.svg')
      await writeFile(media, bytes)
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        })
      }, media)
      const result = await page.evaluate(async () =>
        window.hibi.attachMedia(
          null,
          (await window.hibi.getDocument()).revision,
        ),
      )
      assert.equal(
        result.attachments[0].markdown,
        '![[ambiguous.svg|ambiguous]]',
      )
      assert.deepEqual(await readFile(join(root, 'ambiguous.svg')), bytes)
      return { 'ambiguous.svg': { kind: 'file', bytes } }
    },
    {},
    ['.profile-one', '.profile-two'],
  )

  for (const action of ['rename', 'move', 'title']) {
    for (const policy of [true, false, 'ask']) {
      const alwaysUpdateLinks = policy === true
      await scenario(
        `${action}: alwaysUpdateLinks=${policy}`,
        async ({ before, result }) => {
          await app.evaluate(({ dialog }, accept) => {
            globalThis.fidelityLinkPrompts = []
            dialog.showMessageBox = async (_window, options) => {
              globalThis.fidelityLinkPrompts.push(options.message)
              return { response: accept ? 0 : 1 }
            }
          }, policy === 'ask')
          const destination =
            action !== 'move' ? 'Renamed.md' : 'moved/Target.md'
          const path = action !== 'move' ? 'nested/Renamed.md' : destination
          if (action === 'title') await openNote('nested/Target.md', 'source')
          result.reply = await page.evaluate(
            ({ action, destination }) =>
              action === 'title'
                ? window.hibi.renameDocument(destination)
                : window.hibi.workspaceAction({
                    action,
                    path: 'nested/Target.md',
                    destination,
                  }),
            { action, destination },
          )
          if (action !== 'title') assert.equal(result.reply.path, path)
          else assert.equal(result.reply.name, 'Renamed.md')
          const changes = {
            'nested/Target.md': null,
            [path]: before.get('nested/Target.md'),
          }
          if (policy !== false) {
            changes['board.canvas'] = {
              kind: 'file',
              bytes: Buffer.from(
                before
                  .get('board.canvas')
                  .bytes.toString()
                  .replace('"file":"nested/Target.md"', `"file":"${path}"`),
              ),
            }
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
                    .replaceAll('nested/Target', path.slice(0, -3)),
                ),
              }
            const referrer = before.get('nested/Referrer.md').bytes.toString()
            changes['nested/Referrer.md'] = {
              kind: 'file',
              bytes: Buffer.from(
                referrer
                  .slice(0, referrer.indexOf('`'))
                  .replace(
                    /\[\[Target/g,
                    `[[${action !== 'move' ? 'Renamed' : 'Target'}`,
                  )
                  .replace(
                    /\]\(Target/g,
                    `](${action !== 'move' ? 'Renamed' : '../moved/Target'}`,
                  ) + referrer.slice(referrer.indexOf('`')),
              ),
            }
          }
          const prompts = await app.evaluate(
            () => globalThis.fidelityLinkPrompts,
          )
          assert.equal(
            prompts.includes('Update links to this file?'),
            !alwaysUpdateLinks,
          )
          return changes
        },
        { alwaysUpdateLinks },
      )
    }
  }

  await scenario(
    'moved note keeps outgoing links and updates yaml properties and canvas strings',
    async ({ before }) => {
      const source = before.get('nested/Outgoing.md').bytes.toString()
      const canvas = before.get('references.canvas').bytes.toString()
      const path = 'moved/deep/Été.md'
      const reply = await page.evaluate(
        (destination) =>
          window.hibi.workspaceAction({
            action: 'move',
            path: 'nested/Outgoing.md',
            destination,
          }),
        path,
      )
      assert.equal(reply.path, path)
      return {
        'nested/Outgoing.md': null,
        [path]: {
          kind: 'file',
          bytes: Buffer.from(
            source
              .replaceAll('[[Outgoing', '[[Été')
              .replaceAll('../unicode/', '../../unicode/'),
          ),
        },
        'references.canvas': {
          kind: 'file',
          bytes: Buffer.from(
            canvas.replaceAll('nested/Outgoing', 'moved/deep/Été'),
          ),
        },
        'properties.md': {
          kind: 'file',
          bytes: Buffer.from(
            before
              .get('properties.md')
              .bytes.toString()
              .replaceAll('nested/Outgoing', 'moved/deep/Été'),
          ),
        },
      }
    },
    {},
    '.obsidian',
    async (root) => {
      await mkdir(join(root, 'moved/deep'))
      await writeFile(
        join(root, 'nested/Outgoing.md'),
        '\ufeff---\r\nlinks: ["[[Outgoing#self|alias]]"] # keep\r\n---\r\n[up](../unicode/caf%C3%A9.md#H "keep") [[../unicode/café#H]] [[Outgoing#self]]\r\n',
      )
      await writeFile(
        join(root, 'properties.md'),
        '\ufeff---\r\nlinks:\r\n  - "[[nested/Outgoing#self|alias]]"\r\nflow: [\'[[nested/Outgoing]]\'] # keep comment\r\n---\r\nbody stays\r\n',
      )
      await writeFile(
        join(root, 'references.canvas'),
        '{\r\n  "nodes": [{"id":"file","type":"file","file":"nested/Outgoing.md","subpath":"#self"}, {"id":"text","type":"text","text":"[[nested/Outgoing#self|alias]] [up](nested/Outgoing.md)"}],\r\n  "edges": [], "unknown":"keep"\r\n}\r\n',
      )
    },
  )

  await scenario(
    'title rename refreshes clean source session after self-link edits',
    async ({ before }) => {
      await openNote('nested/Self.md', 'source')
      await clickMenu(app, 'Command palette')
      await page
        .getByRole('combobox', { name: 'Search commands' })
        .fill('Rename document')
      await page.getByRole('option', { name: /Rename document/i }).click()
      const dialog = page.getByRole('dialog', {
        name: 'Rename document',
        exact: true,
      })
      const input = dialog.getByRole('textbox', {
        name: 'File name',
        exact: true,
      })
      await input.fill('Renamed.md')
      await input.press('Enter')
      await dialog.waitFor({ state: 'hidden' })
      await waitForAsync(
        page,
        async () => (await window.hibi.getDocument()).name === 'Renamed.md',
      )
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).dirty,
        false,
      )
      await waitForAsync(page, () =>
        document
          .querySelector('.source-pane .cm-content')
          ?.cmTile?.root?.view.state.doc.toString()
          .includes('[[Renamed#H|alias]]'),
      )
      return {
        'nested/Self.md': null,
        'nested/Renamed.md': {
          kind: 'file',
          bytes: Buffer.from(
            before
              .get('nested/Self.md')
              .bytes.toString()
              .replaceAll('[[Self', '[[Renamed'),
          ),
        },
      }
    },
    {},
    '.obsidian',
    async (root) => {
      await writeFile(
        join(root, 'nested/Self.md'),
        '\ufeff---\r\nlinks: ["[[Self#H|alias]]"]\r\n---\r\n# H\r\n[[Self#H|alias]]\r\n',
      )
    },
  )

  for (const title of [false, true]) {
    await scenario(
      `read-only referrer refuses ${title ? 'title rename' : 'explorer move'} before any write`,
      async () => {
        if (title) await openNote('nested/Target.md', 'source')
        const error = await page.evaluate(async (title) => {
          try {
            if (title) await window.hibi.renameDocument('New.md')
            else
              await window.hibi.workspaceAction({
                action: 'move',
                path: 'nested/Target.md',
                destination: 'moved/Target.md',
              })
            return null
          } catch (error) {
            return error.message
          }
        }, title)
        assert.match(error, /syntax\.md.*read-only/)
        return {}
      },
      {},
      '.obsidian',
      async (root) => {
        // The byte snapshot precedes the operation; the readonly mode is itself part of setup.
        await app.evaluate(async (_electron, root) => {
          const { chmod } = process.getBuiltinModule('fs/promises')
          await chmod(`${root}/syntax.md`, 0o444)
        }, root)
      },
    )
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
