import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

const patched = {
  'patch-vim.mjs': '@replit/codemirror-vim-core',
  'patch-codemirror-view.mjs': '@codemirror/view',
  'patch-electron-vite.mjs': 'electron-vite',
  'patch-electron-notarize.mjs': '@electron/notarize',
}

/** A package whose only file is `index.js`. */
function install(modules, name) {
  const folder = join(modules, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, 'package.json'),
    JSON.stringify({
      name,
      version: '6.0.0',
      type: 'module',
      exports: { '.': './index.js', './package.json': './package.json' },
    }),
  )
  writeFileSync(join(folder, 'index.js'), 'export {}\n')
  return join(folder, 'index.js')
}

const run = (file, env = {}) => {
  const environment = { ...process.env, ...env }
  if (!env.NODE_ENV) delete environment.NODE_ENV
  return spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    env: environment,
  })
}

test('dependency patches refuse chunks linked outside the project', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hibi-patch-chunks-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'worktree')
  cpSync(resolve('scripts'), join(project, 'scripts'), { recursive: true })
  const installed = join(project, 'node_modules', 'electron-vite')
  cpSync(resolve('node_modules/electron-vite'), installed, {
    recursive: true,
    dereference: true,
  })
  const chunks = join(installed, 'dist', 'chunks')
  const outside = join(root, 'chunks')
  renameSync(chunks, outside)
  symlinkSync(outside, chunks, 'junction')
  const file = join(outside, 'lib-CLhLGLN3.js')
  const patched = readFileSync(file, 'utf8')
  const before = patched.replace(
    '        let ps;\n        let restarting;\n',
    '        let ps;\n',
  )
  assert.notEqual(before, patched)
  writeFileSync(file, before)
  const result = run(join(project, 'scripts', 'patch-electron-vite.mjs'))
  assert.ok(readFileSync(file, 'utf8') === before, 'outside chunk was changed')
  assert.equal(result.status, 1, result.stderr)
})

test('dependency patches never patch a copy above the project', (t) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'hibi-dependency-patches-')),
  )
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // A worktree nested in a checkout, without packages of its own.
  const above = Object.values(patched).map((name) =>
    install(join(root, 'node_modules'), name),
  )
  const project = join(root, 'worktree')
  cpSync(resolve('scripts'), join(project, 'scripts'), { recursive: true })
  for (const [script, name] of Object.entries(patched)) {
    const file = join(project, 'scripts', script)
    const missing = run(file)
    assert.equal(missing.status, 1, `${script}: ${missing.stderr}`)
    assert.ok(
      missing.stderr.includes(
        `${name} is not installed in ${join(project, 'node_modules')}.`,
      ),
      `${script}: ${missing.stderr}`,
    )
    // Production installs leave out the development packages the scripts patch.
    const production = run(file, { NODE_ENV: 'production' })
    assert.equal(production.status, 0, `${script}: ${production.stderr}`)
  }
  for (const file of above)
    assert.equal(readFileSync(file, 'utf8'), 'export {}\n')

  // The project's own packages may be a link to another install.
  const shared = join(root, 'shared', 'node_modules')
  const own = install(shared, '@codemirror/view')
  symlinkSync(shared, join(project, 'node_modules'), 'junction')
  const helper = pathToFileURL(join(project, 'scripts', 'resolve-own.mjs'))
  const found = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { resolveOwn } from ${JSON.stringify(helper.href)}
console.log(resolveOwn('@codemirror/view'))`,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(found.stdout.trim(), realpathSync(own), found.stderr)
})

for (const [name, shift, flags] of [
  ['shrink after a viewport change', -168.328125, 2 | 4],
  ['grow after a viewport change', 168.328125, 2 | 4],
  ['shrink in the same viewport', -168.328125, 2],
]) {
  test(`codemirror anchors heights that ${name}, even when the next pass is quiet`, (t) => {
    globalThis.Window = class {}
    t.after(() => {
      delete globalThis.Window
    })
    const pane = { scrollTop: 500, scrollHeight: 4000, clientHeight: 560 }
    let top = 400,
      changed = true
    const view = {
      state: EditorState.create({ doc: 'above\nline' }),
      destroyed: false,
      measureScheduled: -1,
      measureRequests: [],
      scrollDOM: pane,
      observer: { forceFlush() {} },
      inputState: { update() {} },
      updatePlugins() {},
      updateAttrs() {},
      docView: { update: () => false },
      viewState: {
        scrollParent: pane,
        scrollOffset: pane.scrollTop,
        scrollAnchorPos: 6,
        scrollAnchorHeight: top,
        scaleY: 1,
        editorHeight: pane.clientHeight,
        scrollTarget: null,
        getScrollOffset: () => pane.scrollTop,
        scrollAnchorAt: () => ({ from: 6, top }),
        lineBlockAt: () => ({ from: 6, top }),
        measure() {
          this.scrollOffset = pane.scrollTop
          if (!changed) return 0
          changed = false
          top += shift
          return flags // Height = 2; Viewport = 4.
        },
      },
    }
    const before = top - pane.scrollTop
    EditorView.prototype.measure.call(view)
    assert.equal(top - pane.scrollTop, before)
    assert.equal(view.measureScheduled, -1)
  })
}

test('codemirror draws what its last pass measured when the measure loop gives up', (t) => {
  globalThis.Window = class {}
  t.after(() => {
    delete globalThis.Window
  })
  const warn = t.mock.method(console, 'warn')
  const pane = { scrollTop: 0, scrollHeight: 4000, clientHeight: 560 }
  let measured = 0,
    drawn = 0
  const view = {
    state: EditorState.create({ doc: 'line' }),
    destroyed: false,
    measureScheduled: -1,
    measureRequests: [],
    scrollDOM: pane,
    observer: { forceFlush() {} },
    inputState: { update() {} },
    updatePlugins() {},
    updateAttrs() {},
    docView: {
      update() {
        drawn = measured
        return false
      },
    },
    viewState: {
      scrollParent: pane,
      scrollOffset: 0,
      scrollAnchorPos: 0,
      scrollAnchorHeight: 0,
      scaleY: 1,
      editorHeight: pane.clientHeight,
      scrollTarget: null,
      getScrollOffset: () => pane.scrollTop,
      scrollAnchorAt: () => ({ from: 0, top: 0 }),
      lineBlockAt: () => ({ from: 0, top: 0 }),
      // Each pass names other text to draw, as a long line's moving gaps do.
      measure() {
        if (++measured > 20) throw new Error('the measure loop did not stop')
        return 4 // Viewport.
      },
    },
  }
  EditorView.prototype.measure.call(view)
  assert.equal(measured, 7)
  assert.equal(drawn, measured)
  assert.equal(warn.mock.callCount(), 1)
  assert.equal(view.measureScheduled, -1)
})
