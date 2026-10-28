import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  electron,
  waitForAppState,
  waitForDocumentEditor,
} from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

async function reportSelection(t, editor) {
  t.diagnostic(
    JSON.stringify(
      await editor.evaluate((element) => {
        const view = element.cmTile?.root.view
        const selection = view?.state.selection.main
        return {
          selected: getSelection()?.toString(),
          focused: document.activeElement === element,
          active: document.activeElement?.tagName,
          documentFocused: document.hasFocus(),
          range: selection && {
            anchor: selection.anchor,
            head: selection.head,
          },
          readOnly: view?.state.readOnly,
          editable: element.isContentEditable,
        }
      }),
    ),
  )
}

const scheme = {
  id: 'dusk',
  name: 'Reload dusk',
  appearance: 'dark',
  author: 'Test',
  license: { name: 'MIT', text: 'Permission notice' },
  colors: {
    background: '#101820',
    surface: '#202830',
    ink: '#eeeeee',
    muted: '#aaaaaa',
    accent: '#88cccc',
    border: '#333333',
  },
}
const manifest = (id, name, fields = {}) => ({
  id,
  name,
  description: 'Addon reload fixture',
  kind: 'extension',
  apiVersion: 2,
  version: '1.0.0',
  authors: [{ displayName: 'Test' }],
  entry: 'index.js',
  capabilities: [],
  ...fields,
})
const providerSource = (version) => `export default (sdk) => ({
  async start(context) {
    const generation = (window.providerStarts = (window.providerStarts || 0) + 1);
    window.providerVersion = ${version};
    (window.reloadLog ||= []).push('start:provider');
    if (localStorage.getItem('reload-provider-fail')) throw new Error('Provider start failed');
    context.exports.provide({ version: 1, generation });
    window.useDusk = () => context.colorschemes.setPreferences({ mode: 'dark', dark: 'reload-provider.dusk' });
    if (window.holdProvider) {
      window.holdProvider = false;
      await new Promise((resolve) => { window.releaseProvider = resolve; });
    }
    context.styles.register('generation', ':root { --provider-generation: ' + generation + '; }');
  },
  stop() {
    window.reloadLog.push('stop:provider');
    if (localStorage.getItem('reload-provider-throw')) throw new Error('Provider stop failed');
  },
  Settings: sdk?.React
    ? () => sdk.React.createElement('input', { 'aria-label': 'Reload provider draft' })
    : () => null,
});`
const consumerSource = `export default () => ({
  async start(context) {
    window.consumerStarts = (window.consumerStarts || 0) + 1;
    window.reloadLog.push('start:consumer');
    window.consumerSaw = (await context.addons.ready('reload-provider')).generation;
  },
  stop() { window.reloadLog.push('stop:consumer'); },
});`

async function writePackage(folder, data, files) {
  await mkdir(folder, { recursive: true })
  for (const [path, content] of Object.entries({
    'hibi-addon.json': JSON.stringify(data),
    'README.md': `# ${data.name}`,
    ...files,
  })) {
    await mkdir(dirname(join(folder, path)), { recursive: true })
    await writeFile(join(folder, path), content)
  }
  return Object.keys(files)
}
const sendReload = (app, id, scope = 'code') =>
  app.evaluate(
    ({ BrowserWindow }, request) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === 'app://hibi/')
        .webContents.send('addons:reload', request)
    },
    { id, scope },
  )
async function writeInstalled(profile, data, files, hash) {
  const folder = join(profile, 'installed-addons', data.id)
  const written = await writePackage(folder, data, files)
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: hash.repeat(64),
      files: ['hibi-addon.json', 'README.md', ...written],
      source: 'local',
      resources: true,
    }),
  )
  return folder
}

