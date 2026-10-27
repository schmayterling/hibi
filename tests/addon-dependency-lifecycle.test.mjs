import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('required addons confirm together, share versioned exports, and leave consumers blocked when disabled', {
  timeout: 45000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-addon-dependencies-'))
  const profile = join(temp, 'profile')
  const fixtures = [
    {
      id: 'fixture-provider',
      name: 'Provider',
      activation: 'command',
      commands: [{ id: 'probe', label: 'Provider probe' }],
      source: `export default () => ({
        async start(context) {
          window.providerStarts = (window.providerStarts || 0) + 1;
          const generation = window.providerStarts;
          window.provideDependency = version => context.exports.provide({
            version,
            greet: name => name + ' from provider ' + generation
          });
          window.removeDependencyExport = window.provideDependency(1);
          context.commands.register({id:'probe',label:'Provider probe',run() {}});
          if (generation === 1)
            await new Promise(resolve => { window.releaseDependencyProviderStart = resolve; });
        },
        stop() { window.providerStops = (window.providerStops || 0) + 1; }
      });`,
    },
    {
      id: 'fixture-dependent',
      name: 'Dependent',
      startup: 'background',
      requires: { addons: [{ id: 'fixture-provider' }] },
      source: `export default () => ({
        async start(context) {
          window.dependentStarts = (window.dependentStarts || 0) + 1;
          const api = await context.addons.ready('fixture-provider');
          window.dependencyConsumed = {
            version: api.version,
            greeting: api.greet('Dependent'),
            same: context.addons.get('fixture-provider') === api
          };
          window.readDependency = () => {
            const current = context.addons.get('fixture-provider');
            return current ? {version:current.version,greeting:current.greet('Dependent')} : null;
          };
          window.awaitDependency = async () => {
            const current = await context.addons.ready('fixture-provider');
            return current ? {version:current.version,greeting:current.greet('Dependent')} : null;
          };
          try { context.addons.get('markdown'); }
          catch { window.undeclaredGetRejected = true; }
          try { await context.addons.ready('markdown'); }
          catch { window.undeclaredReadyRejected = true; }
          context.styles.register('active', ':root { --dependency-consumer: active; }');
          context.commands.register({id:'greet',label:'Dependent greeting',run() {
            window.dependencyGreeting = api.greet('Command');
          }});
        },
        stop() { window.dependentStops = (window.dependentStops || 0) + 1; }
      });`,
    },
  ]
  for (const { source, ...manifest } of fixtures) {
    const folder = join(temp, manifest.id)
    await mkdir(folder)
    await writeFile(
      join(folder, 'hibi-addon.json'),
      JSON.stringify({
        ...manifest,
        description: 'Addon dependency lifecycle fixture',
        kind: 'extension',
        apiVersion: 2,
        version: '1.0.0',
        authors: [{ displayName: 'Test' }],
        entry: 'index.js',
        capabilities: [],
      }),
    )
    await writeFile(join(folder, 'index.js'), source)
    await writeFile(join(folder, 'README.md'), `# ${manifest.name}\n`)
  }
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
  await app.evaluate(({ dialog }) => {
    globalThis.packageReviews = []
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.packageSource],
    })
    dialog.showMessageBox = async (_window, options) => {
      globalThis.packageReviews.push(options.message)
      return { response: 1 }
    }
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    window.hibi.setAddonTrustSettings({
      allowUnsigned: true,
      checkRevocations: false,
    }),
  )
  for (const { id } of fixtures) {
    await app.evaluate(
      (_electron, source) => {
        globalThis.packageSource = source
      },
      join(temp, id),
    )
    await page.evaluate(() => window.hibi.installAddon())
  }
  assert.deepEqual(await app.evaluate(() => globalThis.packageReviews), [
    'Install Provider 1.0.0?',
    'Install Dependent 1.0.0?',
  ])
  await page.reload()
  await waitForDocumentEditor(app, page)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  const provider = page.locator('#addon-fixture-provider')
  const dependent = page.locator('#addon-fixture-dependent')
  await dependent.waitFor()
  assert.equal(await provider.isChecked(), false)
  assert.equal(await dependent.isChecked(), false)
  assert.equal(await page.evaluate(() => window.providerStarts), undefined)

  const enable = page.getByRole('dialog', {
    name: /^enable required addons$/i,
  })
  await dependent.click()
  await enable.waitFor()
  assert.equal(await page.getByRole('dialog').count(), 1)
  assert.match(await enable.innerText(), /Provider/)
  await enable.getByRole('button', { name: /^enable all$/i }).waitFor()
  await enable.getByRole('button', { name: /^cancel$/i }).click()
  await enable.waitFor({ state: 'hidden' })
  assert.equal(await provider.isChecked(), false)
  assert.equal(await dependent.isChecked(), false)
  assert.equal(await page.evaluate(() => window.providerStarts), undefined)
  assert.equal(await page.evaluate(() => window.dependentStarts), undefined)
  assert.equal(
    (await page.evaluate(() => window.hibi.getAddonStates())).find(
      ({ id }) => id === 'fixture-provider',
    ).enabled,
    false,
  )

  await dependent.click()
  await enable.getByRole('button', { name: /^enable all$/i }).click()
  await enable.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => !!window.releaseDependencyProviderStart)
  assert.equal(await page.evaluate(() => window.dependentStarts), undefined)
  await page.evaluate(() => window.releaseDependencyProviderStart())
  await page.waitForFunction(() => window.dependentStarts === 1)
  const contribution = page.locator(
    'style[data-addon-style="fixture-dependent.active"]',
  )
  await contribution.waitFor({ state: 'attached' })
  assert.equal(await provider.isChecked(), true)
  assert.equal(await dependent.isChecked(), true)
  assert.deepEqual(await page.evaluate(() => window.dependencyConsumed), {
    version: 1,
    greeting: 'Dependent from provider 1',
    same: true,
  })
  assert.equal(await page.evaluate(() => window.providerStarts), 1)
  assert.equal(await page.evaluate(() => window.undeclaredGetRejected), true)
  assert.equal(await page.evaluate(() => window.undeclaredReadyRejected), true)

  await page.evaluate(() => window.removeDependencyExport())
  assert.equal(await page.evaluate(() => window.readDependency()), null)
  assert.equal(await page.evaluate(() => window.awaitDependency()), null)
  await page.evaluate(() => {
    const oldRemove = window.provideDependency(1)
    window.removeDependencyExport = window.provideDependency(2)
    oldRemove()
  })
  assert.deepEqual(await page.evaluate(() => window.awaitDependency()), {
    version: 2,
    greeting: 'Dependent from provider 1',
  })

  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Dependent greeting')
  await page.getByRole('option', { name: /Dependent greeting/i }).click()
  await page.waitForFunction(
    () => window.dependencyGreeting === 'Command from provider 1',
  )

  const disable = page.getByRole('dialog', { name: /^disable addon$/i })
  await provider.click()
  await disable.waitFor()
  assert.equal(await page.getByRole('dialog').count(), 1)
  assert.match(await disable.innerText(), /Dependent/)
  await disable.getByRole('button', { name: /^disable$/i }).click()
  await disable.waitFor({ state: 'hidden' })
  await page.waitForFunction(
    () => window.providerStops === 1 && window.dependentStops === 1,
  )
  await contribution.waitFor({ state: 'detached' })
  assert.equal(await provider.isChecked(), false)
  assert.equal(await dependent.isChecked(), true)
  const row = page.locator('.setting-row').filter({ has: dependent })
  await row.getByText('Requires Provider', { exact: true }).waitFor()
  const reenable = row.getByRole('button', {
    name: /^enable provider too$/i,
  })
  await reenable.waitFor()
  const saved = JSON.parse(await readFile(join(profile, 'addons.json'), 'utf8'))
  assert.equal(saved['fixture-dependent'], true)
  assert.equal(saved['fixture-provider'], false)
  assert.equal(await page.evaluate(() => window.readDependency()), null)
  assert.equal(await page.evaluate(() => window.awaitDependency()), null)
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Dependent greeting')
  assert.equal(
    await page.getByRole('option', { name: /Dependent greeting/i }).count(),
    0,
  )
  await page.keyboard.press('Escape')

  await reenable.click()
  await enable.getByRole('button', { name: /^enable all$/i }).click()
  await enable.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => window.dependentStarts === 2)
  await contribution.waitFor({ state: 'attached' })
  assert.deepEqual(await page.evaluate(() => window.dependencyConsumed), {
    version: 1,
    greeting: 'Dependent from provider 2',
    same: true,
  })
  assert.equal(await provider.isChecked(), true)
  assert.equal(await dependent.isChecked(), true)
  assert.equal(
    await row.getByText('Requires Provider', { exact: true }).count(),
    0,
  )

  await page.reload()
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => !!window.releaseDependencyProviderStart)
  assert.equal(await page.evaluate(() => window.dependentStarts), undefined)
  await page.evaluate(() => window.releaseDependencyProviderStart())
  await waitForAsync(page, async () => {
    const states = await window.hibi.getAddonStates()
    return (
      ['fixture-provider', 'fixture-dependent'].every(
        (id) => states.find((state) => state.id === id)?.enabled,
      ) && window.dependencyConsumed?.greeting === 'Dependent from provider 1'
    )
  })
  assert.equal(await page.evaluate(() => window.providerStarts), 1)
  assert.equal(await page.evaluate(() => window.dependentStarts), 1)
})

