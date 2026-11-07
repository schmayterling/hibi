// throwaway probe: per-step timing of the 1 MB code indent under 20x throttle
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForFormattedEditor } from './electron.mjs'
import { waitForAsync } from './poll.mjs'

const rate = Number(process.env.PROBE_RATE ?? 20)
const profileOut = process.env.PROBE_PROFILE

test('probe 1 MB indent timing', { timeout: 600000 }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-probe-tab-'))
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
  page.setDefaultTimeout(600000)
  await waitForFormattedEditor(app, page)
  const rich = page.getByRole('textbox', { name: 'Document editor', exact: true })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const times = []
  let last = performance.now()
  const mark = (name) => {
    const now = performance.now()
    times.push([name, Math.round(now - last)])
    last = now
  }
  const set = (text, anchor, head = anchor) =>
    rich.evaluate(
      (element, { text, anchor, head }) => {
        const view = element.cmTile.root.view
        view.focus()
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor, head },
          scrollIntoView: true,
          userEvent: 'input.fixture',
        })
        return new Promise((resolve) =>
          view.requestMeasure({ read: () => null, write: resolve }),
        )
      },
      { text, anchor, head },
    )
  const saved = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
      { timeout: 600000 },
    )
  const lines = 16384
  const big = Array.from({ length: lines }, (_, line) =>
    `${line}`.padEnd(63, 'x'),
  ).join('\n')
  const text = `\`\`\`\n${big}\n\`\`\``
  await page.evaluate(() => {
    const held = []
    const request = window.requestIdleCallback
    window.requestIdleCallback = (callback) => {
      held.push(callback)
      return 0
    }
    window.releaseIdle = () => {
      window.requestIdleCallback = request
      for (const callback of held) request(callback)
    }
  })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate })
  mark('start')
  await set(text, 4, big.length + 4)
  mark('set')
  if (profileOut) {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.start')
  }
  await page.keyboard.press('Tab')
  mark('tab')
  if (profileOut) {
    const { profile } = await cdp.send('Profiler.stop')
    await writeFile(profileOut, JSON.stringify(profile))
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  await page.evaluate(() => window.releaseIdle())
  mark('unthrottle')
  const indented = `\`\`\`\n${big
    .split('\n')
    .map((line) => '\t' + line)
    .join('\n')}\n\`\`\``
  await saved(indented)
  mark('saved-indented')
  await page.keyboard.press('ControlOrMeta+z')
  mark('undo')
  await saved(text)
  mark('saved-undo')
  t.diagnostic(`rate ${rate} ${JSON.stringify(times)}`)
})