test('reload restarts an addon and its consumers in place, refuses open windows and settings, and swaps package styles', {
  timeout: 90000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-addon-reload-'))
  const profile = join(temp, 'profile')
  const provider = await writeInstalled(
    profile,
    manifest('reload-provider', 'Reload provider', {
      styles: ['provider.css'],
      themes: ['themes/dusk.json'],
    }),
    {
      'index.js': providerSource(1),
      'provider.css': '.reload-probe { color: rgb(1, 2, 3); }',
      'themes/dusk.json': JSON.stringify(scheme),
    },
    'a',
  )
  await writeInstalled(
    profile,
    manifest('reload-consumer', 'Reload consumer', {
      requires: { addons: [{ id: 'reload-provider' }] },
      styles: ['consumer.css'],
    }),
    {
      'index.js': consumerSource,
      'consumer.css': '.reload-probe { outline-color: rgb(1, 2, 3); }',
    },
    'b',
  )
  const preferences = join(profile, 'addons.json')
  await writeFile(
    preferences,
    JSON.stringify({
      'reload-provider': true,
      'reload-consumer': true,
      'quick-note': true,
    }),
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
  page.setDefaultTimeout(7000)
  await selectFormattedEngine(app, page, t.formattedEngine)
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => window.consumerSaw === 1)
  const reload = (id, scope) => sendReload(app, id, scope)
  const log = () => page.evaluate(() => window.reloadLog.splice(0))
  const message = (pattern) =>
    page.waitForFunction(
      (source) => new RegExp(source, 'i').test(document.body.innerText),
      pattern.source,
    )
  const saved = async () => (await stat(preferences)).mtimeMs
  const before = await saved()
  await log()

  const editor = page.getByRole('textbox', { name: /document editor/i })
  await editor.click()
  await page.keyboard.type('Draft kept across reload')
  await waitForAppState(
    page,
    async () => (await window.hibi.getDocument()).dirty,
  )

  // Consumers stop first; providers start first.
  await reload('reload-provider')
  await page.waitForFunction(() => window.consumerSaw === 2)
  assert.deepEqual(await log(), [
    'stop:consumer',
    'stop:provider',
    'start:provider',
    'start:consumer',
  ])
  await waitForDocumentEditor(app, page)
  assert.match(await editor.innerText(), /Draft kept across reload/)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).dirty,
    true,
  )

  // A newer reload supersedes a start that is still running; the late start leaves nothing behind.
  await page.evaluate(() => {
    window.holdProvider = true
  })
  await reload('reload-provider')
  await page.waitForFunction(() => !!window.releaseProvider)
  await reload('reload-provider')
  await page.waitForFunction(() => window.consumerSaw === 4)
  await page.evaluate(() => window.releaseProvider())
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--provider-generation')
        .trim() === '4',
  )
  await page.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(
    await page
      .locator('style[data-addon-style="reload-provider.generation"]')
      .count(),
    1,
  )
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--provider-generation')
        .trim(),
    ),
    '4',
  )
  assert.equal(
    await page.locator('link[data-addon-style^="reload-"]').count(),
    2,
  )
  await log()

  // A throwing stop still restarts the provider and its consumer.
  await page.evaluate(() => localStorage.setItem('reload-provider-throw', '1'))
  await reload('reload-provider')
  await page.waitForFunction(() => window.consumerSaw === 5)
  await message(/could not fully stop reload provider/)
  await page.evaluate(() => localStorage.removeItem('reload-provider-throw'))
  assert.deepEqual(await log(), [
    'stop:consumer',
    'stop:provider',
    'start:provider',
    'start:consumer',
  ])

  // A failed addon starts again once a later reload finds the cause fixed.
  await page.evaluate(() => localStorage.setItem('reload-provider-fail', '1'))
  await reload('reload-provider')
  await message(/provider start failed/)
  await page.waitForFunction(() => window.providerStarts === 6)
  await page.evaluate(() => localStorage.removeItem('reload-provider-fail'))
  await reload('reload-provider')
  await page.waitForFunction(() => window.consumerSaw === 7)
  await log()

  // Stylesheet-only updates swap sheets and themes without restarting code.
  await page.evaluate(() => {
    window.useDusk()
    const probe = document.createElement('div')
    probe.className = 'reload-probe'
    document.body.append(probe)
    window.schemeChanges = []
    new MutationObserver((records) =>
      window.schemeChanges.push(...records.map((record) => record.oldValue)),
    ).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-colorscheme'],
      attributeOldValue: true,
    })
  })
  const accent = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--accent')
        .trim(),
    )
  assert.equal(await accent(), '#88cccc')
  await writeFile(
    join(provider, 'provider.css'),
    '.reload-probe { color: rgb(4, 5, 6); }',
  )
  await writeFile(
    join(provider, 'themes/dusk.json'),
    JSON.stringify({
      ...scheme,
      colors: { ...scheme.colors, accent: '#ff00ff' },
    }),
  )
  await reload('reload-provider', 'styles')
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.reload-probe')).color ===
      'rgb(4, 5, 6)',
  )
  assert.equal(await accent(), '#ff00ff')
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.body.querySelectorAll('[data-addon-style^="reload-"]')].map(
        (element) => `${element.localName}:${element.dataset.addonStyle}`,
      ),
    ),
    [
      'link:reload-consumer',
      'link:reload-provider',
      'style:reload-provider.generation',
    ],
  )
  assert.equal(
    await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.reload-probe')).outlineColor,
    ),
    'rgb(1, 2, 3)',
  )
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.colorscheme),
    'reload-provider.dusk',
  )
  assert.deepEqual(
    await page.evaluate(() =>
      window.schemeChanges.filter((value) => value !== 'reload-provider.dusk'),
    ),
    [],
  )
  assert.equal(await page.evaluate(() => window.providerStarts), 7)
  assert.deepEqual(await log(), [])

  // A manifest that drops its stylesheets removes them in place too.
  const declared = JSON.parse(
    await readFile(join(provider, 'hibi-addon.json'), 'utf8'),
  )
  delete declared.styles
  await writeFile(join(provider, 'hibi-addon.json'), JSON.stringify(declared))
  await reload('reload-provider', 'styles')
  await page
    .locator('link[data-addon-style="reload-provider"]')
    .waitFor({ state: 'detached' })
  assert.notEqual(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.reload-probe')).color,
    ),
    'rgb(4, 5, 6)',
  )
  assert.equal(await page.evaluate(() => window.providerStarts), 7)

  // Reloading never writes enabled settings.
  assert.equal(await saved(), before)

  // Visible settings and open addon windows refuse a reload instead of discarding their state.
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^reload provider$/i }).click()
  await reload('reload-provider')
  await message(
    /leave the reload provider settings before reloading reload provider/,
  )
  assert.equal(await page.evaluate(() => window.providerStarts), 7)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page
    .getByRole('main', { name: /^settings$/i })
    .waitFor({ state: 'hidden' })
  await reload('reload-provider')
  await page.waitForFunction(() => window.consumerSaw === 8)

  await page.evaluate(() =>
    window.hibi.openAddonWindow('quick-note', { id: 'reload', show: false }),
  )
  await reload('quick-note')
  await message(/close the quick note windows before reloading quick note/)
  await page.evaluate(() =>
    window.hibi.closeAddonWindow('quick-note', 'reload'),
  )
  await waitForAppState(
    page,
    async () => !(await window.hibi.getAddonWindowOwners()).length,
  )
  assert.equal(await saved(), before)
  assert.match(await readFile(preferences, 'utf8'), /"reload-provider":true/)
})

