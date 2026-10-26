import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('capability SDKs defer irrelevant entries, activate command descriptors, and gate source attachments', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-activation-'))
  const fixtures = [
    {
      id: 'deferred-command',
      capabilities: [],
      activation: 'command',
      commands: [{ id: 'hello', label: 'Deferred hello' }],
      code: `window.commandEvaluations = (window.commandEvaluations || 0) + 1; export default sdk => ({ start(context) { window.commandSdkKeys = Object.keys(sdk); context.commands.register({ id: 'hello', label: 'Deferred hello', run() { window.helloRuns = (window.helloRuns || 0) + 1; } }); } });`,
    },
    {
      id: 'source-mode',
      capabilities: ['source'],
      activation: 'source',
      code: `window.sourceEvaluations = (window.sourceEvaluations || 0) + 1; export default sdk => ({ start(context) { window.sourceStarts = (window.sourceStarts || 0) + 1; context.editor.registerSource({ id: 'delayed', async create() { await new Promise(resolve => setTimeout(resolve, 80)); window.sourceCreates = (window.sourceCreates || 0) + 1; return sdk.codeMirror.view.EditorView.domEventHandlers({ keydown(event) { if (event.key === 'F8') { window.sourceKeyHandled = true; return true; } } }); } }); }, stop() { window.sourceStops = (window.sourceStops || 0) + 1; } });`,
    },
    ...['zeta', 'alpha'].map((id, i) => ({
      id,
      capabilities: ['rich'],
      code: `export default () => ({ async start(context) { context.editor.registerMarkdown({ id: 'identity', parse(source) { return { content: source, sourceOffset: 0, serialize: body => body }; } }); await new Promise(resolve => setTimeout(resolve, ${i ? 30 : 110})); context.editor.registerRich({ id: 'observe', attach() { window.richAttachments ??= []; window.richAttachments.push('${id}'); return () => { window.richDetachments ??= []; window.richDetachments.push('${id}'); }; } }); } });`,
    })),
    {
      id: 'failed-stage',
      capabilities: [],
      startup: 'background',
      code: `export default () => ({ start(context) { window.failedStageStarts = (window.failedStageStarts || 0) + 1; context.styles.register('probe', 'body { --failed-addon: leaked; }'); context.commands.register({ id: 'ghost', label: 'Failed ghost', run() {} }); context.editor.registerCodeLanguage({ id: 'unsafe', label: 'Unsafe', load() { throw new Error('must not publish'); } }); throw new Error('Expected staged failure'); } });`,
    },
    {
      id: 'disabled-background',
      capabilities: [],
      startup: 'background',
      code: `window.disabledBackgroundEvaluations = (window.disabledBackgroundEvaluations || 0) + 1; export default () => ({ start() { window.disabledBackgroundStarts = (window.disabledBackgroundStarts || 0) + 1; } });`,
    },
  ]
  await writeFixtures(profile, fixtures)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify(
      Object.fromEntries(
        fixtures.map(({ id }) => [id, id !== 'disabled-background']),
      ),
    ),
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
  const rich = await selectFormattedEngine(app, page, t.formattedEngine)
  const assetHeaders = await page.evaluate(async () => {
    const addon = (await window.hibi.getInstalledAddons()).find(
      (entry) => entry.manifest.id === 'deferred-command',
    )
    const response = await fetch(addon.url)
    return {
      status: response.status,
      type: response.headers.get('Content-Type'),
      origin: response.headers.get('Access-Control-Allow-Origin'),
      noSniff: response.headers.get('X-Content-Type-Options'),
    }
  })
  assert.equal(assetHeaders.status, 200)
  assert.match(assetHeaders.type, /^text\/javascript/)
  assert.equal(assetHeaders.origin, 'app://hibi')
  assert.equal(assetHeaders.noSniff, 'nosniff')
  page.setDefaultTimeout(8000)
  // API 2 RichExtension attachment order is a Tiptap implementation contract.
  if (t.formattedEngine === 'tiptap')
    assert.deepEqual(await page.evaluate(() => window.richAttachments), [
      'alpha',
      'zeta',
    ])
  else {
    assert.equal(await page.evaluate(() => window.richAttachments), undefined)
    await rich.press('ControlOrMeta+a')
    await page.keyboard.insertText('formatted activation draft')
    await waitForAsync(
      page,
      async () =>
        (await window.hibi.getDocument()).markdown ===
        'formatted activation draft',
    )
  }
  assert.equal(await page.evaluate(() => window.commandEvaluations), undefined)
  assert.equal(await page.evaluate(() => window.sourceEvaluations), undefined)
  assert.equal(
    await page.evaluate(() => window.disabledBackgroundEvaluations),
    undefined,
  )
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.hibi.getAddonStates()).find(
          ({ id }) => id === 'disabled-background',
        )?.enabled,
    ),
    false,
  )
  await page
    .getByRole('region', { name: 'Notifications', exact: true })
    .locator('.toast[data-variant="error"]:not([data-closing="true"])')
    .getByRole('alert')
    .getByText('Expected staged failure', { exact: true })
    .waitFor()
  assert.equal(await page.evaluate(() => window.failedStageStarts), 1)
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue('--failed-addon').trim(),
    ),
    '',
  )
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const session = await page.context().newCDPSession(page)
  const files = new Set()
  session.on('Debugger.scriptParsed', ({ url }) => {
    if (url.startsWith('app://hibi/')) files.add(new URL(url).pathname.slice(1))
  })
  await session.send('Debugger.enable')
  const disabledScript =
    /^installed-addons\/disabled-background\/[^/]+\/index\.js$/
  assert.equal(
    [...files].some((file) => disabledScript.test(file)),
    false,
  )
  const loaded = () =>
    chunks
      .filter((chunk) => files.has(chunk.file))
      .flatMap((chunk) => chunk.modules)
      .join('\n')
  // The opt-in formatted engine loads CodeMirror; default Tiptap startup must not.
  if (t.formattedEngine === 'tiptap')
    assert.doesNotMatch(loaded(), /@codemirror\//)
  else assert.match(loaded(), /@codemirror\//)
  await clickMenu(app, 'Command palette')
  const search = page.getByRole('combobox', { name: /search commands/i })
  await search.fill('Deferred hello')
  await page.evaluate(() => {
    const original = window.requestAnimationFrame
    const pending = []
    let suspended = true
    window.requestAnimationFrame = (callback) => {
      if (!suspended) return original(callback)
      pending.push(callback)
      return pending.length
    }
    window.resumePaletteTestFrames = () => {
      suspended = false
      window.requestAnimationFrame = original
      for (const callback of pending) original(callback)
    }
  })
  try {
    await page.getByRole('option', { name: /Deferred hello/i }).press('Enter')
    await page.waitForFunction(() => window.helloRuns === 1, undefined, {
      polling: 100,
    })
  } finally {
    await page.evaluate(() => {
      window.resumePaletteTestFrames()
      delete window.resumePaletteTestFrames
    })
  }
  assert.deepEqual(await page.evaluate(() => window.commandSdkKeys), [
    'documents',
  ])
  assert.doesNotMatch(loaded(), /src\/addons\/sdk\.ts/)
  if (t.formattedEngine === 'tiptap')
    assert.doesNotMatch(loaded(), /src\/addons\/sdk\.ts|@codemirror\//)
  else assert.match(loaded(), /@codemirror\//)
  await page.evaluate(() => {
    const load = document.fonts.load.bind(document.fonts)
    const pending = []
    document.fonts.load = (font, text) =>
      font.includes('Geist Mono')
        ? new Promise((resolve, reject) => {
            pending.push(() => load(font, text).then(resolve, reject))
            window.sourceFontsHeld = pending.length
          })
        : load(font, text)
    window.releaseSourceFonts = () => {
      document.fonts.load = load
      for (const release of pending) release()
    }
  })
  await page
    .getByRole('button', { name: 'Source view', exact: true })
    .press('Enter')
  // Source input can be editable before the font-gated pane switch finishes.
  await page.waitForFunction(
    () =>
      document.querySelector('.source-pane .cm-content')?.isContentEditable &&
      window.sourceFontsHeld > 0,
    undefined,
    { polling: 100 },
  )
  assert.equal(await page.evaluate(() => window.sourceCreates), 1)
  assert.match(
    await page.locator('.editor-panes').getAttribute('class'),
    /mode-normal/,
  )
  assert.equal(
    await page.locator('.source-pane').evaluate((pane) => pane.inert),
    true,
  )
  assert.equal(await page.evaluate(() => window.richDetachments), undefined)
  await page.evaluate(() => window.releaseSourceFonts())
  await page.waitForFunction(
    (engine) =>
      document.querySelector('.editor-panes.mode-markdown') &&
      (engine === 'codemirror' ||
        window.richDetachments?.join(',') === 'alpha,zeta'),
    t.formattedEngine,
    { polling: 100 },
  )
  assert.equal(
    await page.locator('.source-pane').evaluate((pane) => pane.inert),
    false,
  )
  if (t.formattedEngine === 'tiptap')
    assert.deepEqual(await page.evaluate(() => window.richDetachments), [
      'alpha',
      'zeta',
    ])
  else
    assert.equal(await page.evaluate(() => window.richDetachments), undefined)
  await page.locator('.source-pane .cm-content').press('F8')
  assert.equal(await page.evaluate(() => window.sourceKeyHandled), true)
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await page.waitForFunction(() => window.sourceStops === 1)
  assert.equal(await page.evaluate(() => window.sourceEvaluations), 1)
  if (t.formattedEngine === 'tiptap')
    assert.deepEqual(await page.evaluate(() => window.richAttachments), [
      'alpha',
      'zeta',
      'alpha',
      'zeta',
    ])
  else {
    await rich.waitFor()
    assert.equal(await rich.getAttribute('contenteditable'), 'true')
    assert.equal(
      await page.evaluate(
        async () => (await window.hibi.getDocument()).markdown,
      ),
      'formatted activation draft',
    )
    assert.equal(await page.evaluate(() => window.richAttachments), undefined)
  }
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-disabled-background').click()
  await page.waitForFunction(() => window.disabledBackgroundStarts === 1)
  assert.equal(
    await page.evaluate(() => window.disabledBackgroundEvaluations),
    1,
  )
  assert.equal(
    [...files].some((file) => disabledScript.test(file)),
    true,
  )
})

test('a cancelled stale attempt keeps a committed failure from starting the addon again', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-activation-stale-'))
  await writeFixtures(profile, [
    {
      id: 'stale-failure',
      capabilities: [],
      startup: 'background',
      // Fails after the commit that shows the peer's status item but before that commit's effects run.
      code: `export default () => ({ async start() { window.staleFailureStarts = (window.staleFailureStarts || 0) + 1; if (window.staleFailureStarts > 1) throw new Error('Repeated stale failure'); await new Promise(resolve => { const observer = new MutationObserver(() => { if (document.querySelector('.app-statusbar')?.textContent.includes('Stale peer ready')) { observer.disconnect(); resolve(); } }); observer.observe(document.body, { childList: true, subtree: true, characterData: true }); window.staleFailureArmed = true; }); throw new Error('Held stale failure'); } });`,
    },
    {
      id: 'stale-peer',
      capabilities: [],
      startup: 'background',
      code: `export default () => ({ async start(context) { await new Promise(resolve => { window.releaseStalePeer = resolve; }); context.statusBar.register({ id: 'ready', label: 'Stale peer ready' }); } });`,
    },
  ])
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'stale-failure': true, 'stale-peer': true }),
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
  await selectFormattedEngine(app, page, t.formattedEngine)
  page.setDefaultTimeout(8000)
  await page.waitForFunction(
    () => window.staleFailureArmed && window.releaseStalePeer,
    undefined,
    { polling: 100 },
  )
  // Hold background starts: the stale attempt is cancelled before it can run, and any restart waits for release.
  await page.evaluate(() => {
    const request = window.requestIdleCallback
    const held = []
    window.requestIdleCallback = (callback, options) =>
      options?.timeout === 1000
        ? held.push(callback)
        : request(callback, options)
    window.releaseBackgroundStarts = async () => {
      // Idle time comes only after queued renders and their effects.
      await new Promise((resolve) => request(resolve))
      window.requestIdleCallback = request
      for (const callback of held)
        callback({ didTimeout: false, timeRemaining: () => 20 })
      await new Promise((resolve) => request(resolve))
      return held.length
    }
    window.releaseStalePeer()
  })
  await page
    .getByRole('region', { name: 'Notifications', exact: true })
    .locator('.toast[data-variant="error"]:not([data-closing="true"])')
    .getByRole('alert')
    .getByText('Held stale failure', { exact: true })
    .waitFor()
  assert.ok((await page.evaluate(() => window.releaseBackgroundStarts())) >= 1)
  assert.equal(await page.evaluate(() => window.staleFailureStarts), 1)
  // Turning it off and on is an explicit retry and still clears the failure.
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const toggle = page.locator('#addon-stale-failure')
  await toggle.click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-stale-failure').checked,
  )
  await toggle.click()
  await page.waitForFunction(() => window.staleFailureStarts === 2)
})

async function writeFixtures(profile, fixtures) {
  for (const { code, ...manifest } of fixtures) {
    const folder = join(profile, 'installed-addons', manifest.id)
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'hibi-addon.json'),
      JSON.stringify({
        ...manifest,
        name: manifest.id,
        description: 'Activation fixture',
        kind: 'extension',
        apiVersion: 2,
        version: '1.0.0',
        authors: [{ displayName: 'Test' }],
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
}
