import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, type BrowserWindow, dialog, Menu } from 'electron'
import './local-diagnostics-packaged-dialogs'
import '../../src/main/index'

// This entrypoint is never referenced by the production build. It runs in a
// separately signed test package with the production fuses left unchanged.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function run(window: BrowserWindow) {
  const root = app.getPath('userData')
  try {
    const editing =
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const ready = async () => {
        const element = document.querySelector('.rich-pane .hibi-formatted .cm-content[contenteditable="true"]');
        const view = element?.cmTile?.root.view;
        if (!view || !window.hibiDiagnostics) { if(Date.now() > deadline) reject(new Error('test readiness')); else setTimeout(ready, 20); return; }
        const config = JSON.parse(await window.hibiDiagnostics.configuration());
        view.dispatch(view.state.replaceSelection('PRIVATE PACKAGED DOCUMENT 雪'));
        await window.hibi.flushDocumentChanges();
        const doc = await window.hibi.getDocument();
        window.hibiDiagnostics.record(JSON.stringify({code:'RENDERER_ERROR',stackStatus:'captured',frames:[[config.artifacts[0][1],1,2]]}));
        resolve({ profile: config.profile, edited: doc.markdown === 'PRIVATE PACKAGED DOCUMENT 雪' });
      }; ready();
    })`)
    const report = join(root, 'manual-report.txt')
    setTimeout(() => {
      const error = new Error('PRIVATE_PACKAGED_EXCEPTION')
      Object.defineProperty(error, 'stack', { value: error.stack })
      throw error
    }, 0)
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: report })
    const find = (
      items: Electron.MenuItem[],
    ): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label.toLowerCase() === 'save diagnostic report…') return item
        const nested = item.submenu && find(item.submenu.items)
        if (nested) return nested
      }
      return undefined
    }
    const menu = find(Menu.getApplicationMenu()?.items ?? [])
    if (!menu) throw new Error('missing test report action')
    await wait(700)
    menu.click(undefined, window, undefined)
    let exported = ''
    for (let i = 0; i < 100; i++) {
      exported = await readFile(report, 'utf8').catch(() => '')
      if (exported) break
      await wait(20)
    }
    const directory = join(root, 'logs', editing.profile)
    const files = await Promise.all(
      (await readdir(directory)).map(
        async (name) =>
          [name, await readFile(join(directory, name), 'utf8')] as const,
      ),
    )
    const text = `${exported}\n${files.map(([, value]) => value).join('\n')}`
    if (
      !editing.edited ||
      !text.includes('RENDERER_ERROR') ||
      !text.includes('MAIN_EXCEPTION') ||
      !text.includes('"frames":[[1,') ||
      !exported ||
      /PRIVATE|PACKAGED DOCUMENT/.test(text) ||
      text.includes(root)
    )
      throw new Error('packaged privacy or editing check failed')
    await writeFile(
      join(root, 'test-result.json'),
      JSON.stringify({
        passed: true,
        packaged: app.isPackaged,
        profile: editing.profile,
        versions: process.versions,
        exportedBytes: Buffer.byteLength(exported),
        files: files.map(([name, value]) => ({
          name,
          bytes: Buffer.byteLength(value),
        })),
      }),
    )
  } catch {
    await writeFile(
      join(root, 'test-result.json'),
      JSON.stringify({ passed: false }),
    )
    process.exitCode = 1
  }
  await wait(2000) // Allow the external runner to verify secondary-instance ownership.
  app.quit()
}
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    void run(window)
  })
})
