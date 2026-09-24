import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { preserveRichSource } from '../src/renderer/src/rich-source-preservation.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('rich block insertion keeps CRLF and untouched Markdown', () => {
  const extensions = [StarterKit.configure({ trailingNode: false })]
  const schema = getSchema(extensions)
  const manager = new MarkdownManager({ extensions })
  const source = '# top\r\n\r\n## next\r\n'
  const before = schema.nodeFromJSON(manager.parse(source))
  const after = schema.nodes.doc.create(null, [
    schema.nodes.heading.create({ level: 1 }, schema.text('replacement')),
    ...before.content.content,
  ])
  assert.equal(
    preserveRichSource(
      source,
      manager.serialize(before.toJSON()),
      manager.serialize(after.toJSON()),
      (candidate) => schema.nodeFromJSON(manager.parse(candidate)).eq(after),
    ),
    `# replacement\r\n\r\n${source}`,
  )
})

test('rich edits and autosave preserve untouched Obsidian syntax', {
  timeout: 30000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-obsidian-rich-'))
  const file = join(folder, 'note.md')
  const original =
    '# Notes\n\n> [!tip] Keep this callout.\n\n[[assets/some.svg]]\n\n- [ ] pending\n\nSource: keep this text.\n'
  await writeFile(file, original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const rich = page.getByRole('textbox', { name: 'Document editor' })
  await rich.waitFor()
  await page.evaluate(() =>
    localStorage.setItem(
      'hibi:autosave',
      JSON.stringify({ enabled: true, delay: 1000 }),
    ),
  )
  await page.reload()
  await rich.waitFor()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await clickMenu(app, 'Open…')
  await page.getByRole('tab', { name: 'note.md' }).waitFor()
  await rich.getByText('Source: keep this text.').click()
  await page.keyboard.press('Enter')
  await waitForAsync(page, async () => (await window.hibi.getDocument()).dirty)
  const changed = (await page.evaluate(() => window.hibi.getDocument()))
    .markdown
  assert.match(changed, /\[\[assets\/some\.svg\]\]/)
  assert.match(changed, /> \[!tip\] Keep this callout\./)
  assert.doesNotMatch(changed, /&nbsp;/)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), changed)

  await rich.getByRole('checkbox').check()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('- [x] pending'),
  )
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  const checked = await readFile(file, 'utf8')
  assert.match(checked, /- \[x\] pending/)
  assert.match(checked, /\[\[assets\/some\.svg\]\]/)
  assert.match(checked, /> \[!tip\] Keep this callout\./)
})
