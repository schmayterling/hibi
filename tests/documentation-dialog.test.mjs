import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

test('export dialog opens while defaults load without reading document text', async () => {
  const path = 'src/addons/documentation/index.tsx'
  const contents = process.env.HIBI_EXPORT_TEST_REVISION
    ? execFileSync(
        'git',
        ['show', process.env.HIBI_EXPORT_TEST_REVISION + ':' + path],
        { encoding: 'utf8' },
      )
    : await readFile(path, 'utf8')
  const bundle = await build({
    stdin: {
      contents,
      loader: 'tsx',
      resolveDir: resolve('src/addons/documentation'),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    plugins: [
      {
        name: 'dialog-test',
        setup(build) {
          build.onResolve(
            { filter: /^(\.\.\/api|\.\/ExportDialog)$/ },
            ({ path }) => ({ path, namespace: 'stub' }),
          )
          build.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({
            contents:
              path === '../api'
                ? 'export const defineAddon = value => value'
                : 'export const ExportDialog = () => null; export const LoadingExportDialog = () => null',
          }))
        },
      },
    ],
  })
  const addon = (
    await import(
      'data:text/javascript;base64,' +
        Buffer.from(bundle.outputFiles[0].text).toString('base64')
    )
  ).default
  let command,
    opened = false,
    reads = 0,
    finishDefaults
  const defaults = new Promise((resolve) => {
    finishDefaults = resolve
  })
  const workspace = {
    id: 'notes',
    workspaceGeneration: 1,
    name: 'notes',
    entries: [{ path: 'note.md', kind: 'file', name: 'note.md' }],
  }
  addon.start({
    workspace: {
      get: async () => workspace,
      index: async () => {
        reads++
        return { workspace, pages: [{ path: 'note.md', markdown: 'private' }] }
      },
      snapshot: async () => {
        reads++
        return { name: 'notes', pages: [] }
      },
    },
    commands: {
      register: (value) => {
        command = value
      },
    },
    exports: { provide() {} },
    native: { query: () => defaults },
    dialogs: {
      open: () => {
        opened = true
        return { result: Promise.resolve() }
      },
    },
    storage: {
      workspace: async () => ({ snapshot: () => ({ status: 'missing' }) }),
    },
    colorschemes: {
      getPreferences: () => ({
        mode: 'system',
        light: 'hibi-light',
        dark: 'hibi-dark',
      }),
      list: () => [],
    },
  })
  globalThis.localStorage = { getItem: () => null }
  const running = command.run()
  await new Promise(setImmediate)
  try {
    assert.equal(reads, 0, 'options must not read the text index or snapshot')
    assert.equal(
      opened,
      true,
      'options must open before native defaults resolve',
    )
  } finally {
    finishDefaults({ graph: false, pages: [{ path: 'note.md' }] })
    await running
    delete globalThis.localStorage
  }
})
