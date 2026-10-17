import { spawnSync } from 'node:child_process'
import { _electron } from 'playwright'

function drainElectronStdio(child) {
  for (const stream of child.stdio ?? [child.stdout, child.stderr])
    stream?.destroy()
}

// Playwright can wait for inherited stdio to close after Electron itself exits.
export function waitForElectronExit(child, closePromise, drainStdio = true) {
  return new Promise((resolve, reject) => {
    let settled = false
    let closeSettled = false
    let exited = false
    const finish = (error) => {
      if (settled) return
      settled = true
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onExit = (code, signal) => {
      exited = true
      if (drainStdio) drainElectronStdio(child)
      if (code !== 0 || signal !== null) {
        finish(new Error(`Electron exited with code ${code}, signal ${signal}`))
        return
      }
      if (closeSettled) finish()
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
  return waitForElectronExit(
    child,
    closePromise,
    !waitForTransport && platform !== 'win32',
  )
}

export function stopElectronTree(child) {
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return
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
    // Playwright's Unix process group can outlive its Electron leader.
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // Fall back to the main process if the group has already exited.
    }
  }
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL')
}

// Local tests never take desktop focus. Hosted runners use their isolated desktop
// so Linux compositors keep painting frames and delivering native keyboard input.
export const showTestWindows =
  (process.env.GITHUB_ACTIONS === 'true' && !!process.env.GITHUB_RUN_ID) ||
  process.env.HIBI_TEST_SHOW_WINDOWS === '1'
export const electron = {
  async launch(options) {
    // Cold Xvfb runners can lose the default GPU process before first paint.
    const gpuArgs =
      showTestWindows && process.platform === 'linux'
        ? ['--use-gl=angle', '--use-angle=swiftshader']
        : []
    const application = await _electron.launch({
      ...options,
      args: [...options.args, '--hibi-test', ...gpuArgs],
    })
    const close = application.close.bind(application)
    const quitTrace = {
      notInstalled: true,
      seen: 0,
      dropped: 0,
      clipped: 0,
      errors: 0,
      producerErrors: 0,
      windowLimit: false,
      writerLimit: false,
      beforeQuitSeen: false,
      willQuitSeen: false,
      quitSeen: false,
      windowAllClosedSeen: false,
      detached: false,
      lastReceivedAt: null,
      rows: [],
    }
    let slowStartTimer
    let slowStart
    let closing = false
    application.close = async ({ waitForTransport = false } = {}) => {
      closing = true
      clearTimeout(slowStartTimer)
      // A failed startup wait closes the app; let its report finish first.
      await slowStart
      const child = application.process()
      let timer, diagnosticTimer
      try {
        diagnosticTimer = setTimeout(() => {
          try {
            console.error(
              'electron-shutdown-pending',
              JSON.stringify({
                pid: child.pid,
                exitCode: child.exitCode,
                signalCode: child.signalCode,
                profile: child.spawnargs
                  ?.find((arg) => arg.startsWith('--user-data-dir='))
                  ?.slice(0, 256),
                pipes: child.stdio?.slice(0, 8).map(
                  (stream) =>
                    stream && {
                      destroyed: stream.destroyed,
                      closed: stream.closed,
                    },
                ),
                quit: {
                  ...quitTrace,
                  ageMs:
                    quitTrace.lastReceivedAt === null
                      ? null
                      : Math.round(
                          performance.now() - quitTrace.lastReceivedAt,
                        ),
                  scope: 'first-before-quit',
                  eventTimeOnly: true,
                  unavailable: !quitTrace.beforeQuitSeen,
                  unknown: true,
                },
              }),
            )
          } catch {}
        }, 3000)
        diagnosticTimer.unref()
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
        clearTimeout(diagnosticTimer)
      }
    }
    if (showTestWindows) {
      // The inspector may already be closed; keep only validated stdout events.
      let detachQuitTrace
      try {
        const child = application.process()
        const prefix = 'hibi-test-quit '
        const events = [
          'armed',
          'before-quit',
          'will-quit',
          'quit',
          'window-all-closed',
          'browser-window-created',
          'window-state',
          'close',
          'closed',
          'window-limit',
          'writer-limit',
          'observer-error',
        ]
        const windowEvents = [
          'browser-window-created',
          'window-state',
          'close',
          'closed',
        ]
        let partial = '',
          skipping = false,
          active = true
        const bump = (key) => {
          quitTrace[key] = Math.min(999999, quitTrace[key] + 1)
        }
        const onData = (chunk) => {
          if (!active) return
          try {
            if (chunk.length > 4096) {
              bump('clipped')
              partial = ''
              skipping = true
              return
            }
            let text = String(chunk)
            if (skipping) {
              const end = text.indexOf('\n')
              if (end < 0) return
              text = text.slice(end + 1)
              skipping = false
            }
            const lines = (partial + text).split(/\r?\n/)
            partial = lines.pop()
            if (Buffer.byteLength(partial) > 160) {
              partial = ''
              skipping = true
              bump('clipped')
            }
            for (const line of lines) {
              if (!line.startsWith(prefix)) continue
              if (line.length > 160 || !/^[\x20-\x7e]*$/.test(line)) {
                bump('clipped')
                continue
              }
              let row
              try {
                row = JSON.parse(line.slice(prefix.length))
              } catch {
                bump('errors')
                continue
              }
              if (
                !Array.isArray(row) ||
                row.length !== 7 ||
                !events.includes(row[0]) ||
                !Number.isSafeInteger(row[1]) ||
                row[1] < 0 ||
                !Number.isSafeInteger(row[2]) ||
                row[2] < 0 ||
                !['app', 'addon', 'analysis', 'other'].includes(row[3]) ||
                ![true, false, null].includes(row[4]) ||
                ![true, false, null].includes(row[5]) ||
                !Number.isInteger(row[6]) ||
                row[6] < 0 ||
                row[6] > 999999 ||
                (windowEvents.includes(row[0])
                  ? row[2] === 0
                  : row[2] !== 0 ||
                    row[3] !== 'other' ||
                    row[4] !== null ||
                    row[5] !== null)
              ) {
                bump('errors')
                continue
              }
              bump('seen')
              quitTrace.lastReceivedAt = performance.now()
              quitTrace.producerErrors = Math.max(
                quitTrace.producerErrors,
                row[6],
              )
              if (row[0] === 'armed') quitTrace.notInstalled = false
              if (row[0] === 'before-quit') quitTrace.beforeQuitSeen = true
              if (row[0] === 'will-quit') quitTrace.willQuitSeen = true
              if (row[0] === 'quit') quitTrace.quitSeen = true
              if (row[0] === 'window-all-closed')
                quitTrace.windowAllClosedSeen = true
              if (row[0] === 'window-limit') quitTrace.windowLimit = true
              if (row[0] === 'writer-limit') quitTrace.writerLimit = true
              if (quitTrace.rows.length === 24) {
                quitTrace.rows.splice(6, 1)
                bump('dropped')
              }
              quitTrace.rows.push(row)
            }
          } catch {
            bump('errors')
          }
        }
        detachQuitTrace = () => {
          if (!active) return
          active = false
          quitTrace.detached = true
          partial = ''
          try {
            child.stdout?.off('data', onData)
            child.stdout?.off('close', detachQuitTrace)
            child.off('exit', detachQuitTrace)
            child.off('close', detachQuitTrace)
          } catch {
            bump('errors')
          }
        }
        child.stdout?.on('data', onData)
        child.stdout?.once('close', detachQuitTrace)
        child.once('exit', detachQuitTrace)
        child.once('close', detachQuitTrace)
      } catch {
        detachQuitTrace?.()
        quitTrace.errors = Math.min(999999, quitTrace.errors + 1)
      }
      const page = await application.firstWindow()
      await application.evaluate(({ app, BrowserWindow }) => {
        // Event-time evidence only: no earlier window history or private quit state.
        try {
          const prefix = 'hibi-test-quit '
          const states = new Map()
          let rows = 0,
            bytes = 0,
            errors = 0,
            halted = false
          let inQuitScope = false,
            windowLimit = false
          const write = (event, state) => {
            if (halted) return
            try {
              const at = Math.round(process.uptime() * 1000)
              const data = state ?? {
                id: 0,
                kind: 'other',
                visible: null,
                destroyed: null,
              }
              let line =
                prefix +
                JSON.stringify([
                  event,
                  at,
                  data.id,
                  data.kind,
                  data.visible,
                  data.destroyed,
                  errors,
                ])
              let size = Buffer.byteLength(line) + 1
              if (rows === 31 || size > 160 || bytes + size > 3936) {
                line =
                  prefix +
                  JSON.stringify([
                    'writer-limit',
                    at,
                    0,
                    'other',
                    null,
                    null,
                    errors,
                  ])
                size = Buffer.byteLength(line) + 1
                halted = true
              }
              rows++
              bytes += size
              console.log(line)
            } catch {
              errors = Math.min(999999, errors + 1)
            }
          }
          const limitWindows = () => {
            if (windowLimit) return
            windowLimit = true
            write('window-limit')
          }
          const watch = (window, event) => {
            try {
              const id = window.id
              let state = states.get(id)
              if (!state) {
                if (states.size === 8) {
                  limitWindows()
                  return
                }
                state = { id, kind: 'other', visible: null, destroyed: null }
                states.set(id, state)
                window.on('close', () => watch(window, 'close'))
                window.once('closed', () => {
                  state.visible = false
                  state.destroyed = true
                  write('closed', state)
                })
              }
              try {
                state.destroyed = window.isDestroyed()
                state.visible = state.destroyed ? false : window.isVisible()
                if (!state.destroyed) {
                  const url = window.webContents.getURL()
                  state.kind =
                    url === 'app://hibi/'
                      ? 'app'
                      : url.startsWith('app://hibi/addon-window.html')
                        ? 'addon'
                        : url.startsWith('hibi-analysis:')
                          ? 'analysis'
                          : 'other'
                }
              } catch {
                state.visible = null
                state.destroyed = null
                errors = Math.min(999999, errors + 1)
              }
              write(event, state)
            } catch {
              errors = Math.min(999999, errors + 1)
              write('observer-error')
            }
          }
          app.on('before-quit', () => {
            inQuitScope = true
            write('before-quit')
            try {
              const windows = BrowserWindow.getAllWindows()
              for (const window of windows.slice(0, 8))
                watch(window, 'window-state')
              if (windows.length > 8) limitWindows()
            } catch {
              errors = Math.min(999999, errors + 1)
              write('observer-error')
            }
          })
          app.on('browser-window-created', (_event, window) => {
            if (inQuitScope) watch(window, 'browser-window-created')
          })
          for (const event of ['will-quit', 'quit', 'window-all-closed'])
            app.on(event, () => write(event))
          write('armed')
        } catch {}
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
      const reportSlowStart = async () => {
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
          if (ready) return
          const snapshot = await startupDiagnostics(application, page)
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
      }
      slowStartTimer = setTimeout(() => {
        if (closing || page.isClosed()) return
        slowStart = reportSlowStart()
      }, 4000)
      slowStartTimer.unref()
    }
    return application
  },
}

function startupEntries({ BrowserWindow } = {}) {
  const doc = globalThis.document
  const editor = doc?.querySelector('.editor-page')
  const panel = doc?.querySelector('#document-editor-panel')
  const tiptap = panel?.querySelector('.tiptap')
  const input = editor?.querySelector(
    '.tiptap[contenteditable="true"], .cm-content[contenteditable="true"]',
  )
  const recovery = doc?.querySelector('.recovery-screen')
  const entries = performance
    .getEntries()
    .filter((entry) => entry.name.startsWith('hibi:'))
  const recent = entries.slice(-20)
  const active = doc?.activeElement
  const menus = [
    ...(doc?.querySelectorAll('[role="menu"][aria-label="Editor actions" i]') ??
      []),
  ]
  const histories = [
    ...(doc?.querySelectorAll(
      'dialog.app-dialog[aria-label="Version history" i]',
    ) ?? []),
  ]
  const palettes = [...(doc?.querySelectorAll('dialog.command-palette') ?? [])]
  const text = (value, limit = 80) => String(value ?? '').slice(0, limit)
  return {
    dom: doc && {
      readyState: doc.readyState,
      appBusy: doc.querySelector('.app')?.getAttribute('aria-busy'),
      editorPanelBusy: panel?.getAttribute('aria-busy'),
      tiptapReadOnly: tiptap?.getAttribute('aria-readonly'),
      tiptapContentEditable: tiptap?.getAttribute('contenteditable'),
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
      nativeFocus: Document.prototype.hasFocus.call(doc),
      activeElement: active && {
        tag: text(active.tagName),
        role: text(active.getAttribute('role')),
        ariaLabel: text(active.getAttribute('aria-label')),
        class: text(active.getAttribute('class'), 120),
      },
      startup: {
        screens: doc.querySelectorAll('.startup-placeholder').length,
        dismissButtons: [
          ...doc.querySelectorAll(
            '.startup-placeholder .startup-actions button',
          ),
        ].filter((button) =>
          /dismiss this screen/i.test(text(button.textContent)),
        ).length,
        documentTabs: doc.querySelectorAll('.document-tabs [role="tab"]')
          .length,
      },
      editorMenus: {
        count: menus.length,
        samples: menus.slice(0, 2).map((menu) => {
          const items = [...menu.querySelectorAll('[role="menuitem"]')]
          return {
            open: menu.matches(':popover-open'),
            itemCount: items.length,
            itemLabels: items
              .slice(0, 4)
              .map((item) =>
                text(
                  item.getAttribute('aria-label') ??
                    item.querySelector('.command-label')?.textContent ??
                    item.textContent,
                ),
              ),
          }
        }),
      },
      historyDialogs: {
        count: histories.length,
        samples: histories.slice(0, 2).map((dialog) => {
          const navs = dialog.querySelectorAll(
            'nav[aria-label="Saved versions" i]',
          )
          const buttons = [
            ...dialog.querySelectorAll(
              'nav[aria-label="Saved versions" i] button',
            ),
          ]
          const last = buttons.at(-1)
          return {
            open: dialog.open,
            closing: dialog.classList.contains('closing'),
            navCount: navs.length,
            buttonCount: buttons.length,
            lastButton: last && {
              disabled: last.disabled,
              pressed: last.getAttribute('aria-pressed') === 'true',
            },
          }
        }),
      },
      palette: {
        openCount: palettes.filter((dialog) => dialog.open).length,
        closingCount: palettes.filter((dialog) =>
          dialog.classList.contains('closing'),
        ).length,
      },
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
          timer.unref()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const [renderer, main, consoleErrors, pageErrors] = await Promise.all([
    bounded(page.evaluate(startupEntries)),
    bounded(
      application
        ? application.evaluate(startupEntries)
        : Promise.resolve({ unavailable: true }),
    ),
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

export async function waitForDocumentEditor(
  application,
  page,
  { name = 'Document editor', timeout } = {},
) {
  try {
    // A visible textbox can still belong to an inert addon or a pending tab.
    await page
      .locator(
        '.app[aria-busy="false"] #document-editor-panel[aria-busy="false"]',
      )
      .getByRole('textbox', { name, exact: true })
      .and(
        page.locator(
          '[contenteditable="true"]:not([aria-readonly="true"]):not([inert] *)',
        ),
      )
      .and(
        page.locator(
          ':not(.cm-content), [data-source-ready="true"] .cm-content',
        ),
      )
      .waitFor({ timeout })
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
