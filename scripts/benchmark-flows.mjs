import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
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

// seed chromium storage identically for every condition, without app modules.
export async function seedBenchmarkProfile(profile, engine) {
  benchmarkEngine(engine)
  const entry = join(profile, 'benchmark-profile.cjs')
  await writeFile(
    entry,
    `const {app, BrowserWindow, protocol} = require('electron');
app.disableHardwareAcceleration();
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
  const files = {}
  for (const path of (await treeFiles('.', profile)).sort()) {
    const content = await readFile(join(profile, path))
    files[path] = { bytes: content.length, sha256: hash(content) }
  }
  return { method: 'chromium-storage-only', hardwareAcceleration: false, files }
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
    .map((entry) =>
      relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'),
    )
}

export async function benchmarkSourceHash(root) {
  return hash(
    JSON.stringify(
      await fileHashes(
        [
          ...(await treeFiles('src', root)),
          ...(await treeFiles('scripts', root)),
          'electron.vite.config.ts',
          'package.json',
          'package-lock.json',
          ...((await readdir(root)).includes('docs-revision')
            ? ['docs-revision']
            : []),
        ],
        root,
      ),
    ),
  )
}

export async function benchmarkBuild(root) {
  const buildFiles = await fileHashes(
    (await treeFiles('out', root)).filter(
      (path) => path !== 'out/benchmark-build.json',
    ),
    root,
  )
  const rendererFiles = Object.fromEntries(
    Object.entries(buildFiles).filter(([path]) =>
      path.startsWith('out/renderer/'),
    ),
  )
  return {
    sourceHash: await benchmarkSourceHash(root),
    rendererBuildHash: hash(JSON.stringify(rendererFiles)),
    rendererFiles,
    buildHash: hash(JSON.stringify(buildFiles)),
    buildFiles,
  }
}

export async function benchmarkProvenance(
  sampler,
  root = '.',
  requireBuildManifest = false,
) {
  root = resolve(root)
  const build = await benchmarkBuild(root)
  const manifest = await readFile(
    join(root, 'out/benchmark-build.json'),
    'utf8',
  ).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  assert.ok(
    !requireBuildManifest || manifest !== null,
    'benchmark build manifest missing; run npm run bench:build',
  )
  const buildManifest = manifest === null ? null : JSON.parse(manifest)
  if (manifest !== null) {
    assert.equal(
      buildManifest.status,
      'complete',
      'incomplete build; run npm run bench:build',
    )
    assert.equal(
      buildManifest.sourceHash,
      build.sourceHash,
      'stale build: source changed; run npm run bench:build',
    )
    assert.equal(
      buildManifest.buildHash,
      build.buildHash,
      'stale build: output changed; run npm run bench:build',
    )
  }
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  return {
    revision: git(['rev-parse', 'HEAD']),
    gitStatus: [
      git(['status', '--porcelain']),
      git([
        'status',
        '--porcelain',
        '--ignored',
        '--untracked-files=all',
        '--',
        'src/useraddons',
      ]),
    ]
      .filter(Boolean)
      .join('\n'),
    ...build,
    buildVerified: buildManifest !== null,
    buildManifest,
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
    lockfileHash: hash(await readFile(join(root, 'package-lock.json'))),
  }
}

export async function verifyBenchmarkProvenance(before, sampler, root = '.') {
  const after = await benchmarkProvenance(sampler, root)
  assert.deepEqual(after, before, 'benchmark inputs changed during sampling')
}

// Frame polling avoids locator retry backoff being counted as startup latency.
export async function waitForEditor(page, engine) {
  const ready = (engine) => {
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
      document.fonts.status === 'loaded' &&
      (!engine ||
        (observed === engine &&
          document.querySelector('.app')?.getAttribute('aria-busy') ===
            'false' &&
          document
            .querySelector('#document-editor-panel')
            ?.getAttribute('aria-busy') === 'false'))
    )
  }
  // this playwright build does not await promises in waitForFunction.
  for (;;) {
    await page.waitForFunction(ready, engine)
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(done)),
    )
    if (await page.evaluate(ready, engine)) return true
  }
}

const focusSessions = new WeakMap()

export async function focusBenchmarkPage(page) {
  let session = focusSessions.get(page)
  if (!session) {
    session = await page.context().newCDPSession(page)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    focusSessions.set(page, session)
  }
  await page.waitForFunction(() => document.hasFocus())
  return session
}

export async function prepareBenchmarkInput(page) {
  await focusBenchmarkPage(page)
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .focus()
  await page.waitForFunction(
    () =>
      document.hasFocus() &&
      document.activeElement ===
        document.querySelector(
          '[role="textbox"][aria-label="Document editor"]',
        ),
  )
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  )
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
  await page.waitForFunction(
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
