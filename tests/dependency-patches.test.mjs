import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

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