async function writeInstalledFixture(profile, id, manifest, source) {
  const folder = join(profile, 'installed-addons', id)
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id,
      name: id,
      description: 'Addon dependency fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
      capabilities: [],
      ...manifest,
    }),
  )
  await writeFile(join(folder, 'index.js'), source)
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
}

test('a blocked feature consumer keeps rich editing and its draft through disable and reload', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(
    join(tmpdir(), 'hibi-addon-dependency-feature-'),
  )
  for (const [id, name, extra, source] of [
    [
      'fixture-provider',
      'Provider',
      {
        activation: 'command',
        commands: [{ id: 'probe', label: 'Provider probe' }],
      },
      `export default () => ({ start(context) {
        context.exports.provide({version:1,greet:()=> 'Provider ready'});
      } });`,
    ],
    [
      'fixture-dependent',
      'Dependent',
      { requires: { addons: [{ id: 'fixture-provider' }] } },
      `export default () => ({ start(context) {
        window.startupConsumerGreeting = context.addons.get('fixture-provider').greet();
        window.startupConsumerStarts = (window.startupConsumerStarts || 0) + 1;
      }, stop() { window.startupConsumerStopped = true; } });`,
    ],
  ]) {
    await writeInstalledFixture(profile, id, { name, ...extra }, source)
  }
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'fixture-provider': true, 'fixture-dependent': true }),
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
  await waitForDocumentEditor(app, page)
  assert.equal(
    await page.evaluate(() => window.startupConsumerGreeting),
    'Provider ready',
  )
  const draft = 'Keep this unsaved dependency draft'
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: 'Document editor', exact: true }),
    draft,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  await page.locator('#addon-fixture-provider').click()
  await page
    .getByRole('dialog', { name: /^disable addon$/i })
    .getByRole('button', { name: /^disable$/i })
    .click()
  await page.waitForFunction(() => window.startupConsumerStopped)
  assert.equal(await page.locator('#addon-fixture-dependent').isChecked(), true)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await waitForDocumentEditor(app, page)
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Markdown editor', exact: true })
      .count(),
    0,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    draft,
  )

  const editedDraft = `${draft} while provider is disabled`
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: 'Document editor', exact: true }),
    editedDraft,
  )
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    editedDraft,
  )

  await page.reload()
  await waitForDocumentEditor(app, page)
  assert.equal(
    await page.evaluate(() => window.startupConsumerStarts),
    undefined,
  )
  const state = (await page.evaluate(() => window.hibi.getAddonStates())).find(
    ({ id }) => id === 'fixture-dependent',
  )
  assert.equal(state.enabled, true)
  assert.deepEqual(state.blockedBy, ['fixture-provider'])
  assert.equal(
    (await page.evaluate(() => window.hibi.getInstalledAddons())).length,
    2,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    editedDraft,
  )
})

