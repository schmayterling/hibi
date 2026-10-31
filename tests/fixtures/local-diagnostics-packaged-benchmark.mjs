import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, dialog, ipcMain, screen } from 'electron'

// Imported only into disposable benchmark packages, never production output.
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
app.once('browser-window-created', (_event, window) => {
  let calls = 0
  const channel = 'hibi:local-diagnostics'
  const handler = ipcMain._invokeHandlers.get(channel)
  if (handler) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (...args) => {
      if (args[1] === 'batch') calls++
      return handler(...args)
    })
  }
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      let result
      try {
        const ready =
          await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const end = Date.now() + 10000;
          const poll = () => { const el = document.querySelector('[role="textbox"][aria-label="Document editor"]'); if(el?.isContentEditable && !el.closest('[inert]') && el.getBoundingClientRect().width > 0 && el.cmTile) resolve(performance.timeOrigin + performance.now()); else if(Date.now()>end) reject(new Error('readiness')); else requestAnimationFrame(poll); }; poll();
        })`)
        await window.webContents.executeJavaScript(`(() => {
          const el=document.querySelector('.rich-pane .cm-content'), view=el.cmTile.root.view, dispatch=view.dispatch;
          window.localBenchmark={cpu:[], proxy:[]};
          view.dispatch({selection:{anchor:view.state.doc.length}}); view.focus();
          view.dispatch=(...specs)=>{const start=performance.now(), before=view.state.doc;try{dispatch.apply(view,specs)}finally{if(view.state.doc!==before)window.localBenchmark.cpu.push(performance.now()-start)}};
          el.addEventListener('beforeinput',()=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.localBenchmark.proxy.push(performance.now()-start)))});
        })()`)
        for (let n = 0; n < 120; n++) await window.webContents.insertText('a')
        const samples = await window.webContents.executeJavaScript(
          'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(window.localBenchmark))))',
        )
        if (samples.cpu.length !== 120 || calls !== 0)
          throw new Error('input accounting')
        result = {
          passed: true,
          packaged: app.isPackaged,
          startupMs:
            ready -
            Number(app.commandLine.getSwitchValue('o11y-benchmark-start')),
          samples,
          diagnosticBatches: calls,
          refresh: screen.getPrimaryDisplay().displayFrequency,
          versions: process.versions,
        }
      } catch {
        result = { passed: false }
      }
      await writeFile(
        join(app.getPath('userData'), 'benchmark-result.json'),
        JSON.stringify(result),
      )
      app.quit()
    })()
  })
})
