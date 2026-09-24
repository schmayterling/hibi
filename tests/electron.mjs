import { _electron } from 'playwright'

// Local tests never take desktop focus. Hosted runners use their isolated desktop
// so Linux compositors keep painting frames and delivering native keyboard input.
export const electron = {
  async launch(options) {
    const application = await _electron.launch({
      ...options,
      args: [...options.args, '--hibi-test'],
    })
    const close = application.close.bind(application)
    let slowStartTimer
    let closing = false
    application.close = async () => {
      closing = true
      clearTimeout(slowStartTimer)
      let timer
      try {
        await Promise.race([
          close(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              application.process().kill('SIGKILL')
              reject(new Error('Electron test cleanup exceeded 20 seconds'))
            }, 20000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    if (process.env.GITHUB_ACTIONS === 'true') {
      const page = await application.firstWindow()
      await application.evaluate(({ app, BrowserWindow }) => {
        const show = (window) => {
          if (window.webContents.getURL().startsWith('hibi-analysis:')) return
          window.setFocusable(true)
          window.show()
          window.focus()
        }
        app.on('browser-window-created', (_event, window) => {
          window.once('ready-to-show', () => show(window))
        })
        for (const window of BrowserWindow.getAllWindows()) show(window)
      })
      if (process.platform === 'win32') {
        slowStartTimer = setTimeout(async () => {
          if (closing || page.isClosed()) return
          try {
            const snapshot = await startupDiagnostics(application, page)
            if (closing) return
            const dom = snapshot.renderer.dom
            if (
              dom?.settingsOpen ||
              dom?.sourceMode ||
              dom?.recoveryOpen ||
              dom?.editorHidden
            )
              return
            if (
              (dom?.editable || dom?.sourceEditable) &&
              dom.editorBusy !== 'true' &&
              !dom.editorInert
            )
              return
            console.error('slow editor startup:', JSON.stringify(snapshot))
          } catch {
            // Diagnostics must not change test results.
          }
        }, 4000)
        slowStartTimer.unref()
        void page
          .waitForFunction(
            () => {
              const editor = document.querySelector('.editor-page')
              return (
                editor &&
                !editor.inert &&
                editor.getAttribute('aria-busy') !== 'true' &&
                editor.querySelector(
                  '.tiptap[contenteditable="true"], .cm-content[contenteditable="true"]',
                )
              )
            },
            undefined,
            { timeout: 4000 },
          )
          .then(
            () => clearTimeout(slowStartTimer),
            () => {},
          )
      }
    }
    return application
  },
}

function startupEntries() {
  const doc = globalThis.document
  const editor = doc?.querySelector('.editor-page')
  const recovery = doc?.querySelector('.recovery-screen')
  return {
    dom: doc && {
      readyState: doc.readyState,
      editorBusy: editor?.getAttribute('aria-busy'),
      editorInert: editor?.inert,
      editorHidden: editor?.hidden,
      settingsOpen: !!doc.querySelector('.settings-screen:not([hidden])'),
      sourceMode: !!doc.querySelector(
        '.editor-panes.mode-markdown, .editor-panes.mode-side-by-side',
      ),
      recoveryOpen: !!recovery,
      recovery: recovery && {
        heading: recovery.querySelector('h1')?.textContent?.slice(0, 120),
        body: recovery
          .querySelector('.recovery-content > p')
          ?.textContent?.slice(0, 160),
        draftStatus: recovery
          .querySelector('.recovery-draft span:last-child')
          ?.textContent?.slice(0, 80),
      },
      loading: doc.querySelectorAll('.loading-screen').length,
      editable: doc.querySelectorAll('.tiptap[contenteditable="true"]').length,
      sourceEditable: doc.querySelectorAll(
        '.cm-content[contenteditable="true"]',
      ).length,
    },
    stages: performance
      .getEntries()
      .filter((entry) => entry.name.startsWith('hibi:'))
      .slice(-24)
      .map((entry) => ({
        name: entry.name.slice(5, 85),
        at: Math.round(entry.startTime),
        ms: Math.round(entry.duration),
        status: entry.detail?.status,
      })),
  }
}

// Use only after a readiness failure. Keep the original assertion error intact.
export async function startupDiagnostics(application, page) {
  const bounded = async (request) => {
    let timer
    try {
      return await Promise.race([
        request.catch(() => ({ unavailable: true })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ unavailable: true }), 1000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const [renderer, main, consoleErrors, pageErrors] = await Promise.all([
    bounded(page.evaluate(startupEntries)),
    bounded(application.evaluate(startupEntries)),
    bounded(
      page.consoleMessages().then((messages) =>
        messages
          .filter((message) => message.type() === 'error')
          .slice(-3)
          .map((message) => message.text().slice(0, 800)),
      ),
    ),
    bounded(
      page.pageErrors().then((errors) =>
        errors.slice(-3).map((error) => ({
          message: error.message.slice(0, 800),
          stack: error.stack?.slice(0, 800),
        })),
      ),
    ),
  ])
  return { renderer, main, consoleErrors, pageErrors }
}

export async function waitForDocumentEditor(application, page) {
  try {
    await page
      .getByRole('textbox', { name: 'Document editor', exact: true })
      .waitFor()
  } catch (error) {
    try {
      console.error(
        'document editor startup:',
        JSON.stringify(await startupDiagnostics(application, page)),
      )
    } catch {
      // Preserve the original Playwright failure if diagnostics cannot run.
    }
    throw error
  }
}

// Playwright's waitForFunction treats a returned Promise as truthy before it settles.
export async function waitForAppState(page, check, timeout = 10000) {
  const deadline = Date.now() + timeout
  do {
    if (await page.evaluate(check)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for app state')
}

export async function crashAndReload(application) {
  // Drain pending locator disposal before replacing Playwright's debug target.
  await (await application.firstWindow()).evaluate(() => undefined)
  await application.evaluate(async ({ dialog, BrowserWindow }) => {
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    })
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const loaded = new Promise((resolve) =>
      contents.once('did-finish-load', resolve),
    )
    // forcefullyCrashRenderer can hang under Linux's debugger/crash handler.
    if (process.platform === 'linux')
      process.kill(contents.getOSProcessId(), 'SIGKILL')
    else contents.forcefullyCrashRenderer()
    await loaded
  })
}
