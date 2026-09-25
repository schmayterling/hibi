import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { validateAnalysisProjection } from '../src/shared/analysis.ts'
import { electron, waitForElectronExit } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('electron cleanup trusts clean process exit but reports close and crash failures', async () => {
  const child = () => {
    const process = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      drained: 0,
    })
    process.stdout = { destroy: () => process.drained++ }
    process.stderr = { destroy: () => process.drained++ }
    return process
  }
  const clean = child()
  const closed = waitForElectronExit(clean, new Promise(() => {}))
  clean.exitCode = 0
  clean.emit('exit', 0, null)
  await closed
  assert.equal(clean.drained, 2)

  const live = child()
  let done = false
  const waiting = waitForElectronExit(live, Promise.resolve()).then(() => {
    done = true
  })
  await Promise.resolve()
  assert.equal(done, false)
  live.exitCode = 0
  live.emit('exit', 0, null)
  await waiting

  const late = child()
  let rejectClose
  const lateClose = waitForElectronExit(
    late,
    new Promise((_, reject) => {
      rejectClose = reject
    }),
  )
  late.exitCode = 0
  late.emit('exit', 0, null)
  rejectClose(new Error('close failed after exit'))
  await assert.rejects(lateClose, /close failed after exit/)

  const early = child()
  await assert.rejects(
    waitForElectronExit(early, Promise.reject(new Error('close failed'))),
    /close failed/,
  )
  assert.equal(early.listenerCount('exit'), 0)
  const crashed = child()
  const failed = waitForElectronExit(crashed, new Promise(() => {}))
  crashed.signalCode = 'SIGKILL'
  crashed.emit('exit', null, 'SIGKILL')
  await assert.rejects(failed, /signal SIGKILL/)
  assert.equal(crashed.drained, 2)
})

