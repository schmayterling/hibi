import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('production diagnostics opt in, attribute measured work, retain initialization failures, and stop on disable', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-diagnostics-'))
  for (const id of ['timing-probe', 'failed-probe']) {
    const directory = join(profile, 'installed-addons', id)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'hibi-addon.json'),
      JSON.stringify({
        id,
        name: id === 'timing-probe' ? 'Timing probe' : 'Failed probe',
        description: 'Timing fixture',
        kind: 'extension',
        startup: 'background',
        apiVersion: 1,
        version: '1.0.0',
        authors: [{ displayName: 'Test' }],
        entry: 'index.js',
      }),
    )
    await writeFile(
      join(directory, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: ['index.js', 'hibi-addon.json'],
        source: 'local',
      }),
    )
    await writeFile(
      join(directory, 'index.js'),
      id === 'failed-probe'
        ? `export default () => ({ start() { throw new Error('Intentional initialization failure'); } });`
        : `export default () => ({ async start(context) {
        await new Promise(resolve => setTimeout(resolve, 30));
        context.commands.register({ id: 'work', label: 'Run timing probe', run() {
          const end = performance.now() + 80; while (performance.now() < end) {}
        }});
        context.editor.onDocumentChange(() => { const end = performance.now() + 10; while (performance.now() < end) {} });
      }});`,
    )
  }
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'timing-probe': true, 'failed-probe': true }),
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
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.hibi.getAddonStates()).find(
          (entry) => entry.id === 'diagnostics',
        ).enabled,
    ),
    false,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.queryAddon('diagnostics', 'snapshot')),
    /Enable this addon/,
  )
  await clickMenu(app, 'Settings')
  assert.equal(
    await page.getByRole('tab', { name: 'Diagnostics', exact: true }).count(),
    0,
  )
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-diagnostics').click()
  await page.getByRole('tab', { name: 'Diagnostics', exact: true }).click()
  const panel = page.locator('#settings-plugin-diagnostics')
  await panel.getByText('Recording', { exact: true }).waitFor()
  const initializations = panel.getByRole('region', {
    name: 'Addon initialization',
    exact: true,
  })
  await initializations.locator('[data-addon="timing-probe"]').waitFor()
  assert.match(
    await initializations.locator('[data-addon="failed-probe"]').innerText(),
    /Failed/,
  )
  const duration = await page.evaluate(
    () => performance.getEntriesByName('hibi:addon:timing-probe')[0].duration,
  )
  assert.ok(duration >= 30)
  const native = await page.evaluate(() =>
    window.hibi.queryAddon('diagnostics', 'snapshot'),
  )
  assert.equal(native.app.development, false)
  assert.ok(native.processes.length > 0)
  assert.ok(
    native.processes.every(
      (process) => process.memoryMiB >= 0 && Number.isFinite(process.memoryMiB),
    ),
  )
  const runProbe = async () => {
    await clickMenu(app, 'Command palette')
    await page
      .getByRole('combobox', { name: /search commands/i })
      .fill('Run timing probe')
    await page.getByRole('option', { name: /Run timing probe/i }).click()
  }
  await runProbe()
  const activity = panel.getByRole('region', {
    name: 'Measured activity',
    exact: true,
  })
  const commandRow = activity
    .getByRole('row')
    .filter({ hasText: 'command:work' })
  await commandRow.waitFor()
  assert.equal(await commandRow.locator('td').first().textContent(), '1')
  assert.ok(
    Number.parseFloat(
      await commandRow.locator('[data-slow="true"]').textContent(),
    ) >= 80,
  )
  await panel
    .getByRole('region', { name: 'Recent stalls', exact: true })
    .getByText(/timing-probe: command:work/)
    .first()
    .waitFor()
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/diagnostics.png',
    animations: 'disabled',
  })
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-diagnostics').click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-diagnostics').checked,
  )
  assert.equal(
    await page.getByRole('tab', { name: 'Diagnostics', exact: true }).count(),
    0,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.queryAddon('diagnostics', 'snapshot')),
    /Enable this addon/,
  )
  await runProbe()
  await page.locator('#addon-diagnostics').click()
  await page.getByRole('tab', { name: 'Diagnostics', exact: true }).click()
  await panel.getByText('Recording', { exact: true }).waitFor()
  assert.equal(await commandRow.locator('td').first().textContent(), '1')
  await panel
    .getByRole('button', { name: 'Clear runtime samples', exact: true })
    .click()
  await panel.getByText('No activity recorded', { exact: true }).waitFor()
  assert.ok(await initializations.locator('[data-addon]').count())
  await page.reload()
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.hibi.getAddonStates()).find(
          (entry) => entry.id === 'diagnostics',
        ).enabled,
    ),
    true,
  )
})
