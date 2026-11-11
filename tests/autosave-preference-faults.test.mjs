import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  stopElectronTree,
  waitForAsync,
  waitForFormattedEditor,
} from './electron.mjs'

async function profile(t) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-setting-fault-'))
  const running = new Set()
  t.after(async () => {
    for (const app of running) {
      await app
        .evaluate(() => globalThis.autosavePreferenceFault.release())
        .catch(() => {})
      await app.close()
    }
    await rm(folder, { recursive: true, force: true })
  })
  const launch = async (fail = false) => {
    const app = await electron.launch({
      autosave: true,
      args: [
        '-r',
        resolve('tests/fixtures/autosave-preference-fault.cjs'),
        resolve('.'),
        `--user-data-dir=${folder}`,
      ],
      env: { ...process.env, HIBI_TEST_AUTOSAVE_WRITE_ERROR: fail ? '1' : '' },
    })
    running.add(app)
    return { app, page: await app.firstWindow() }
  }
  const close = async (app) => {
    await app.close()
    running.delete(app)
  }
  const kill = async (app) => {
    const child = app.process()
    const gone = once(child, 'exit')
    running.delete(app)
    stopElectronTree(child)
    await gone
  }
  return { folder, launch, close, kill }
}

for (const mode of ['migration refused', 'oversized legacy']) {
  test(`${mode} starts an editor with autosave off and keeps legacy choice`, {
    timeout: 60000,
  }, async (t) => {
    const { folder, launch, close } = await profile(t)
    const legacy =
      mode === 'oversized legacy'
        ? JSON.stringify({ enabled: false, pad: 'x'.repeat(2048) })
        : '{"enabled":true,"delay":1000}'
    const first = await launch()
    await waitForFormattedEditor(first.app, first.page)
    // Seed an older build's DOMStorage; no new-format file exists yet.
    await first.page.evaluate(
      (legacy) => localStorage.setItem('hibi:autosave', legacy),
      legacy,
    )
    await close(first.app)
    const second = await launch(mode === 'migration refused')
    second.page.setDefaultTimeout(8000)
    await waitForFormattedEditor(second.app, second.page)
    assert.equal(
      await second.page.locator('[data-status-id="autosave"]').innerText(),
      'Autosave off',
    )
    assert.equal(
      await second.page.evaluate(() => localStorage.getItem('hibi:autosave')),
      legacy,
    )
    await assert.rejects(readFile(join(folder, 'autosave.json')), {
      code: 'ENOENT',
    })
    await close(second.app)
    if (mode === 'migration refused') {
      const third = await launch()
      await waitForFormattedEditor(third.app, third.page)
      assert.equal(
        JSON.parse(await readFile(join(folder, 'autosave.json'), 'utf8'))
          .enabled,
        true,
      )
    }
  })
}

test('failed autosave toggle keeps prior setting and shows an error toast', {
  timeout: 60000,
}, async (t) => {
  const { folder, launch } = await profile(t)
  await writeFile(
    join(folder, 'autosave.json'),
    JSON.stringify({ enabled: true, delay: 2000 }),
  )
  const { app, page } = await launch()
  await waitForFormattedEditor(app, page)

  await page.locator('[data-status-id="autosave"]').click()
  await app.evaluate(() => {
    globalThis.autosavePreferenceFault.mode = 'fail'
  })
  await page
    .getByRole('checkbox', { name: /^autosave$/i })
    .evaluate((input) => input.click())
  await page
    .getByRole('alert')
    .filter({ hasText: 'Could not change autosave settings.' })
    .waitFor({ timeout: 8000 })
  assert.equal(
    await page.getByRole('checkbox', { name: /^autosave$/i }).isChecked(),
    true,
  )
  assert.equal(
    JSON.parse(await readFile(join(folder, 'autosave.json'), 'utf8')).enabled,
    true,
  )
})

test('held setting write cannot reply; a kill keeps old choice and next launch removes its temp', {
  timeout: 60000,
}, async (t) => {
  const { folder, launch, kill } = await profile(t)
  await writeFile(
    join(folder, 'autosave.json'),
    JSON.stringify({ enabled: true, delay: 2000 }),
  )
  const { app, page } = await launch()
  await waitForFormattedEditor(app, page)

  await app.evaluate(() => {
    globalThis.autosavePreferenceFault.mode = 'hold'
  })
  let returned = false
  const changing = page
    .evaluate(() =>
      window.hibi.setAutosavePreferences({ enabled: false, delay: 2000 }),
    )
    .then(
      () => {
        returned = true
      },
      () => {
        returned = true
      },
    )
  await waitForAsync(app, () => globalThis.autosavePreferenceFault.held)
  // A real blocked synchronous reply remains blocked throughout this window.
  await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
  assert.equal(returned, false)
  assert.equal(
    JSON.parse(await readFile(join(folder, 'autosave.json'), 'utf8')).enabled,
    true,
  )
  await kill(app)
  await changing
  const next = await launch()
  await waitForFormattedEditor(next.app, next.page)
  assert.equal(
    await next.page.evaluate(
      () => window.hibi.getAutosavePreferences(null).enabled,
    ),
    true,
  )
  assert.deepEqual(
    (await readdir(folder)).filter(
      (name) => name.startsWith('.autosave.json.') && name.endsWith('.tmp'),
    ),
    [],
  )
})