test('electron cleanup drains transport pipes inherited by a surviving child', {
  timeout: 5000,
}, async () => {
  const parent = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:['ignore',1,2,3,4],detached:true});child.unref();`
  const child = spawn(process.execPath, ['-e', parent], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const closed = new Promise((resolve) => child.once('close', resolve))
  const shutdown = waitForElectronExit(child, new Promise(() => {}))
  await exited
  await shutdown
  assert.ok(child.stdio.slice(1).every((stream) => stream.destroyed))
  await closed
})

test('analysis grants contain only exact ranges from the active source', () => {
  const document = {
    tabId: 'a',
    revision: 1,
    contentVersion: 2,
    markdown: '😀\r\nprivate text',
  }
  const projection = {
    id: 'p',
    tabId: 'a',
    revision: 1,
    contentVersion: 2,
    text: 'private text',
    spans: [{ from: 0, to: 12, sourceFrom: 4, sourceTo: 16 }],
    extra: 'never forwarded',
  }
  assert.equal(
    validateAnalysisProjection(projection, document).extra,
    undefined,
  )
  for (const changed of [
    { tabId: 'b' },
    { revision: 0 },
    { contentVersion: 3 },
    { text: 'another file' },
    { spans: [{ from: 0, to: 12, sourceFrom: 2, sourceTo: 14 }] },
    { spans: [] },
  ])
    assert.throws(() =>
      validateAnalysisProjection({ ...projection, ...changed }, document),
    )
})

test('analysis is process-isolated, bounded, connection-bound, and revoked on cancel, disable, and reload', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-analysis-'))
  const analysis = `export async function analyze(projection) {
    const text = projection.text;
    if (text.includes('spin')) { while (true) {} }
    if (text.includes('large')) return 'x'.repeat(300000);
    if (text.includes('delay')) await new Promise(resolve => setTimeout(resolve, 650));
    if (text.includes('probe')) {
      const attempts = await Promise.all(['https://example.com/', 'file:///etc/passwd', 'app://hibi/index.html', '/private.txt'].map(async url => {try {await fetch(url); return false} catch {return true}}));
      let moduleDenied = false;
      try {await import('app://hibi/index.html')} catch {moduleDenied = true}
      self.postMessage({id:'another-addons-request',value:'forged'});
      return {mainBridge: typeof hibi, analysisBridge: typeof analysisHost, dom: typeof document, window: typeof window,
        node: typeof require, process: typeof process, rtc: typeof RTCPeerConnection, attempts, moduleDenied,
        fields:Object.keys(projection).sort()};
    }
    return text;
  }`
  for (const id of ['probe-addon', 'other-addon']) {
    const folder = join(profile, 'installed-addons', id)
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'hibi-addon.json'),
      JSON.stringify({
        id,
        name: id,
        kind: 'extension',
        description: 'Analysis fixture',
        apiVersion: 2,
        version: '1.0.0',
        authors: [{ displayName: 'Test' }],
        capabilities: [],
        entry: 'index.js',
        analysis: { entry: 'analysis.js' },
      }),
    )
    await writeFile(
      join(folder, '.hibi-install.json'),
      JSON.stringify({
        hash: 'b'.repeat(64),
        files: ['index.js', 'analysis.js', 'hibi-addon.json'],
        source: 'local',
      }),
    )
    await writeFile(
      join(folder, 'index.js'),
      `export default () => ({start(context) {window.analysisFixtures ??= {}; window.analysisFixtures['${id}'] = context;}})`,
    )
    await writeFile(
      join(folder, 'analysis.js'),
      id === 'probe-addon'
        ? analysis
        : `export async function analyze() {await new Promise(resolve=>setTimeout(resolve,250));return 'other addon';}`,
    )
  }
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'probe-addon': true, 'other-addon': true }),
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
  page.setDefaultTimeout(6000)
  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await editor.fill('probe')
  await page.waitForFunction(() => window.analysisFixtures?.['other-addon'])
  const probe = await page.evaluate(async () => {
    const first = window.analysisFixtures['probe-addon']
    const other = window.analysisFixtures['other-addon']
    return Promise.all([
      first.analysis.run(first.editor.getTextProjection()),
      other.analysis.run(other.editor.getTextProjection()),
    ])
  })
  assert.equal(probe[0].status, 'complete')
  for (const name of [
    'mainBridge',
    'analysisBridge',
    'dom',
    'window',
    'node',
    'process',
    'rtc',
  ])
    assert.equal(probe[0].value[name], 'undefined')
  assert.deepEqual(probe[0].value.attempts, [true, true, true, true])
  assert.equal(probe[0].value.moduleDenied, true)
  assert.deepEqual(probe[0].value.fields, [
    'contentVersion',
    'id',
    'revision',
    'spans',
    'tabId',
    'text',
  ])
  assert.equal(probe[1].value, 'other addon')
  const processes = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      url: window.webContents.getURL(),
      pid: window.webContents.getOSProcessId(),
      sandbox: window.webContents.getLastWebPreferences().sandbox,
    })),
  )
  assert.equal(new Set(processes.map((item) => item.pid)).size, 3)
  assert.ok(processes.every((item) => item.sandbox))
  await page.evaluate(() => window.hibi.cancelAnalysis('other-addon'))
  const run = () =>
    page.evaluate(() => {
      const context = window.analysisFixtures['probe-addon']
      return context.analysis.run(context.editor.getTextProjection())
    })
  await editor.fill('large')
  assert.equal((await run()).status, 'failed')
  await editor.fill('delay')
  const queued = await page.evaluate(async () => {
    const c = window.analysisFixtures['probe-addon'],
      p = c.editor.getTextProjection()
    return Promise.all([
      c.analysis.run(p),
      c.analysis.run(p),
      c.analysis.run(p),
    ])
  })
  assert.deepEqual(
    queued.map((result) => result.status),
    ['complete', 'cancelled', 'complete'],
  )
  await page.evaluate(() => {
    const c = window.analysisFixtures['probe-addon']
    window.analysisPending = c.analysis.run(c.editor.getTextProjection())
  })
  await clickMenu(app, 'New')
  await editor.fill('another document')
  assert.equal(
    (await page.evaluate(() => window.analysisPending)).status,
    'stale',
  )
  await editor.fill('spin')
  await page.evaluate(() => {
    const c = window.analysisFixtures['probe-addon']
    window.analysisPending = c.analysis.run(c.editor.getTextProjection())
  })
  const typedAt = Date.now()
  await editor.fill('typing stays responsive')
  assert.ok(Date.now() - typedAt < 1500)
  const timedOut = await page.evaluate(() => window.analysisPending)
  assert.equal(timedOut.status, 'failed')
  assert.match(timedOut.message, /too long/)
  await editor.fill('probe again')
  assert.equal((await run()).status, 'complete')
  await editor.fill('delay crash')
  await page.evaluate(() => {
    const c = window.analysisFixtures['probe-addon']
    window.analysisPending = c.analysis.run(c.editor.getTextProjection())
  })
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith('hibi-analysis:'),
    ).webContents
    // Linux's crash handler can outlive Electron and keep Playwright's pipes open.
    if (process.platform === 'linux') {
      const pid = contents.getOSProcessId()
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error('Analyzer renderer has no process to stop.')
      process.kill(pid, 'SIGKILL')
    } else contents.forcefullyCrashRenderer()
  })
  assert.equal(
    (await page.evaluate(() => window.analysisPending)).status,
    'failed',
  )
  await editor.fill('probe after crash')
  assert.equal((await run()).status, 'complete')
  await editor.fill('delay cancel')
  await page.evaluate(() => {
    const c = window.analysisFixtures['probe-addon']
    window.analysisPending = c.analysis.run(c.editor.getTextProjection())
    c.analysis.cancel()
  })
  assert.equal(
    (await page.evaluate(() => window.analysisPending)).status,
    'cancelled',
  )
  await editor.fill('delay disable')
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.evaluate(() => {
    const c = window.analysisFixtures['probe-addon']
    window.analysisPending = c.analysis.run(c.editor.getTextProjection())
  })
  await page.locator('#addon-probe-addon').click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-probe-addon').checked,
  )
  assert.equal(
    (await page.evaluate(() => window.analysisPending)).status,
    'cancelled',
  )
  assert.equal((await run()).status, 'cancelled')
  await page.evaluate(() => {
    window.stoppedAnalyzer = window.analysisFixtures['probe-addon']
  })
  await page.locator('#addon-probe-addon').click()
  await page.waitForFunction(
    () =>
      document.querySelector('#addon-probe-addon').checked &&
      window.analysisFixtures['probe-addon'] !== window.stoppedAnalyzer,
  )
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await editor.fill('probe restored')
  assert.equal((await run()).status, 'complete')
  await editor.fill('delay after re-enable')
  await page.evaluate(() => {
    const c = window.analysisFixtures['probe-addon']
    window.analysisPending = c.analysis.run(c.editor.getTextProjection())
    window.stoppedAnalyzer.analysis.cancel()
  })
  assert.equal(
    (await page.evaluate(() => window.analysisPending)).status,
    'complete',
  )
  await page.reload()
  await page.locator('.tiptap[contenteditable="true"]').waitFor()
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  const remaining = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((window) =>
        window.webContents.getURL().startsWith('hibi-analysis:'),
      ).length,
  )
  assert.equal(remaining, 0)
})
