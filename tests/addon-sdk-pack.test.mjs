import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = join(root, 'packages/addon-sdk')
const tsc = join(root, 'node_modules/typescript/bin/tsc')
const npmCli =
  process.env.npm_execpath ??
  resolve(
    dirname(process.execPath),
    process.platform === 'win32' ? 'node_modules' : '../lib/node_modules',
    'npm/bin/npm-cli.js',
  )

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })
  assert.equal(
    result.status,
    0,
    [
      `${command} ${args.join(' ')}`,
      result.error?.message,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join('\n'),
  )
  return result.stdout
}

function createStarter(scratch) {
  const installable = join(scratch, 'command-proof')
  run(
    process.execPath,
    [
      join(root, 'packages/create-hibi-addon/index.mjs'),
      installable,
      '--name',
      'Command proof',
      '--author',
      'Hibi tests',
    ],
    root,
  )
  return installable
}

test('command failures report spawn errors', () => {
  assert.throws(
    () => run(join(root, 'missing-sdk-pack-command'), [], root),
    /ENOENT/,
  )
})

test('packed addon sdk checks external consumers', {
  timeout: 60000,
}, async () => {
  const out = join(root, 'out')
  await mkdir(out, { recursive: true })
  const scratch = await mkdtemp(join(out, 'addon-sdk-pack-'))
  try {
    const pack = JSON.parse(
      run(
        process.execPath,
        [npmCli, 'pack', '--json', '--pack-destination', scratch, sdk],
        root,
      ),
    )[0]
    const files = pack.files.map((file) => file.path)
    assert(files.includes('types/index.d.ts'))
    assert(files.includes('LICENSE.md'))
    for (const entry of ['api', 'sdk', 'sdk-loader'])
      assert(files.includes(`dist/src/addons/${entry}.d.ts`))
    assert(files.some((file) => file.startsWith('dist/src/shared/')))
    assert(
      files.every(
        (file) =>
          file.endsWith('.d.ts') ||
          ['package.json', 'README.md', 'LICENSE.md'].includes(file),
      ),
    )

    const consumer = join(scratch, 'consumer')
    const packageDir = join(consumer, 'node_modules/@hibi/addon-sdk')
    await mkdir(packageDir, { recursive: true })
    run(
      'tar',
      [
        '-xzf',
        relative(root, join(scratch, pack.filename)).replaceAll('\\', '/'),
        '-C',
        relative(root, packageDir).replaceAll('\\', '/'),
        '--strip-components=1',
      ],
      root,
    )
    const metadata = JSON.parse(
      await readFile(join(packageDir, 'package.json'), 'utf8'),
    )
    assert.deepEqual(
      await readFile(join(packageDir, 'LICENSE.md')),
      await readFile(join(root, 'LICENSE.md')),
    )
    assert.equal(metadata.hibiAddonApiVersion, 2)
    assert(
      Object.values(metadata.exports).every(
        (entry) => Object.keys(entry).join() === 'types',
      ),
    )

    const installable = createStarter(scratch)
    run(process.execPath, [npmCli, 'run', 'check'], installable)
    const { entry, ...manifest } = JSON.parse(
      await readFile(join(installable, 'hibi-addon.json'), 'utf8'),
    )
    const source = await readFile(join(installable, entry), 'utf8')
    const fixtures = {
      'command.ts': `import type { AddonManifest, CapabilityFactory } from '@hibi/addon-sdk'
export const manifest = ${JSON.stringify(manifest)} satisfies AddonManifest
const create: CapabilityFactory = ${source.replace(/^export default /, '')}
export default create
`,
      'ui.ts': `import type { CapabilityFactory } from '@hibi/addon-sdk/sdk-loader'
const create: CapabilityFactory = (sdk) => ({ start(context) { if (!sdk.React || !sdk.ui) throw Error('ui unavailable'); const Button = sdk.ui.Button; context.notify(String(sdk.React.createElement(Button, { children: 'Hello' }).type)) } })
export default create
`,
      'source.ts': `import type { SourceExtension } from '@hibi/addon-sdk/api'
import type { CapabilityFactory } from '@hibi/addon-sdk/sdk-loader'
const create: CapabilityFactory = (sdk) => ({ start(context) { if (!sdk.codeMirror) throw Error('source unavailable'); const extension: SourceExtension = { id: 'source-proof', create: () => sdk.codeMirror!.state.StateField.define({ create: () => 0, update: (value) => value }) }; context.editor.registerSource(extension) } })
export default create
`,
      'rich.ts': `import type { RichExtension } from '@hibi/addon-sdk/api'
import type { CapabilityFactory } from '@hibi/addon-sdk/sdk-loader'
const create: CapabilityFactory = (sdk) => ({ start(context) { if (!sdk.tiptap) throw Error('rich unavailable'); const rich: RichExtension = { id: 'rich-proof', attach(editor) { editor.commands.focus(); return () => {} } }; sdk.tiptap.Extension.create({ name: 'rich-proof' }); context.editor.registerRich(rich) } })
export default create
`,
      'legacy.ts': `import type { SideloadFactory } from '@hibi/addon-sdk/sdk'
const create: SideloadFactory = (sdk) => ({ start(context) { context.notify(String(Boolean(sdk.React))) } })
export default create
`,
    }
    for (const [name, source] of Object.entries(fixtures))
      await writeFile(join(consumer, name), source)
    const config = join(consumer, 'tsconfig.json')
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
          strict: true,
          exactOptionalPropertyTypes: true,
          verbatimModuleSyntax: true,
          skipLibCheck: false,
          noUncheckedSideEffectImports: true,
          types: [],
          rootDir: consumer,
          outDir: join(consumer, 'compiled'),
        },
        files: Object.keys(fixtures).map((name) => join(consumer, name)),
      }),
    )
    const checked = run(
      process.execPath,
      [tsc, '-p', config, '--listFiles'],
      consumer,
    )
    assert(
      !checked.split('\n').some((file) => file.startsWith(join(root, 'src/'))),
    )
    for (const name of Object.keys(fixtures)) {
      const javascript = await readFile(
        join(consumer, 'compiled', name.replace(/\.ts$/, '.js')),
        'utf8',
      )
      assert.doesNotMatch(
        javascript,
        /(?:from\s*|import\s*\(|require\s*\()['"](?:@hibi\/addon-sdk|react|@tiptap\/|@codemirror\/|marked)/,
      )
    }
    const runtime = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import('@hibi/addon-sdk').then(() => { process.exitCode = 1 }, error => { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') process.exitCode = 1 })",
      ],
      { cwd: consumer, encoding: 'utf8' },
    )
    assert.equal(runtime.status, 0, runtime.stderr)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('generated addon installs, enables, runs, disables, and re-enables', {
  timeout: 60000,
}, async () => {
  const out = join(root, 'out')
  await mkdir(out, { recursive: true })
  const scratch = await mkdtemp(join(out, 'addon-lifecycle-'))
  let app
  try {
    const installable = createStarter(scratch)
    const source = await readFile(join(installable, 'index.js'), 'utf8')
    const { electron, waitForDocumentEditor } = await import('./electron.mjs')
    const profile = join(scratch, 'profile')
    app = await electron.launch({
      args: [root, `--user-data-dir=${profile}`],
    })
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [source],
      })
      dialog.showMessageBox = async () => ({ response: 1 })
    }, installable)
    const page = await app.firstWindow()
    await waitForDocumentEditor(app, page)
    await clickMenu(app, 'Command palette')
    await page
      .getByRole('combobox', { name: /search commands/i })
      .fill('Install addon')
    await page.getByRole('option', { name: /^Install addon/ }).press('Enter')
    await waitForAsync(page, async () =>
      (await window.hibi.getInstalledAddons()).some(
        ({ manifest }) => manifest.id === 'command-proof',
      ),
    )
    const installed = await page.evaluate(() =>
      window.hibi.getInstalledAddons(),
    )
    assert(installed.some(({ manifest }) => manifest.id === 'command-proof'))
    const states = await page.evaluate(() => window.hibi.getAddonStates())
    assert(states.some(({ id, enabled }) => id === 'command-proof' && !enabled))
    assert.equal(
      await readFile(
        join(profile, 'installed-addons/command-proof/index.js'),
        'utf8',
      ),
      source,
    )
    const greeting = page.getByText('Hello from Command proof.', {
      exact: true,
    })
    for (const enabled of [true, false, true, false]) {
      await clickMenu(app, 'Settings')
      await page
        .getByRole('tab', { name: 'Addon Manager', exact: true })
        .click()
      await page.locator('#addon-command-proof').setChecked(enabled)
      await waitForAsync(
        page,
        async (enabled) =>
          (await window.hibi.getAddonStates()).find(
            ({ id }) => id === 'command-proof',
          )?.enabled === enabled,
        enabled,
      )
      await page
        .getByRole('button', { name: 'Back to app', exact: true })
        .click()
      await clickMenu(app, 'Command palette')
      await page
        .getByRole('combobox', { name: /search commands/i })
        .fill('Say hello')
      const command = page.getByRole('option', { name: /^Say hello/i })
      if (enabled) {
        await command.waitFor()
        assert.equal(await command.count(), 1)
        await command.press('Enter')
        await greeting.waitFor()
      } else {
        await greeting.waitFor({ state: 'hidden' })
        await command.waitFor({ state: 'hidden' })
        await page.keyboard.press('Escape')
      }
    }
  } catch (error) {
    console.error('generated addon lifecycle:', error)
    throw error
  } finally {
    if (app) await app.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
