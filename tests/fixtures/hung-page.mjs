// A page that stops answering while a test holds a CDP session, as tests that drive input do.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from '../electron.mjs'

test('a page that never answers', { timeout: 3000 }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-hung-page-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  console.error(`hung-page-app ${app.process().pid}`)
  const page = await app.firstWindow()
  const cdp = await page.context().newCDPSession(page)
  t.after(async () => {
    await cdp.detach()
    console.error('hung-page-detached')
    if (process.env.HUNG_PAGE_CLOSE === '1') await app.close()
  })
  page
    .evaluate(() => {
      for (;;);
    })
    .catch(() => {})
  await page.evaluate(() => 1)
})