test('optional readiness settles when a pending consumer loses its required provider', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(
    join(tmpdir(), 'hibi-addon-dependency-pending-'),
  )
  for (const [id, extra, source] of [
    [
      'fixture-requester',
      {
        requires: {
          addons: [{ id: 'fixture-command-consumer', optional: true }],
        },
      },
      `export default () => ({ async start(context) {
        window.optionalReadyRequested = true;
        const api = await context.addons.ready('fixture-command-consumer');
        window.optionalReadyUnavailable = api === undefined;
        window.optionalReadySettled = true;
      } });`,
    ],
    [
      'fixture-command-consumer',
      {
        activation: 'command',
        commands: [{ id: 'probe', label: 'Consumer probe' }],
        requires: { addons: [{ id: 'fixture-provider' }] },
      },
      `export default () => ({ start(context) {
        window.pendingConsumerStarted = true;
        window.pendingConsumerVersion = context.addons.get('fixture-provider').version;
        context.exports.provide({version:1});
      } });`,
    ],
    [
      'fixture-provider',
      {
        activation: 'command',
        commands: [{ id: 'probe', label: 'Provider probe' }],
        name: 'Pending provider',
      },
      `export default () => ({ async start(context) {
        window.pendingProviderAttempts = (window.pendingProviderAttempts || 0) + 1;
        if (window.pendingProviderAttempts === 1) {
          await new Promise(resolve => { window.failPendingProvider = resolve; });
          throw new Error('Fixture dependency startup failed');
        }
        await new Promise(resolve => { window.releasePendingProviderRetry = resolve; });
        context.exports.provide({version:1});
      } });`,
    ],
  ]) {
    await writeInstalledFixture(profile, id, extra, source)
  }
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({
      'fixture-requester': true,
      'fixture-command-consumer': true,
      'fixture-provider': true,
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
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.waitForFunction(
    () => window.optionalReadyRequested && !!window.failPendingProvider,
  )
  assert.equal(
    await page.evaluate(() => window.pendingConsumerStarted),
    undefined,
  )
  assert.equal(
    await page.evaluate(() => window.optionalReadySettled),
    undefined,
  )
  await page.evaluate(() => window.failPendingProvider())
  await waitForAsync(page, () => window.optionalReadySettled)
  await waitForDocumentEditor(app, page)
  assert.equal(await page.evaluate(() => window.optionalReadySettled), true)
  assert.equal(await page.evaluate(() => window.optionalReadyUnavailable), true)
  assert.equal(
    await page.evaluate(() => window.pendingConsumerStarted),
    undefined,
  )

  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  const consumer = page.locator('#addon-fixture-command-consumer')
  const row = page.locator('.setting-row').filter({ has: consumer })
  await row
    .getByText('Could not start Pending provider', { exact: true })
    .waitFor()
  const retry = row.getByRole('button', { name: /^retry pending provider$/i })
  assert.equal(await retry.count(), 1)
  assert.equal(await consumer.isChecked(), true)
  assert.equal(await page.locator('#addon-fixture-provider').isChecked(), true)
  await retry.click()
  await page.waitForFunction(() => !!window.releasePendingProviderRetry)
  assert.equal(
    await page.evaluate(() => window.pendingConsumerStarted),
    undefined,
  )
  await page.evaluate(() => window.releasePendingProviderRetry())
  await page.waitForFunction(() => window.pendingConsumerStarted)
  assert.equal(await page.evaluate(() => window.pendingProviderAttempts), 2)
  assert.equal(await page.evaluate(() => window.pendingConsumerVersion), 1)
  await row
    .getByText('Could not start Pending provider', { exact: true })
    .waitFor({ state: 'hidden' })
  const saved = JSON.parse(await readFile(join(profile, 'addons.json'), 'utf8'))
  assert.equal(saved['fixture-provider'], true)
  assert.equal(saved['fixture-command-consumer'], true)
  assert.equal(saved['fixture-requester'], true)
})

test('a background consumer does not make its source-activated provider block rich editing', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(
    join(tmpdir(), 'hibi-addon-dependency-background-'),
  )
  await writeInstalledFixture(
    profile,
    'fixture-source-provider',
    { activation: 'source', capabilities: ['source'] },
    `export default () => ({ async start(context) {
      await new Promise(resolve => { window.releaseSourceProvider = resolve; });
      context.exports.provide({version:1,greet:()=> 'Source provider ready'});
    } });`,
  )
  await writeInstalledFixture(
    profile,
    'fixture-background-consumer',
    {
      startup: 'background',
      requires: { addons: [{ id: 'fixture-source-provider' }] },
    },
    `export default () => ({ start(context) {
      window.backgroundConsumerGreeting = context.addons.get('fixture-source-provider').greet();
      window.backgroundConsumerStarted = true;
    } });`,
  )
  await writeInstalledFixture(
    profile,
    'fixture-disabled-consumer',
    { requires: { addons: [{ id: 'fixture-source-provider' }] } },
    `export default () => ({ start() { window.disabledConsumerStarted = true; } });`,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({
      'fixture-source-provider': true,
      'fixture-background-consumer': true,
      'fixture-disabled-consumer': false,
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
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => !!window.releaseSourceProvider)
  assert.equal(
    await page.evaluate(() => window.backgroundConsumerStarted),
    undefined,
  )
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Document editor', exact: true })
      .isVisible(),
    true,
  )
  assert.equal(
    await page.evaluate(() => window.disabledConsumerStarted),
    undefined,
  )
  await page.evaluate(() => window.releaseSourceProvider())
  await page.waitForFunction(() => window.backgroundConsumerStarted)
  assert.equal(
    await page.evaluate(() => window.backgroundConsumerGreeting),
    'Source provider ready',
  )
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Document editor', exact: true })
      .isVisible(),
    true,
  )
})
