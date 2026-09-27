import { resolve } from 'node:path'
import { electron } from '../tests/electron.mjs'
import { clickMenu, pressShortcut } from '../tests/keyboard.mjs'

export const benchmarkDocuments = [
  {
    name: 'large.md',
    title: 'Large benchmark',
    source:
      '# Large benchmark\n\n' +
      'A paragraph for measuring document layout and keyboard input. **Bold** and *italic*.\n\n'.repeat(
        180,
      ),
  },
  {
    name: 'code.md',
    title: 'Code benchmark',
    source:
      '# Code benchmark\n\n' +
      [
        '```js\nconst answer = 42;\n```',
        '```rust\nfn main() { let answer = 42; }\n```',
        '```python\ndef answer():\n  return 42\n```',
        '```sql\nSELECT name FROM notes;\n```',
      ]
        .join('\n\n')
        .concat('\n\n')
        .repeat(20),
  },
]

export async function launchBenchmarkApp(profile, entry = resolve('.')) {
  const app = await electron.launch({
    args: [entry, `--user-data-dir=${profile}`],
  })
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    return app
  } catch (error) {
    await app.close()
    throw error
  }
}

// Frame polling avoids locator retry backoff being counted as startup latency.
export function waitForEditor(page) {
  return page.waitForFunction(() => {
    const editor = document.querySelector(
      '[role="textbox"][aria-label="Document editor"]',
    )
    return (
      editor?.isContentEditable &&
      !editor.closest('[inert]') &&
      editor.getBoundingClientRect().width > 0
    )
  })
}

export async function waitForWorkspaces(page, paths) {
  try {
    return await page.waitForFunction((paths) => {
      const buttons = [
        ...document.querySelectorAll('.startup-placeholder li button'),
      ]
      return (
        buttons.length === paths.length &&
        buttons.every(
          (button, index) =>
            button.textContent === paths[index] &&
            !button.disabled &&
            !button.closest('[inert]'),
        )
      )
    }, paths)
  } catch (cause) {
    const state = await page
      .evaluate(async () => ({
        recent: await Promise.race([
          Promise.all(
            [
              window.hibi.bootstrap.recentWorkspaces(),
              window.hibi.getRecentWorkspaces(),
            ].map((pending) =>
              pending.then(
                (items) => ({ items }),
                (error) => ({ error: String(error) }),
              ),
            ),
          ).then(([bootstrap, live]) => ({ bootstrap, live })),
          new Promise((resolve) => setTimeout(() => resolve('pending'), 1000)),
        ]),
        startup: document.querySelector('.editor-page')?.dataset.startup,
        placeholder: !!document.querySelector('.startup-placeholder'),
        welcomeDismissed: sessionStorage.getItem('hibi:welcome-dismissed'),
        editorTextLength: document.querySelector('.tiptap')?.textContent.length,
        workspaces: [
          ...document.querySelectorAll('.startup-placeholder li button'),
        ].map((button) => ({
          text: button.textContent,
          disabled: button.disabled,
          inert: !!button.closest('[inert]'),
          visible: button.getBoundingClientRect().width > 0,
        })),
        panes: document.querySelector('.editor-panes')?.className,
        busy: document.querySelector('.editor-page')?.getAttribute('aria-busy'),
      }))
      .catch(() => null)
    throw new Error(
      `Workspace readiness failed: ${JSON.stringify({ expected: paths, state })}`,
      { cause },
    )
  }
}

export async function typeCharacter(page, previousText, character = 'x') {
  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  if (process.env.HIBI_BENCH_INSERT_TEXT === '1') {
    await editor.focus()
    await page.keyboard.insertText(character)
  } else await editor.press(character)
  try {
    await page.waitForFunction(
      (previous) =>
        document.querySelector('[role="textbox"][aria-label="Document editor"]')
          ?.textContent !== previous,
      previousText,
    )
  } catch (error) {
    const state = await page.evaluate(async () => {
      const editor = document.querySelector('[aria-label="Document editor"]')
      return {
        text: editor?.textContent?.slice(0, 120),
        editable: editor?.getAttribute('contenteditable'),
        editorEditable: editor?.editor?.isEditable,
        active: document.activeElement === editor,
        windowFocused: document.hasFocus(),
        busy: document.querySelector('.editor-page')?.getAttribute('aria-busy'),
        sourceReady:
          document.querySelector('.editor-panes')?.dataset.sourceReady,
        native: (await window.hibi?.getDocument?.())?.markdown?.slice(0, 120),
      }
    })
    throw new Error(`Benchmark input did not land: ${JSON.stringify(state)}`, {
      cause: error,
    })
  }
}

export function selectBenchmarkFile(app, file) {
  return app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
}

export async function openBenchmarkDocument(app, page, title) {
  await clickMenu(app, 'Open…')
  await page.waitForFunction(
    (title) =>
      [...document.querySelectorAll('.tiptap h1')].some(
        (heading) => heading.textContent === title,
      ),
    title,
  )
}

export async function switchToSource(app, page) {
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+]`,
  )
  await page.waitForFunction(() => {
    const pane = document.querySelector('.source-pane')
    const editor = pane?.querySelector('.cm-content')
    return (
      editor?.isContentEditable &&
      !editor.closest('[inert]') &&
      document.querySelector('.editor-panes')?.dataset.sourceReady === 'true' &&
      getComputedStyle(pane).visibility === 'visible' &&
      Number(getComputedStyle(pane).opacity) === 1 &&
      Number(getComputedStyle(pane.parentElement).opacity) === 1
    )
  })
}
