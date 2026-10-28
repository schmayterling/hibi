import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, splitTab } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('editor extensions receive the view id of the editor they attach to', {
  timeout: 90000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-extension-context-'))
  const folder = join(profile, 'installed-addons', 'view-fixture')
  const file = join(profile, 'note.md')
  await mkdir(folder, { recursive: true })
  await writeFile(file, 'same note')
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'view-fixture',
      name: 'View fixture',
      description: 'Editor extension context fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      capabilities: ['rich', 'source'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default sdk => ({ start(context) {
      const fixture = window.viewFixture = { context, attached: [], attaches: 0, pending: [], lateCreates: 0 };
      const track = (kind, dom, viewId) => {
        const entry = { kind, dom, viewId };
        fixture.attached.push(entry);
        fixture.attaches++;
        return () => fixture.attached.splice(fixture.attached.indexOf(entry), 1);
      };
      context.editor.registerRich({ id: 'rich', attach: (editor, { viewId }) =>
        track('rich', editor.view.dom, viewId) });
      context.editor.registerSource({ id: 'source', create: ({ viewId }) =>
        sdk.codeMirror.view.ViewPlugin.define((view) =>
          ({ destroy: track('source', view.dom, viewId) })) });
      fixture.delaySource = () => context.editor.registerSource({ id: 'delayed',
        create: ({ viewId }) => new Promise(resolve => {
          const extension = sdk.codeMirror.view.ViewPlugin.define((view) => {
            fixture.lateCreates++;
            return { destroy: track('late', view.dom, viewId) };
          });
          fixture.pending.push({ viewId, resolve: () => resolve(extension) });
        }) });
    }});`,
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'view-fixture': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await selectFormattedEngine(app, page, t.formattedEngine)
  await page.waitForFunction(() => window.viewFixture)
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  // Pane sides come from the DOM only to label what the extension reported.
  const views = (target, kind) =>
    target.evaluate((kind) => {
      const { context, attached } = window.viewFixture
      return {
        active: context.editorViews.getActive()?.viewId ?? null,
        attached: attached
          .filter((entry) => entry.kind === kind)
          .map(({ dom, viewId }) => ({
            connected: dom.isConnected,
            side:
              dom.closest('.editor-page')?.getAttribute('data-side') ?? null,
            viewId,
          }))
          .sort((a, b) => String(a.side).localeCompare(String(b.side))),
      }
    }, kind)

  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  await waitForDocumentEditor(app, page)
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .click()
  // API 2 registerRich attaches only to Tiptap; CodeMirror exposes public view identity.
  if (t.formattedEngine === 'tiptap')
    await page.waitForFunction(() =>
      window.viewFixture.attached.some(
        (entry) =>
          entry.kind === 'rich' &&
          entry.dom.isConnected &&
          entry.viewId ===
            window.viewFixture.context.editorViews.getActive()?.viewId,
      ),
    )
  const single = await views(page, 'rich')
  if (t.formattedEngine === 'tiptap')
    assert.deepEqual(
      single.attached.filter((entry) => entry.connected),
      [{ connected: true, side: null, viewId: single.active }],
    )
  else {
    const selection = await page.evaluate(() => {
      const api = window.viewFixture.context.editorViews
      return api.getSelection(api.getActive())
    })
    assert.equal(selection.ok, true)
    assert.equal(selection.value.editor, 'rich')
    assert.equal(selection.value.view.viewId, single.active)
    assert.deepEqual(single.attached, [])
  }

  // The same note in both panes still gives each editor its own view.
  const tabId = (await page.evaluate(() => window.hibi.getDocument())).tabId
  await splitTab(app, page, tabId)
  const panes = {
    left: page.locator('.editor-page[data-side="left"]'),
    right: page.locator('.editor-page[data-side="right"]'),
  }
  const focusPane = async (side, editor) => {
    await editor.click()
    await page.waitForFunction(
      (side) =>
        document
          .querySelector(`.editor-page[data-side="${side}"]`)
          ?.getAttribute('data-active') === 'true',
      side,
    )
    return (await views(page, 'rich')).active
  }
  const rich = (side) =>
    panes[side].getByRole('textbox', { name: 'Document editor', exact: true })
  await rich('left').waitFor()
  await rich('right').waitFor()
  const richViews = {
    left: await focusPane('left', rich('left')),
    right: await focusPane('right', rich('right')),
  }
  assert.notEqual(richViews.left, richViews.right)
  if (t.formattedEngine === 'tiptap')
    await waitForAsync(
      page,
      (expected) =>
        window.viewFixture.attached.filter(
          (entry) =>
            entry.kind === 'rich' &&
            entry.dom.isConnected &&
            entry.viewId ===
              expected[
                entry.dom.closest('.editor-page')?.getAttribute('data-side')
              ],
        ).length === 2,
      richViews,
    )
  if (t.formattedEngine === 'tiptap') {
    assert.deepEqual(
      (await views(page, 'rich')).attached.filter((entry) => entry.connected),
      [
        { connected: true, side: 'left', viewId: richViews.left },
        { connected: true, side: 'right', viewId: richViews.right },
      ],
    )
  } else {
    const selections = await page.evaluate(() => {
      const api = window.viewFixture.context.editorViews
      return api.list().map((view) => api.getSelection(view))
    })
    assert.equal(selections.length, 2)
    for (const selection of selections) {
      assert.equal(selection.ok, true)
      assert.equal(selection.value.editor, 'rich')
    }
    assert.deepEqual(
      selections.map(({ value }) => value.view.viewId).sort(),
      Object.values(richViews).sort(),
    )
  }

  // Focus moves the active view without reattaching the inactive editor.
  const attaches = await page.evaluate(() => window.viewFixture.attaches)
  assert.equal(await focusPane('left', rich('left')), richViews.left)
  assert.equal(await focusPane('right', rich('right')), richViews.right)
  assert.equal(await page.evaluate(() => window.viewFixture.attaches), attaches)
  if (t.formattedEngine === 'tiptap') {
    assert.deepEqual(
      (await views(page, 'rich')).attached
        .filter((entry) => entry.side === 'left')
        .map((entry) => entry.viewId),
      [richViews.left],
    )
  } else {
    assert.equal(await focusPane('left', rich('left')), richViews.left)
    assert.equal(await focusPane('right', rich('right')), richViews.right)
    assert.deepEqual((await views(page, 'rich')).attached, [])
  }

  const source = (side) => panes[side].locator('.source-pane .cm-content')
  for (const side of ['left', 'right']) {
    await focusPane(side, rich(side))
    await page.getByRole('button', { name: 'Source view', exact: true }).click()
    await page.waitForFunction(
      (side) =>
        document.querySelector(
          `.editor-page[data-side="${side}"] .source-pane .cm-content`,
        )?.isContentEditable,
      side,
    )
  }
  const sourceViews = {
    left: await focusPane('left', source('left')),
    right: await focusPane('right', source('right')),
  }
  await t.test(
    'source and formatted editors preserve hosting view identities',
    async () => {
      assert.deepEqual(sourceViews, richViews)
      assert.deepEqual(
        (await views(page, 'source')).attached.filter(
          (entry) => entry.connected,
        ),
        [
          { connected: true, side: 'left', viewId: richViews.left },
          { connected: true, side: 'right', viewId: richViews.right },
        ],
      )
    },
  )

  // Removing a lazy extension before it resolves must cancel both attachments.
  await page.evaluate(() => {
    window.viewFixture.removeDelayed = window.viewFixture.delaySource()
  })
  await page.waitForFunction(() => window.viewFixture.pending.length === 2)
  assert.deepEqual(
    await page.evaluate(() =>
      window.viewFixture.pending.map(({ viewId }) => viewId).sort(),
    ),
    Object.values(sourceViews).sort(),
  )
  assert.equal(
    await page
      .locator('.source-pane .cm-content[contenteditable="false"]')
      .count(),
    2,
  )
  await page.evaluate(() => window.viewFixture.removeDelayed())
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '.source-pane .cm-content[contenteditable="true"]',
      ).length === 2,
  )
  await page.evaluate(async () => {
    for (const pending of window.viewFixture.pending) pending.resolve()
    await new Promise(requestAnimationFrame)
  })
  assert.equal(await page.evaluate(() => window.viewFixture.lateCreates), 0)
  assert.deepEqual((await views(page, 'late')).attached, [])
  assert.deepEqual(pageErrors, [])
})