test('a reviewed replacement stays enabled and reloads in place unless its access changes', {
  timeout: 60000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-addon-replace-'))
  const profile = join(temp, 'profile')
  const preferences = join(profile, 'addons.json')
  const data = manifest('reload-provider', 'Reload provider', {
    capabilities: ['ui'],
  })
  await writeInstalled(profile, data, { 'index.js': providerSource(1) }, 'a')
  await writeInstalled(
    profile,
    manifest('reload-consumer', 'Reload consumer', {
      requires: { addons: [{ id: 'reload-provider' }] },
    }),
    { 'index.js': consumerSource },
    'b',
  )
  await writeFile(
    preferences,
    JSON.stringify({ 'reload-provider': true, 'reload-consumer': true }),
  )
  const same = join(temp, 'same')
  await writePackage(
    same,
    { ...data, version: '2.0.0' },
    { 'index.js': providerSource(2) },
  )
  const widened = join(temp, 'widened')
  await writePackage(
    widened,
    {
      ...data,
      version: '3.0.0',
      network: { origins: ['https://example.com'] },
    },
    { 'index.js': providerSource(3) },
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    globalThis.packageReviews = []
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.packageSource],
    })
    dialog.showMessageBox = async (_window, options) => {
      globalThis.packageReviews.push(options.detail)
      return { response: 1 }
    }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await selectFormattedEngine(app, page, t.formattedEngine)
  await page.evaluate(() =>
    window.hibi.setAddonTrustSettings({
      allowUnsigned: true,
      checkRevocations: false,
    }),
  )
  await page.waitForFunction(() => window.consumerSaw === 1)
  const install = async (source) => {
    await app.evaluate((_electron, source) => {
      globalThis.packageSource = source
    }, source)
    await clickMenu(app, 'Command palette')
    await page
      .getByRole('combobox', { name: /search commands/i })
      .fill('install addon')
    await page.getByRole('option').first().click()
  }
  const enabled = async () =>
    (await page.evaluate(() => window.hibi.getAddonStates())).find(
      (state) => state.id === 'reload-provider',
    ).enabled
  const before = (await stat(preferences)).mtimeMs

  // Open settings with unsaved input refuse the replacement before anything changes.
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^reload provider$/i }).click()
  const draft = page.getByRole('textbox', { name: /reload provider draft/i })
  await draft.fill('unsaved settings draft')
  await install(same)
  await page.waitForFunction(() =>
    /leave the reload provider settings, then install the replacement again/i.test(
      document.body.innerText,
    ),
  )
  assert.equal(await draft.inputValue(), 'unsaved settings draft')
  assert.equal(await page.evaluate(() => window.providerVersion), 1)
  assert.equal(await page.evaluate(() => window.providerStarts), 1)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page
    .getByRole('main', { name: /^settings$/i })
    .waitFor({ state: 'hidden' })

  // Settings opened while the replacement is under way stay closed until it finishes.
  await app.evaluate(() => {
    globalThis.hibiTestPauses = {
      'addon-replacement': new Promise((resolve) => {
        globalThis.resumeReplacement = resolve
      }),
    }
  })
  const reviews = await app.evaluate(() => globalThis.packageReviews.length)
  await install(same)
  // Wait until the user has confirmed and main is replacing the package.
  for (const deadline = Date.now() + 10000; ; ) {
    if ((await app.evaluate(() => globalThis.packageReviews.length)) > reviews)
      break
    if (Date.now() > deadline)
      throw new Error('The replacement was not confirmed.')
    await new Promise((resolve) => setImmediate(resolve))
  }
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^reload provider$/i }).click()
  const updating = page.getByText(
    /these settings open again when the update finishes/i,
  )
  await updating.waitFor()
  assert.equal(await draft.count(), 0)
  // A second installation is refused without releasing the first one's settings.
  await install(same)
  await page.waitForFunction(() =>
    /another (addon installation|file operation) is (still running|in progress)/i.test(
      document.body.innerText,
    ),
  )
  await updating.waitFor()
  assert.match(
    await page.evaluate(() => document.body.innerText),
    /another addon installation is still running/i,
  )
  assert.equal(await draft.count(), 0)
  assert.equal(await page.evaluate(() => window.providerVersion), 1)
  await app.evaluate(() => {
    delete globalThis.hibiTestPauses
    globalThis.resumeReplacement()
  })
  await page.waitForFunction(
    () => window.providerVersion === 2 && window.consumerSaw === 2,
  )
  await draft.fill('draft after the update')
  assert.equal(await draft.inputValue(), 'draft after the update')
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page
    .getByRole('main', { name: /^settings$/i })
    .waitFor({ state: 'hidden' })
  assert.equal(await enabled(), true)
  assert.equal(await page.evaluate(() => window.providerStarts), 2)
  assert.deepEqual(await page.evaluate(() => window.reloadLog), [
    'start:provider',
    'start:consumer',
    'stop:consumer',
    'stop:provider',
    'start:provider',
    'start:consumer',
  ])
  assert.equal((await stat(preferences)).mtimeMs, before)
  assert.match(
    await app.evaluate(() => globalThis.packageReviews.at(-1)),
    /keeps its current setting/,
  )

  await install(widened)
  await waitForAppState(
    page,
    async () =>
      !(await window.hibi.getAddonStates()).find(
        (state) => state.id === 'reload-provider',
      ).enabled,
  )
  assert.match(
    await app.evaluate(() => globalThis.packageReviews.at(-1)),
    /stay disabled until you enable it/,
  )
  assert.equal(
    JSON.parse(await readFile(preferences, 'utf8'))['reload-provider'],
    false,
  )
  await page.waitForFunction(() => window.reloadLog.at(-1) === 'stop:provider')
  assert.equal(await page.evaluate(() => window.providerVersion), 2)
})

