import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { electron } from '../tests/electron.mjs'
import { clickMenu, pressShortcut } from '../tests/keyboard.mjs'

export async function writeInputProfile(profile, enabledAddons, analysisLoad) {
  const addons = Object.fromEntries(
    [...enabledAddons, ...(analysisLoad ? ['analysis-load'] : [])].map((id) => [
      id,
      true,
    ]),
  )
  if (Object.keys(addons).length)
    await writeFile(join(profile, 'addons.json'), JSON.stringify(addons))
  if (analysisLoad) {
    const addon = join(profile, 'installed-addons', 'analysis-load')
    await mkdir(addon, { recursive: true })
    await writeFile(
      join(addon, 'hibi-addon.json'),
      JSON.stringify({
        id: 'analysis-load',
        name: 'Analysis benchmark',
        description: 'Benchmark-only analysis load',
        kind: 'extension',
        apiVersion: 2,
        version: '1.0.0',
        authors: [{ displayName: 'Hibi benchmark' }],
        capabilities: [],
        entry: 'index.js',
        analysis: { entry: 'analysis.js' },
      }),
    )
    await writeFile(
      join(addon, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: ['index.js', 'analysis.js', 'hibi-addon.json'],
        source: 'local',
      }),
    )
    await writeFile(
      join(addon, 'index.js'),
      'export default () => ({start(context) { window.__hibiAnalysisBenchmark = context; }})',
    )
    await writeFile(
      join(addon, 'analysis.js'),
      'export function analyze() { const end = performance.now() + 2000; while (performance.now() < end) {} return null; }',
    )
  }
  return addons
}

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

export function benchmarkEngine(engine) {
  assert.ok(
    ['tiptap', 'codemirror'].includes(engine),
    'unknown benchmark engine',
  )
  return engine
}

// seed only storage at the app origin: no app modules or editor caches are loaded.
export async function seedBenchmarkProfile(profile, engine) {
  benchmarkEngine(engine)
  const entry = join(profile, 'benchmark-profile.cjs')
  await writeFile(
    entry,
    `const {app, BrowserWindow, protocol} = require('electron');
app.setPath('userData', app.commandLine.getSwitchValue('user-data-dir'));
if (process.platform === 'darwin') app.setActivationPolicy('accessory');
protocol.registerSchemesAsPrivileged([{scheme:'app', privileges:{standard:true, secure:true}}]);
app.whenReady().then(async () => {
  protocol.handle('app', () => new Response('<!doctype html><title>profile seed</title>', {headers:{'content-type':'text/html'}}));
  const win = new BrowserWindow({show:false, webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false}});
  await win.loadURL('app://hibi/');
});
app.on('window-all-closed', () => app.quit());`,
  )
  const app = await launchBenchmarkApp(profile, entry)
  try {
    const page = await app.firstWindow()
    await page.waitForURL('app://hibi/', { waitUntil: 'load' })
    await page.evaluate((engine) => {
      localStorage.setItem('hibi:formatted-engine', engine)
      localStorage.setItem('default-view', 'normal')
    }, engine)
    await app.evaluate(({ session }) =>
      session.defaultSession.flushStorageData(),
    )
  } finally {
    await app.close()
  }
}

const hash = (source) => createHash('sha256').update(source).digest('hex')

async function fileHashes(paths, root) {
  const result = {}
  for (const path of paths.sort())
    result[path] = hash(await readFile(join(root, path)))
  return result
}

async function treeFiles(path, root) {
  return (
    await readdir(join(root, path), { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
}

export async function benchmarkProvenance(sampler, root = '.') {
  root = resolve(root)
  const rendererFiles = await fileHashes(
    await treeFiles('out/renderer', root),
    root,
  )
  const buildFiles = {
    ...(await fileHashes(await treeFiles('out/main', root), root)),
    ...(await fileHashes(await treeFiles('out/preload', root), root)),
    ...rendererFiles,
  }
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  return {
    revision: git(['rev-parse', 'HEAD']),
    gitStatus: git(['status', '--porcelain']),
    sourceHash: hash(
      JSON.stringify(
        await fileHashes(
          [
            ...(await treeFiles('src', root)),
            'electron.vite.config.ts',
            'package.json',
          ],
          root,
        ),
      ),
    ),
    samplerHash: hash(await readFile(sampler)),
    helperHashes: await fileHashes(
      [
        'scripts/benchmark-flows.mjs',
        'scripts/trace-stream.mjs',
        'tests/electron.mjs',
        'tests/keyboard.mjs',
      ],
      root,
    ),
    rendererBuildHash: hash(JSON.stringify(rendererFiles)),
    rendererFiles,
    buildHash: hash(JSON.stringify(buildFiles)),
    buildFiles,
    lockfileHash: hash(await readFile(join(root, 'package-lock.json'))),
  }
}

// Frame polling avoids locator retry backoff being counted as startup latency.
export function waitForEditor(page, engine) {
  return page.waitForFunction((engine) => {
    const editor = document.querySelector(
      '[role="textbox"][aria-label="Document editor"]',
    )
    const observed = editor?.classList.contains('tiptap')
      ? 'tiptap'
      : editor?.closest('.hibi-formatted')
        ? 'codemirror'
        : null
    return (
      !!editor?.isContentEditable &&
      editor.getAttribute('aria-readonly') !== 'true' &&
      !editor.closest('[inert]') &&
      editor.getBoundingClientRect().width > 0 &&
      (!engine ||
        (observed === engine &&
          document.querySelector('.app')?.getAttribute('aria-busy') ===
            'false' &&
          document
            .querySelector('#document-editor-panel')
            ?.getAttribute('aria-busy') === 'false' &&
          (observed !== 'codemirror' ||
            document.querySelector('.editor-panes')?.dataset.sourceReady ===
              'true')))
    )
  }, engine)
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
        editorTextLength: document.querySelector(
          '[role="textbox"][aria-label="Document editor"]',
        )?.textContent.length,
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
  return page.waitForFunction(
    (title) =>
      [
        ...document.querySelectorAll(
          '.rich-pane h1, .rich-pane [role="heading"][aria-level="1"]',
        ),
      ].some(
        (heading) =>
          (heading.getAttribute('aria-label') ?? heading.textContent) === title,
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
