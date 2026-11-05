// Run by page-error-gate.test.mjs with PAGE_ERROR_CASE set; its outcome is what that test checks.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  expectPageError,
  waitForDocumentEditor,
} from '../electron.mjs'

const scenario = process.env.PAGE_ERROR_CASE
let close
// Runs after the harness's root hook, as a file's shared app closes.
test.after(async () => {
  console.log('later hook ran')
  await close?.()
})

test('a renderer throw', { timeout: 30000 }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-page-error-gate-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  close = async () => {
    close = undefined
    await app.close()
    await rm(profile, { recursive: true, force: true })
  }
  const page = await app.firstWindow()
  if (scenario === 'after the last test') {
    // The test's own after hooks run once its afterEach has checked.
    t.after(async () => {
      const thrown = page.waitForEvent('pageerror')
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error('gate boom')
        })
      })
      await thrown
    })
    return
  }
  t.after(() => close())
  if (scenario === 'allowed' || scenario === 'widget allowed')
    expectPageError(t, /gate boom/)
  if (scenario === 'never thrown') expectPageError(t, /never thrown/)
  if (scenario === 'other allowed') expectPageError(t, /something else/)
  if (scenario === 'measure') {
    // A throw CodeMirror catches with no label; no public path reaches one.
    await waitForDocumentEditor(app, page)
    const logged = page.waitForEvent('console', (message) =>
      message.text().includes('gate boom'),
    )
    await page.evaluate(() =>
      document.querySelector('.cm-content').cmTile.root.view.requestMeasure({
        read() {
          throw new Error('gate boom')
        },
      }),
    )
    await logged
  } else if (scenario === 'plugin') {
    const logged = page.waitForEvent('console')
    await page.evaluate(() =>
      console.error('CodeMirror plugin crashed:', new Error('gate boom')),
    )
    await logged
  } else if (scenario === 'widget' || scenario === 'widget allowed') {
    const logged = page.waitForEvent('console')
    await page.evaluate(() => console.error('widget:', new Error('gate boom')))
    await logged
  } else if (scenario !== 'never thrown') {
    const thrown = page.waitForEvent('pageerror')
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('gate boom')
      })
    })
    await thrown
  }
})