async function launchRetryFixtures(t) {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-addon-retry-'))
  const profile = join(temp, 'profile')
  const providerFixture = (id) => `export default () => ({
    async start() {
      window.starts ||= {};
      window.starts['${id}'] = (window.starts['${id}'] || 0) + 1;
      if (localStorage.getItem('${id}-fail')) throw new Error('${id} start failed');
      (window.live ||= {})['${id}'] = true;
      if (window.hold === '${id}') {
        window.hold = null;
        await new Promise((resolve) => { window.release = resolve; });
      }
    },
    stop() { window.live['${id}'] = false; },
  });`
  for (const [id, fields, source] of [
    ['retry-a', {}, providerFixture('retry-a')],
    ['retry-b', {}, providerFixture('retry-b')],
    [
      'retry-x',
      { requires: { addons: [{ id: 'retry-a' }, { id: 'retry-b' }] } },
      providerFixture('retry-x'),
    ],
    [
      'retry-c',
      {
        requires: { addons: [{ id: 'retry-a' }] },
        activation: 'command',
        commands: [{ id: 'probe', label: 'Retry commander probe' }],
      },
      `export default () => ({
        start(context) {
          window.starts ||= {};
          window.starts['retry-c'] = (window.starts['retry-c'] || 0) + 1;
          context.commands.register({ id: 'probe', label: 'Retry commander probe', run() { window.commanderRan = true; } });
        },
      });`,
    ],
  ])
    await writeInstalled(
      profile,
      manifest(id, id, fields),
      { 'index.js': source },
      'c',
    )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({
      'retry-a': true,
      'retry-b': true,
      'retry-x': true,
      'retry-c': true,
    }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await selectFormattedEngine(app, page, t.formattedEngine)
  await waitForDocumentEditor(app, page)
  const counts = () => page.evaluate(() => ({ ...window.starts }))
  const live = (...ids) =>
    page.waitForFunction((ids) => ids.every((id) => window.live?.[id]), ids)
  await live('retry-a', 'retry-b', 'retry-x')
  return { app, page, counts, live }
}

test('reload retries failed providers across its closure and the consumers they blocked', {
  timeout: 60000,
}, async (t) => {
  const { app, page, counts, live } = await launchRetryFixtures(t)

  // Both providers of `retry-x` fail; reloading one retries the other and the consumer they blocked.
  await page.evaluate(() => {
    localStorage.setItem('retry-a-fail', '1')
    localStorage.setItem('retry-b-fail', '1')
  })
  let before = await counts()
  await sendReload(app, 'retry-a')
  await page.waitForFunction(
    (before) => window.starts['retry-a'] > before['retry-a'],
    before,
  )
  before = await counts()
  await sendReload(app, 'retry-b')
  await page.waitForFunction(
    (before) => window.starts['retry-b'] > before['retry-b'],
    before,
  )
  assert.equal(
    await page.evaluate(() => Object.values(window.live).some(Boolean)),
    false,
  )
  await page.evaluate(() => {
    localStorage.removeItem('retry-a-fail')
    localStorage.removeItem('retry-b-fail')
  })
  before = await counts()
  await sendReload(app, 'retry-a')
  await live('retry-a', 'retry-b', 'retry-x')
  assert.equal((await counts())['retry-x'], before['retry-x'] + 1)
})

test('overlapping reloads leave an unstarted command consumer to its command', {
  timeout: 60000,
}, async (t) => {
  const { app, page, counts } = await launchRetryFixtures(t)
  // Overlapping reloads wait only for addons that were running; the command consumer still starts on demand.
  assert.equal((await counts())['retry-c'], undefined)
  await page.evaluate(() => {
    window.hold = 'retry-a'
  })
  const before = await counts()
  await sendReload(app, 'retry-a')
  await page.waitForFunction(() => !!window.release)
  await sendReload(app, 'retry-a')
  await page.waitForFunction(
    (before) =>
      window.starts['retry-a'] === before['retry-a'] + 2 &&
      window.starts['retry-x'] === before['retry-x'] + 1 &&
      window.live['retry-x'],
    before,
  )
  await page.evaluate(() => window.release())
  assert.equal((await counts())['retry-c'], undefined)
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Retry commander probe')
  await page
    .getByRole('option', { name: /retry commander probe/i })
    .first()
    .click()
  await page.waitForFunction(() => window.commanderRan === true, null, {
    timeout: 10000,
  })
  assert.equal((await counts())['retry-c'], 1)
})

test('reloading an editor extension restores the selection and focus once it settles', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-addon-reload-editor-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  let cdp
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await cdp?.detach()
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await selectFormattedEngine(app, page, t.formattedEngine)
  if (t.formattedEngine === 'codemirror') {
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  }
  await waitForDocumentEditor(app, page)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  await editor.click()
  await page.keyboard.type('Hello world, reload me')
  for (let index = 0; index < 5; index++)
    await page.keyboard.press('Shift+ArrowLeft')
  await page.evaluate(() => {
    document.querySelector(
      'style[data-addon-style="markdown.alerts"]',
    ).dataset.stale = ''
  })
  await sendReload(app, 'markdown')
  await page
    .locator('style[data-addon-style="markdown.alerts"]:not([data-stale])')
    .waitFor({ state: 'attached' })
  await t.test('reload retains chosen text and document focus', async () => {
    await page
      .waitForFunction(
        () =>
          getSelection().toString() === 'ad me' &&
          document.activeElement?.matches(
            '.rich-pane :is(.ProseMirror, .cm-content)[contenteditable="true"]',
          ),
      )
      .catch(async (error) => {
        await reportSelection(t, editor)
        throw error
      })
  })
  assert.match(await editor.innerText(), /Hello world, reload me/)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).dirty,
    true,
  )
})

