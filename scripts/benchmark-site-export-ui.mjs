// Usage: node scripts/benchmark-site-export-ui.mjs <checkout> [pages] [single|folder]
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { electron } from '../tests/electron.mjs'
import { clickMenu } from '../tests/keyboard.mjs'

const [appDir = '.', countText = '2000', layout = 'single'] =
  process.argv.slice(2)
const count = Number(countText)
const root = await mkdtemp(join(tmpdir(), 'hibi-e2e-export-'))
const workspace = join(root, 'notes')
const profile = join(root, 'profile')
const output = join(root, 'output')
await mkdir(workspace)
await mkdir(profile)
await mkdir(output)
await writeFile(
  join(workspace, 'README.md'),
  '# Garden\n\nStart at [[note-1]].\n',
)
for (let folder = 0; folder * 100 < count - 1; folder++) {
  await mkdir(join(workspace, `folder-${folder}`))
  for (let i = folder * 100; i < Math.min((folder + 1) * 100, count - 1); i++)
    await writeFile(
      join(workspace, `folder-${folder}`, `note-${i}.md`),
      `# Note ${i}\n\n## Section\n\nSee [[note-${(i + 1) % (count - 1)}]] and [[note-${(i * 7) % (count - 1)}]].\n\n${'Some unicode prose 日本語 with **bold** and _emphasis_. '.repeat(60)}\n\n- one\n- two\n`,
    )
}
const app = await electron.launch({
  args: [appDir, `--user-data-dir=${profile}`],
})
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(120_000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(
    ({ dialog }, { workspace, output }) => {
      dialog.showOpenDialog = async (...args) => {
        const options = args.at(-1)
        return {
          canceled: false,
          filePaths: [
            options?.title === 'Choose export folder' ? output : workspace,
          ],
        }
      }
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: `${output}/site.html`,
      })
    },
    { workspace, output },
  )
  await page.evaluate(() => window.hibi.openWorkspace())
  await page.waitForFunction(() =>
    document
      .querySelector('.workspace-sidebar')
      ?.textContent.includes('README.md'),
  )
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('export workspace to html')
  await page
    .getByRole('option', { name: /^export workspace to html/i, selected: true })
    .waitFor()
  await page.getByRole('combobox', { name: /search commands/i }).press('Enter')
  const modal = page.getByRole('dialog', { name: /^export workspace$/i })
  await modal.waitFor()
  const exportButton = modal
    .locator('.dialog-footer')
    .getByRole('button', { name: /^export$/i })
  await exportButton.waitFor()
  if (layout === 'folder') {
    const single = modal.getByLabel(/single html file/i)
    if (await single.count()) {
      if (await single.first().isChecked()) await single.first().click()
    } else {
      const select = modal.getByLabel(/layout|format|output/i)
      if (await select.count()) await select.first().selectOption({ index: 1 })
    }
  }
  await app.evaluate(() => {
    const lag = { max: 0, last: performance.now(), run: true, samples: 0 }
    globalThis.__exportLag = lag
    const tick = () => {
      const now = performance.now()
      lag.max = Math.max(lag.max, now - lag.last - 20)
      lag.last = now
      lag.samples++
      if (lag.run) setTimeout(tick, 20)
    }
    setTimeout(tick, 20)
  })
  const loadBefore = loadavg()
  const started = Date.now()
  await exportButton.click()
  await page
    .getByText(new RegExp(`exported ${count} pages`, 'i'))
    .waitFor({ timeout: 900_000 })
  const elapsed = Date.now() - started
  const lag = await app.evaluate(() => {
    globalThis.__exportLag.run = false
    return {
      maxLagMs: Math.round(globalThis.__exportLag.max),
      samples: globalThis.__exportLag.samples,
    }
  })
  const files = await readdir(output, { recursive: true })
  let bytes = 0
  for (const file of files) {
    const info = await stat(join(output, file))
    if (info.isFile()) bytes += info.size
  }
  const phases = await app.evaluate(() => globalThis.__exportPhases ?? null)
  if (phases)
    console.log(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(phases).map(([k, v]) => [k, Math.round(v)]),
        ),
      ),
    )
  const memory = await app.evaluate(() => ({
    rss: process.memoryUsage().rss,
    peak: process.resourceUsage().maxRSS / 1024,
  }))
  console.log(
    JSON.stringify({
      app: appDir.split('/').at(-1),
      layout,
      count,
      elapsedMs: elapsed,
      loadAverageBefore: loadBefore,
      loadAverageAfter: loadavg(),
      mainMaxLagMs: lag.maxLagMs,
      outputFiles: files.length,
      outputBytes: bytes,
      mainRssMiB: Math.round(memory.rss / 2 ** 20),
      peakMainRssMiB: memory.peak,
    }),
  )
} finally {
  await app.close()
  await rm(root, { recursive: true, force: true })
}
