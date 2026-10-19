import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import config from '../scripts/file-associations.cjs'
import {
  DESKTOP_APP_ID,
  fileAssociations,
} from '../src/shared/file-associations.ts'

// Exercise production adapters with process launches stubbed; never change host defaults.
async function adapter(t, platform) {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-associations-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const resources = join(temp, 'resources')
  await mkdir(join(resources, 'icons'), { recursive: true })
  await writeFile(join(resources, 'icons/icon-linux.png'), 'test icon')
  const output = join(temp, 'adapter.mjs')
  await build({
    stdin: {
      contents:
        "export * from './src/main/file-associations.ts'; export { app, state } from 'electron'",
      resolveDir: resolve('.'),
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: {
      'process.platform': JSON.stringify(platform),
      'process.resourcesPath': JSON.stringify(resources),
      'process.env.XDG_DATA_HOME': JSON.stringify(temp),
      'process.env.APPIMAGE': JSON.stringify(join(temp, 'Hibi $100%.AppImage')),
    },
    plugins: [
      {
        name: 'isolated-os',
        setup(build) {
          build.onResolve(
            { filter: /^(electron|node:child_process|\.\/addons)$/ },
            ({ path }) => ({ path, namespace: 'mock' }),
          )
          build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
            contents:
              path === 'electron'
                ? `export const app = { isPackaged: true }; export const state = { calls: [], urls: [], defaults: [], disabled: [] }; export const shell = { openExternal: async url => { state.urls.push(url) } };`
                : path === './addons'
                  ? `import { state } from 'electron'; export const getAddonStates = () => ${JSON.stringify(Object.keys(fileAssociations))}.map(id => ({ id, enabled: !state.disabled.includes(id) }));`
                  : `import { promisify } from 'node:util'; import { state } from 'electron';
export const execFile = () => {};
execFile[promisify.custom] = async (file, args) => {
  state.calls.push([file, args]);
  if (file === '/usr/bin/osascript') {
    if (args[4] === 'set') state.defaults.push(...args.slice(6));
    return { stdout: JSON.stringify(state.defaults) };
  }
  if (file === 'xdg-mime' && args[0] === 'default') state.defaults.push(args[2]);
  return { stdout: file === 'xdg-mime' && args[0] === 'query' && state.defaults.includes(args[2]) ? '${DESKTOP_APP_ID}.desktop' : '' };
};`,
          }))
        },
      },
    ],
  })
  return { ...(await import(pathToFileURL(output).href)), temp }
}

test('installer metadata covers every bundled extension without taking defaults', async () => {
  const expected = Object.values(fileAssociations)
    .flatMap(({ ext }) => ext)
    .sort()
  assert.deepEqual(
    config.mac.fileAssociations.flatMap(({ ext }) => ext).sort(),
    expected,
  )
  assert.ok(
    config.mac.fileAssociations.every(
      ({ role, rank }) => role === 'Editor' && rank === 'Alternate',
    ),
  )
  assert.deepEqual(
    config.linux.fileAssociations.map(({ mimeType }) => mimeType),
    Object.values(fileAssociations).map(({ mimeType }) => mimeType),
  )
  assert.equal(config.fileAssociations, undefined)
  await config.beforePack({ electronPlatformName: 'win32' })
  const nsis = await readFile(config.nsis.include, 'utf8')
  for (const ext of expected) {
    assert.ok(nsis.includes(`Software\\Classes\\.${ext}\\OpenWithProgids`))
    assert.ok(
      nsis.includes(
        `DeleteRegKey SHELL_CONTEXT "Software\\Classes\\${DESKTOP_APP_ID}.${ext}"`,
      ),
    )
    assert.ok(
      !nsis.includes(`WriteRegStr SHELL_CONTEXT "Software\\Classes\\.${ext}"`),
    )
  }
  assert.ok(nsis.includes('Software\\RegisteredApplications'))
  assert.ok(!nsis.includes('UserChoice'))
  assert.ok(
    nsis.includes(`$\\"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}$\\" $\\"%1$\\"`),
  )
})

test('development builds and disabled/unknown formats cannot change OS defaults', async (t) => {
  const api = await adapter(t, 'darwin')
  api.app.isPackaged = false
  assert.equal((await api.getFileAssociations()).available, false)
  await assert.rejects(api.setFileAssociation('markdown'), /Install Hibi/)
  api.app.isPackaged = true
  api.state.disabled.push('typst')
  await assert.rejects(api.setFileAssociation('typst'), /Enable this format/)
  await assert.rejects(
    api.setFileAssociation('__proto__'),
    /Unknown document format/,
  )
  assert.deepEqual(api.state.calls, [])
})

test('macOS applies every extension in one format and verifies defaults', async (t) => {
  const api = await adapter(t, 'darwin')
  await api.setFileAssociation('markdown')
  assert.deepEqual((await api.getFileAssociations()).defaults, [
    'md',
    'markdown',
  ])
  const [file, args] = api.state.calls[0]
  assert.equal(file, '/usr/bin/osascript')
  assert.deepEqual(args.slice(4), ['set', DESKTOP_APP_ID, 'md', 'markdown'])
  if (process.platform === 'darwin') {
    // Execute only the read path against the real public API to check the JXA bridge.
    const { stdout } = await promisify(execFile)(file, [
      ...args.slice(0, 4),
      'get',
      DESKTOP_APP_ID,
      'md',
      'typ',
      'txt',
    ])
    assert.ok(Array.isArray(JSON.parse(stdout)))
  }
})

test('Windows opens its consent UI instead of rewriting defaults', async (t) => {
  const api = await adapter(t, 'win32')
  await api.setFileAssociation('text')
  assert.deepEqual(api.state.urls, [
    `ms-settings:defaultapps?registeredAppUser=${DESKTOP_APP_ID}`,
  ])
  assert.equal((await api.getFileAssociations()).systemSettings, true)
  assert.deepEqual(api.state.calls, [])
})

test('Linux registers a quoted persistent launcher and changes only the selected MIME default', async (t) => {
  const api = await adapter(t, 'linux')
  await api.setFileAssociation('html')
  const desktop = await readFile(
    join(api.temp, `applications/${DESKTOP_APP_ID}.desktop`),
    'utf8',
  )
  assert.ok(desktop.includes('Hibi \\\\$100%%.AppImage" %F'))
  assert.ok(desktop.includes('MimeType=text/plain;text/markdown;'))
  assert.deepEqual(api.state.defaults, ['text/html'])
  assert.deepEqual((await api.getFileAssociations()).defaults, ['html', 'htm'])
  assert.throws(
    () => api.desktopExec('/tmp/app\nExec=bad'),
    /Invalid application path/,
  )
  const xml = await readFile(
    join(api.temp, `mime/packages/${DESKTOP_APP_ID}.xml`),
    'utf8',
  )
  assert.ok(xml.includes('<glob pattern="*.typ"/>'))
  assert.ok(
    !xml.includes(
      '<mime-type type="text/plain"><comment>Plain text document</comment><sub-class-of type="text/plain"/>',
    ),
  )
})

test('Flatpak cannot report sandbox-only defaults as host defaults', async (t) => {
  const api = await adapter(t, 'linux')
  process.env.FLATPAK_ID = DESKTOP_APP_ID
  t.after(() => delete process.env.FLATPAK_ID)
  assert.equal((await api.getFileAssociations()).available, false)
  await assert.rejects(api.setFileAssociation('html'), /Open With/)
  assert.deepEqual(api.state.calls, [])
})