test('editing stays read-only while an editor extension reloads and keeps a selection moved meanwhile', {
  timeout: 60000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-addon-reload-readonly-'))
  const profile = join(temp, 'profile')
  await writeInstalled(
    profile,
    manifest('slow-consumer', 'Slow consumer', {
      startup: 'background',
      requires: { addons: [{ id: 'frontmatter' }] },
      capabilities: undefined,
    }),
    {
      // The restarted consumer adds a syntax flavor, so the editor rebuilds after the user's choice
      // with a widget that renders text before it. The formatted view refuses the legacy SDK, so
      // there the flavor arrives without the widget.
      'index.js': `export default (sdk) => ({
        async start(context) {
          window.consumerStarts = (window.consumerStarts || 0) + 1;
          if (window.holdConsumer) {
            window.holdConsumer = false;
            await new Promise((resolve) => { window.releaseConsumer = resolve; });
            const richExtensions = [];
            try {
              const { tiptap } = sdk;
              richExtensions.push(tiptap.Extension.create({
                name: 'lateWidget',
                addDecorations: () => ({
                  create: () => [tiptap.Decoration.Widget(0, () => {
                    const element = document.createElement('div');
                    element.textContent = 'Rendered widget text ';
                    return element;
                  }, { key: 'late-widget' })],
                }),
              }));
            } catch {}
            context.editor.registerFlavor({ id: 'late', name: 'Late', kind: 'syntax', description: 'Rebuilds the editor', detect: () => false, richExtensions });
          }
        },
      });`,
    },
    'd',
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'slow-consumer': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  let cdp
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await cdp?.detach()
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await selectFormattedEngine(app, page, t.formattedEngine)
  if (t.formattedEngine === 'codemirror') {
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  }
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => window.consumerStarts === 1)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  await editor.click()
  await page.keyboard.type('Hello world, reload me')
  for (let index = 0; index < 5; index++)
    await page.keyboard.press('Shift+ArrowLeft')
  const markdown = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  await waitForAsync(page, async () =>
    /reload me/.test((await window.hibi.getDocument()).markdown),
  )
  const before = await markdown()
  await page.evaluate(() => {
    window.holdConsumer = true
  })
  await sendReload(app, 'frontmatter')
  await page.waitForFunction(() => !!window.releaseConsumer)
  await page.waitForFunction((cm) => {
    const editor = document.querySelector(
      '[role="textbox"][aria-label="Document editor"]',
    )
    return cm
      ? editor?.isContentEditable === false
      : editor?.getAttribute('aria-readonly') === 'true'
  }, t.formattedEngine === 'codemirror')
  await t.test('reloading editor exposes aria-readonly', async () => {
    assert.equal(await editor.getAttribute('aria-readonly'), 'true')
  })
  // The user moves the selection with the mouse; typing changes nothing while the reload runs.
  await editor.getByText(/Hello world/).dblclick({ position: { x: 5, y: 5 } })
  // Windows word selection includes the trailing space.
  await page.waitForFunction(() => /^Hello\s?$/.test(getSelection().toString()))
  const moved = await page.evaluate(() => getSelection().toString())
  await page.keyboard.type('xyz')
  assert.equal(await markdown(), before)
  await page.evaluate(() => {
    document.querySelector(
      '.rich-pane :is(.ProseMirror, .cm-content)',
    ).dataset.chosenIn = ''
    window.releaseConsumer()
  })
  await page.waitForFunction((cm) => {
    const editor = document.querySelector(
      '[role="textbox"][aria-label="Document editor"]',
    )
    return cm
      ? editor?.isContentEditable === true
      : editor?.getAttribute('aria-readonly') === 'false'
  }, t.formattedEngine === 'codemirror')
  await t.test('unlocked editor exposes aria-readonly', async () => {
    assert.equal(await editor.getAttribute('aria-readonly'), 'false')
  })
  if (t.formattedEngine === 'codemirror') {
    // The selection, read-only gate and subsequent native input are checked on both engines below.
    assert.equal(
      await page.locator('.rich-pane .cm-content[data-chosen-in]').count(),
      1,
    )
    assert.equal(await editor.getByText('Rendered widget text').count(), 0)
  } else {
    assert.equal(
      await page.locator('.ProseMirror[data-chosen-in]').count(),
      0,
      'the editor rebuilt after the selection was chosen',
    )
    await editor.getByText('Rendered widget text').waitFor()
  }
  await t.test(
    'reload keeps the selection moved while input was read-only',
    async () => {
      await page
        .waitForFunction((moved) => getSelection().toString() === moved, moved)
        .catch(async (error) => {
          await reportSelection(t, editor)
          throw error
        })
    },
  )
  assert.equal(await markdown(), before)
  await t.test(
    'typing resumes at the retained selection after reload',
    async () => {
      await page.keyboard.press('End')
      await page.keyboard.type('!')
      await waitForAsync(page, async () =>
        (await window.hibi.getDocument()).markdown.includes('reload me!'),
      )
    },
  )
})
