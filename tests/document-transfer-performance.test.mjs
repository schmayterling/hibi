import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

for (const mib of [2, 8])
  test(`${mib} mib tab activation and save send metadata without streaming source again`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hibi-document-replies-'))
    const big = join(root, `big-${mib}.md`),
      small = join(root, 'small.md')
    const unit = `${'ordinary words '.repeat(16)}\n\n`
    const text = unit
      .repeat(Math.ceil((mib * 1048576) / unit.length))
      .slice(0, mib * 1048576)
    await writeFile(big, text)
    await writeFile(small, 'small note')
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
    })
    t.after(async () => {
      await app.close().catch(() => {})
      await rm(root, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    await waitForDocumentEditor(app, page)
    await app.evaluate(
      ({ dialog, ipcMain }, paths) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [paths.shift()],
        })
        dialog.showMessageBox = async () => ({
          response: 0,
          checkboxChecked: false,
        })
        globalThis.replyProbe = {
          reads: 0,
          saved: false,
          saveMs: 0,
          receipt: null,
        }
        for (const [channel, invoke] of ipcMain._invokeHandlers) {
          if (
            channel !== 'document:transfer-read' &&
            channel !== 'document:save'
          )
            continue
          ipcMain._invokeHandlers.set(channel, async (...args) => {
            const start = performance.now(),
              result = await invoke(...args)
            if (channel === 'document:transfer-read')
              globalThis.replyProbe.reads++
            else
              Object.assign(globalThis.replyProbe, {
                saved: true,
                saveMs: performance.now() - start,
                receipt: result,
              })
            return result
          })
        }
      },
      [big, small],
    )
    await clickMenu(app, 'Open…')
    await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    await clickMenu(app, 'Open…')
    await waitForDocumentEditor(app, page)
    const times = []
    for (let round = 0; round < 2; round++) {
      await app.evaluate(() => {
        globalThis.replyProbe.reads = 0
      })
      const start = performance.now()
      await page
        .getByRole('tab')
        .filter({ hasText: basename(big) })
        .click()
      await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
      times.push(performance.now() - start)
      assert.equal(await app.evaluate(() => globalThis.replyProbe.reads), 0)
      if (!round) {
        await page
          .getByRole('tab')
          .filter({ hasText: basename(small) })
          .click()
        await waitForDocumentEditor(app, page)
      }
    }
    await page.evaluate(() => {
      const view = document.querySelector('.source-pane .cm-content').cmTile
        .root.view
      view.dispatch({
        changes: { from: 0, to: 1, insert: 'Z' },
        userEvent: 'input.type',
      })
      return window.hibi.flushDocumentChanges()
    })
    await app.evaluate(() => {
      Object.assign(globalThis.replyProbe, { reads: 0, saved: false })
    })
    const start = performance.now()
    await clickMenu(app, 'Save')
    await waitForAsync(app, () => globalThis.replyProbe.saved)
    await page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false' &&
        !document
          .querySelector('[role="tab"][aria-selected="true"]')
          ?.textContent.includes('•'),
    )
    const saved = await app.evaluate(() => globalThis.replyProbe)
    assert.equal(saved.reads, 0)
    assert.equal(saved.receipt.saveReceipt, true)
    assert.equal('documentTransfer' in saved.receipt, false)
    assert.equal(await readFile(big, 'utf8'), 'Z' + text.slice(1))
    t.diagnostic(
      JSON.stringify({
        mib,
        switchMs: times,
        saveUiMs: performance.now() - start,
        saveHandlerMs: saved.saveMs,
        transferReads: saved.reads,
      }),
    )
  })
