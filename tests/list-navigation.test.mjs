import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  launchBenchmarkApp,
  waitForEditor,
} from '../scripts/benchmark-flows.mjs'

test('rendered previews nest lists in one spacing rhythm', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-list-navigation-'))
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForEditor(page)
  // Rendered previews put tight item text straight into the li, before any nested list.
  const rendered = await page.evaluate(() => {
    const host = document.createElement('div')
    host.className = 'format-content'
    host.innerHTML = `<ul><li>sibling</li>${[
      'plain',
      '<strong>formatted</strong>',
      '<input disabled="" type="checkbox"> checkbox',
    ]
      .map((parent) => `<li>${parent}<ul><li>child</li></ul></li>`)
      .join('')}</ul>`
    document.body.append(host)
    const top = (element) => element.getBoundingClientRect().top
    const [sibling, ...items] = host.querySelectorAll(':scope > ul > li')
    const result = {
      pitch: Math.round(top(items[0]) - top(sibling)),
      nested: items.map((item) =>
        Math.round(top(item.querySelector('ul')) - top(item)),
      ),
    }
    host.remove()
    return result
  })
  const { pitch } = rendered
  assert.deepEqual(
    rendered.nested,
    [pitch, pitch, pitch],
    'rendered nested lists',
  )
})
