import { spawnSync } from 'node:child_process'
import { _electron } from 'playwright'

function drainElectronStdio(child) {
  for (const stream of child.stdio ?? [child.stdout, child.stderr])
    stream?.destroy()
}

// Playwright can wait for inherited stdio to close after Electron itself exits.
export function waitForElectronExit(child, closePromise) {
  return new Promise((resolve, reject) => {
    let settled = false
    let closeSettled = false
    let exited = false
    let grace
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(grace)
      child.off('exit', onExit)
      if (exited) drainElectronStdio(child)
      if (error) reject(error)
      else resolve()
    }
    const onExit = (code, signal) => {
      exited = true
      if (code !== 0 || signal !== null) {
        finish(new Error(`Electron exited with code ${code}, signal ${signal}`))
        return
      }
      // Playwright may never settle after a clean exit; allow prompt errors first.
      if (closeSettled) finish()
      else grace = setTimeout(() => finish(), 100)
    }
    child.once('exit', onExit)
    closePromise.then(
      () => {
        closeSettled = true
        if (exited) finish()
      },
      (error) => finish(error),
    )
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode)
    }
  })
}

export function waitForElectronShutdown(
  child,
  closePromise,
  platform = process.platform,
  waitForTransport = false,
) {
  // Windows keeps profile databases locked until Chromium descendants close.
  if (!waitForTransport && platform !== 'win32')
    return waitForElectronExit(child, closePromise)
  const exited = new Promise((resolve, reject) => {
    const finish = (code, signal) => {
      if (code === 0 && signal === null) resolve()
      else
        reject(new Error(`Electron exited with code ${code}, signal ${signal}`))
    }
    child.once('exit', finish)
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off('exit', finish)
      finish(child.exitCode, child.signalCode)
    }
  })
  return Promise.all([closePromise, exited]).then(() => undefined)
}

export function stopElectronTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const result = spawnSync(
      'taskkill',
      ['/PID', String(child.pid), '/T', '/F'],
      {
        windowsHide: true,
        timeout: 5000,
      },
    )
    if (result.status === 0) return
  } else {
    // Playwright launches Electron as its own process group on Unix.
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // Fall back to the main process if the group has already exited.
    }
  }
  child.kill('SIGKILL')
}

// Local tests never take desktop focus. Hosted runners use their isolated desktop
// so Linux compositors keep painting frames and delivering native keyboard input.
export const electron = {
  async launch(options) {
    // Cold Xvfb runners can lose the default GPU process before first paint.
    const gpuArgs =
      process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux'
        ? ['--use-gl=angle', '--use-angle=swiftshader']
        : []
    const application = await _electron.launch({
      ...options,
      args: [...options.args, '--hibi-test', ...gpuArgs],
    })
    const close = application.close.bind(application)
    let slowStartTimer
    let closing = false
    application.close = async ({ waitForTransport = false } = {}) => {
      closing = true
      clearTimeout(slowStartTimer)
      const child = application.process()
      let timer
      try {
        const pendingClose = close()
        await Promise.race([
          waitForElectronShutdown(
            child,
            pendingClose,
            process.platform,
            waitForTransport,
          ),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('Electron test cleanup exceeded 20 seconds'))
            }, 20000)
          }),
        ])
      } catch (error) {
        stopElectronTree(child)
        drainElectronStdio(child)
        throw error
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
      slowStartTimer = setTimeout(async () => {
        if (closing || page.isClosed()) return
        try {
          let readinessTimer
          const ready = await Promise.race([
            page
              .evaluate(() => {
                const editor = document.querySelector('.editor-page')
                const input = editor?.querySelector(
                  '.tiptap[contenteditable="true"], .cm-content[contenteditable="true"]',
                )
                return !!(
                  input &&
                  !editor.closest('[inert], [hidden], [aria-hidden="true"]') &&
                  editor.getAttribute('aria-busy') !== 'true' &&
                  input.getClientRects().length &&
                  getComputedStyle(input).visibility !== 'hidden'
                )
              })
              .catch(() => false),
            new Promise((resolve) => {
              readinessTimer = setTimeout(() => resolve(false), 1000)
              readinessTimer.unref()
            }),
          ])
          clearTimeout(readinessTimer)
          if (ready || closing) return
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
          if (dom?.visibleEditable) return
          console.error('slow editor startup:', JSON.stringify(snapshot))
        } catch {
          // Diagnostics must not change test results.
        }
      }, 4000)
      slowStartTimer.unref()
    }
    return application
  },
}

function startupEntries({ BrowserWindow } = {}) {
  const doc = globalThis.document
  const editor = doc?.querySelector('.editor-page')
  const input = editor?.querySelector(
    '.tiptap[contenteditable="true"], .cm-content[contenteditable="true"]',
  )
  const recovery = doc?.querySelector('.recovery-screen')
  const entries = performance
    .getEntries()
    .filter((entry) => entry.name.startsWith('hibi:'))
  const recent = entries.slice(-20)
  return {
    dom: doc && {
      readyState: doc.readyState,
      editorBusy: editor?.getAttribute('aria-busy'),
      editorInert: editor?.inert,
      editorHidden: editor?.hidden,
      visibleEditable: !!(
        input &&
        !editor.closest('[inert], [hidden], [aria-hidden="true"]') &&
        editor.getAttribute('aria-busy') !== 'true' &&
        input.getClientRects().length &&
        getComputedStyle(input).visibility !== 'hidden'
      ),
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
    stages: [
      ...new Set([
        ...entries.filter((entry) => entry.entryType === 'mark').slice(0, 24),
        ...recent,
      ]),
    ].map((entry) => ({
      name: entry.name.slice(5, 85),
      at: Math.round(entry.startTime),
      ms: Math.round(entry.duration),
      status: entry.detail?.status,
    })),
    windows:
      !doc &&
      BrowserWindow?.getAllWindows()
        .slice(0, 4)
        .map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
          loading: window.webContents.isLoading(),
          mainFrameLoading: window.webContents.isLoadingMainFrame(),
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
