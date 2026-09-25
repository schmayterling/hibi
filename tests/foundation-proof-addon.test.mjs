import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const packagePath = resolve('examples/foundation-proof-addon')
const shortcut = 'CommandOrControl+Alt+Shift+F11'

async function eventually(read, predicate, message) {
  let last
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      last = await read()
      if (predicate(last)) return last
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await delay(50)
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`)
}

async function storageValue(path, key) {
  const data = JSON.parse(await readFile(path, 'utf8'))
  return data.entries[key]
}

test('proof package uses public addon surface and bounds editor intents', async () => {
  const manifest = JSON.parse(
    await readFile(join(packagePath, 'hibi-addon.json'), 'utf8'),
  )
  const source = await readFile(join(packagePath, 'index.js'), 'utf8')
  assert.equal(manifest.entry, 'index.js')
  assert.deepEqual(manifest.capabilities, ['ui'])
  assert.doesNotMatch(source, /window\.hibi|src\/renderer|node:/)
  const { completionItems, hoverInfo, contextActions } = await import(
    pathToFileURL(join(packagePath, 'index.js')).href
  )
  for (const editor of ['source', 'rich']) {
    const request = (before) => ({
      editor,
      before,
      selection: { anchor: before.length, head: before.length },
    })
    assert.deepEqual(completionItems(request('#pr'))[0], {
      label: '#proof',
      detail: 'workspace tag',
      insertText: '#proof',
      from: 0,
      to: 3,
    })
    assert.equal(
      completionItems(request('[[pr'))[0].insertText,
      '[[proof-note]]',
    )
    assert.deepEqual(completionItems(request('ordinary text')), [])
    assert.equal(
      hoverInfo({ selectedText: '#proof', before: '', after: '' }).label,
      'Proof tag',
    )
    assert.deepEqual(
      contextActions({
        selectedText: '#proof',
        selection: { anchor: 7, head: 1 },
      })[0].edit,
      { from: 1, to: 7, insertText: '#Proof' },
    )
    assert.deepEqual(
      contextActions({
        selectedText: 'a'.repeat(300),
        selection: { anchor: 0, head: 300 },
      }),
      [],
    )
  }
})

test('proof consumer handles unavailable secret storage and drops late work after disable', async () => {
  const { default: createAddon } = await import(
    pathToFileURL(join(packagePath, 'index.js')).href
  )
  const target = { workspaceId: 'a'.repeat(64), workspaceGeneration: 1 }
  let command
  let releaseNetwork
  let networkCalls = 0
  let edits = 0
  let creates = 0
  let disposed = 0
  const writes = []
  const addon = createAddon({ React: { createElement: () => null } })
  const context = {
    storage: {
      global: async () => ({
        snapshot: () => ({
          status: 'version-mismatch',
          storedVersion: 1,
          value: {
            tag: 'proof',
            endpoint: 'https://example.test/proof',
            globalShortcut: true,
          },
        }),
        set: async (value, options) => {
          writes.push({ scope: 'global', value, options })
          return { status: 'saved' }
        },
      }),
      workspace: async () => ({
        set: async (value) => {
          writes.push({ scope: 'workspace', value })
          return { status: 'saved' }
        },
      }),
    },
    views: {
      register: () => ({
        open() {},
        dispose() {
          disposed++
        },
      }),
    },
    workspace: {
      subscribeChanges: async () => ({
        dispose() {
          disposed++
        },
      }),
      createText: async () => {
        creates++
        return { ok: false, code: 'conflict' }
      },
      query: async ({ kind }) => ({
        ok: true,
        value: { items: kind === 'backlinks' ? ['b.md'] : ['proof-note.md'] },
      }),
    },
    editor: {
      registerCompletionProvider: async () => () => disposed++,
      registerHoverProvider: async () => () => disposed++,
      registerContextActionProvider: async () => () => disposed++,
    },
    commands: {
      register(value) {
        command = value
        return () => disposed++
      },
    },
    globalShortcuts: {
      register: async () => () => disposed++,
    },
    documents: {
      readSource: () => ({
        status: 'read',
        target: { documentId: 'a', documentGeneration: 1, contentVersion: 1 },
        source: '# Alpha',
      }),
      applyEdits: () => {
        edits++
        return { status: 'applied' }
      },
    },
    host: {
      network: {
        getText: async () => {
          if (++networkCalls === 1)
            return {
              ok: true,
              value: { status: 200, text: 'foundation-proof-ok' },
            }
          return new Promise((done) => {
            releaseNetwork = () =>
              done({
                ok: true,
                value: { status: 200, text: 'foundation-proof-ok' },
              })
          })
        },
      },
      credentials: {
        status: async () => ({
          ok: true,
          value: { stored: 'missing', persistence: 'unprotected' },
        }),
        store: async ({ secret }) => {
          assert.equal(secret, 'fixture-only-not-a-credential')
          return { ok: false, code: 'unprotected' }
        },
      },
    },
    notify: () => {},
  }
  await addon.start(context)
  assert.equal(writes[0].options.migrateFromVersion, 1)
  await command.run({ workspace: target, document: { documentId: 'a' } })
  assert.deepEqual(writes.at(-1).value, {
    tag: 'proof',
    lastRun: {
      run: 1,
      events: 0,
      edit: 'applied',
      note: 'conflict',
      backlinks: ['b.md'],
      tags: ['proof-note.md'],
      network: { status: 200, matchesFixture: true },
      credential: 'unprotected',
    },
  })
  const late = command.run({ workspace: target, document: { documentId: 'a' } })
  assert.equal(typeof releaseNetwork, 'function')
  addon.stop()
  releaseNetwork()
  await late
  assert.equal(edits, 1)
  assert.equal(creates, 1)
  assert.equal(writes.length, 2)
  assert.equal(disposed, 7)
})

test('installed proof addon migrates state and composes captured edits, queries, providers, and grants', {
  timeout: 120000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-foundation-proof-'))
  const profile = join(root, 'profile')
  const folder = join(profile, 'installed-addons', 'foundation-proof')
  const workspace = join(root, 'notes')
  const first = join(workspace, 'a.md')
  const second = join(workspace, 'b.md')
  const cert = join(root, 'test-ca.pem')
  const key = join(root, 'test-key.pem')
  await mkdir(workspace)
  await writeFile(first, '# Alpha\n')
  await writeFile(second, '# Beta\n\n[Alpha](a.md)\n\nReady')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  const server = createServer(
    {
      key: await readFile(key),
      cert: await readFile(cert),
    },
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('foundation-proof-ok')
    },
  )
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(async () => {
    await new Promise((done) => server.close(done))
    await rm(root, { recursive: true, force: true })
  })
  const url = `https://127.0.0.1:${server.address().port}/proof`
  await cp(packagePath, folder, { recursive: true })
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['README.md', 'hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'foundation-proof': true }),
  )
  const globalFile = join(
    profile,
    'addon-storage',
    'global',
    'foundation-proof.json',
  )
  await mkdir(join(profile, 'addon-storage', 'global'), {
    recursive: true,
  })
  await writeFile(
    globalFile,
    JSON.stringify({
      format: 1,
      entries: {
        preferences: {
          version: 1,
          revision: 1,
          value: { tag: 'proof', endpoint: url, globalShortcut: true },
        },
      },
    }),
  )

  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
    env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close()
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  const migrated = await eventually(
    () => storageValue(globalFile, 'preferences'),
    (value) => value?.version === 2,
    'global preferences did not migrate',
  )
  assert.equal(migrated.revision, 2)
  assert.deepEqual(migrated.value, {
    tag: 'proof',
    networkUrl: url,
    globalShortcut: true,
  })
  const registered = await app.evaluate(
    ({ globalShortcut }, accelerator) =>
      globalShortcut.isRegistered(accelerator),
    shortcut,
  )
  if (!registered)
    t.diagnostic('optional OS shortcut unavailable on this runner')

  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspace)
  await page.evaluate(() => window.hibi.openWorkspace())
  const workspaceTarget = await page.evaluate(
    async () => (await window.hibi.getWorkspaceChangeSnapshot()).target,
  )
  assert.ok(workspaceTarget)
  const workspaceFile = join(
    profile,
    'addon-storage',
    'workspace',
    workspaceTarget.workspaceId,
    'foundation-proof.json',
  )

  async function open(path) {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      })
    }, path)
    await clickMenu(app, 'Open…')
    await page.waitForFunction(
      async (name) => (await window.hibi.getDocument())?.name === name,
      basename(path),
    )
  }

  await open(first)
  await app.evaluate(({ dialog }) => {
    globalThis.proofPrompts = []
    globalThis.holdProofGrant = true
    dialog.showMessageBox = async (_window, options) => {
      globalThis.proofPrompts.push(options.message)
      if (globalThis.holdProofGrant) {
        globalThis.holdProofGrant = false
        return new Promise((done) => {
          globalThis.releaseProofGrant = () => done({ response: 1 })
        })
      }
      return { response: 1 }
    }
  })
  await clickMenu(app, 'Capture foundation proof')
  await eventually(
    () =>
      app.evaluate(() => typeof globalThis.releaseProofGrant === 'function'),
    Boolean,
    'network grant did not start',
  )
  await open(second)
  await app.evaluate(() => globalThis.releaseProofGrant())

  const firstRun = await eventually(
    () => storageValue(workspaceFile, 'preferences'),
    (value) => value?.value?.lastRun?.run === 1,
    'first proof run did not finish',
  )
  assert.equal(firstRun.value.tag, 'proof')
  assert.equal(firstRun.value.lastRun.edit, 'applied')
  assert.equal(firstRun.value.lastRun.note, 'created')
  assert.deepEqual(firstRun.value.lastRun.network, {
    status: 200,
    matchesFixture: true,
  })
  assert.ok(firstRun.value.lastRun.backlinks.includes('b.md'))
  assert.ok(firstRun.value.lastRun.tags.includes('proof-note.md'))
  assert.ok(
    ['protected', 'unprotected', 'locked-or-unavailable'].includes(
      firstRun.value.lastRun.credential,
    ),
  )
  assert.equal(await readFile(first, 'utf8'), '# Alpha\n')
  assert.equal(
    await readFile(join(workspace, 'proof-note.md'), 'utf8'),
    '# Foundation proof\n\n#proof\n',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'b.md',
  )
  await page.getByRole('tab', { name: 'a.md' }).click()
  await page.waitForFunction(
    async () =>
      (await window.hibi.getDocument())?.markdown === '# Alpha\n\n#proof',
  )
  await page.getByRole('tab', { name: 'b.md' }).click()

  const rich = page.locator('.rich-pane .tiptap[contenteditable="true"]')
  await rich.waitFor()
  await rich.locator('p').last().click()
  await rich.press('End')
  await page.keyboard.type(' #pr')
  const richMenu = page.getByRole('listbox', { name: 'Completions' })
  try {
    await richMenu.getByRole('option', { name: /#proof/ }).waitFor()
  } catch (error) {
    const state = await page.evaluate(async () => ({
      markdown: (await window.hibi.getDocument())?.markdown,
      focused: document.activeElement?.outerHTML.slice(0, 200),
      rich: document.querySelector('.rich-pane .tiptap')?.innerHTML,
    }))
    throw new Error(
      `Rich proof completion unavailable: ${JSON.stringify(state)}`,
      {
        cause: error,
      },
    )
  }
  await page.keyboard.press('Enter')
  await page.waitForFunction(async () =>
    (await window.hibi.getDocument())?.markdown.includes('#proof'),
  )
  await rich.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await page.waitForFunction(
    async () => !(await window.hibi.getDocument())?.markdown.includes('#proof'),
  )

  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await source.waitFor()
  await source.focus()
  await source.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await page.keyboard.type('[[pr')
  await page
    .locator('.cm-tooltip-autocomplete .cm-completionLabel', {
      hasText: '[[proof-note]]',
    })
    .waitFor()
  await page.waitForTimeout(100)
  await source.press('Tab')
  await page.waitForFunction(async () =>
    (await window.hibi.getDocument())?.markdown.includes('[[proof-note]]'),
  )

  await clickMenu(app, 'Capture foundation proof')
  const secondRun = await eventually(
    () => storageValue(workspaceFile, 'preferences'),
    (value) => value?.value?.lastRun?.run === 2,
    'second proof run did not finish',
  )
  assert.equal(secondRun.value.lastRun.note, 'conflict')
  assert.equal(
    await readFile(join(workspace, 'proof-note.md'), 'utf8'),
    '# Foundation proof\n\n#proof\n',
  )
  assert.equal(
    (await app.evaluate(() => globalThis.proofPrompts)).filter((message) =>
      message.includes('local or private'),
    ).length,
    2,
  )

  await source.locator('.cm-line').last().hover()
  await page.getByRole('tooltip', { name: 'Editor hover' }).waitFor()
  await source.focus()
  await source.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  for (let index = 0; index < '#proof'.length; index++)
    await source.press('Shift+ArrowLeft')
  await source.press('Shift+F10')
  const actionMenu = page.getByRole('menu', { name: 'Editor actions' })
  await actionMenu
    .getByRole('menuitem', { name: 'Capitalize proof tag' })
    .waitFor()
  await source.press('Enter')
  await page.waitForFunction(async () =>
    (await window.hibi.getDocument())?.markdown.endsWith('#Proof'),
  )
  await source.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await page.waitForFunction(async () =>
    (await window.hibi.getDocument())?.markdown.endsWith('#proof'),
  )

  await app.evaluate(({ dialog }) => {
    globalThis.holdProofGrant = true
    globalThis.releaseProofGrant = undefined
    dialog.showMessageBox = async (_window, options) => {
      globalThis.proofPrompts.push(options.message)
      if (globalThis.holdProofGrant) {
        globalThis.holdProofGrant = false
        return new Promise((done) => {
          globalThis.releaseProofGrant = () => done({ response: 1 })
        })
      }
      return { response: 1 }
    }
  })
  await clickMenu(app, 'Capture foundation proof')
  await eventually(
    () =>
      app.evaluate(() => typeof globalThis.releaseProofGrant === 'function'),
    Boolean,
    'pending proof run did not start',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const enabled = page.locator('#addon-foundation-proof')
  await enabled.click()
  await page.waitForFunction(
    () => document.querySelector('#addon-foundation-proof')?.checked === false,
  )
  await eventually(
    () =>
      app.evaluate(
        ({ globalShortcut }, accelerator) =>
          globalShortcut.isRegistered(accelerator),
        shortcut,
      ),
    (value) => !value,
    'global shortcut survived disable',
  )
  await app.evaluate(() => globalThis.releaseProofGrant())
  await delay(100)
  assert.equal(
    (await storageValue(workspaceFile, 'preferences')).value.lastRun.run,
    2,
  )
  await page
    .getByText('Proof run 2:', { exact: false })
    .waitFor({ state: 'hidden' })

  await enabled.click()
  await page.waitForFunction(
    () => document.querySelector('#addon-foundation-proof')?.checked === true,
  )
  await eventually(
    () =>
      app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()
          ?.items.find(({ label }) => label.toLowerCase() === 'addons')
          ?.submenu?.items.some(
            ({ label }) => label === 'Capture foundation proof',
          ),
      ),
    Boolean,
    'proof command did not return after enable',
  )
  assert.equal((await storageValue(globalFile, 'preferences')).revision, 2)
})
