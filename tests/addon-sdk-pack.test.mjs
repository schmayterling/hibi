import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = join(root, 'packages/addon-sdk')
const tsc = join(root, 'node_modules/typescript/bin/tsc')

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  )
  return result.stdout
}

test('packed addon sdk checks external consumers and installs compiled addon', {
  timeout: 60000,
}, async () => {
  const out = join(root, 'out')
  await mkdir(out, { recursive: true })
  const scratch = await mkdtemp(join(out, 'addon-sdk-pack-'))
  let app
  try {
    const pack = JSON.parse(
      run('npm', ['pack', '--json', '--pack-destination', scratch, sdk], root),
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
        join(scratch, pack.filename),
        '-C',
        packageDir,
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

    const fixtures = {
      'command.ts': `import type { AddonManifest, CapabilityFactory } from '@hibi/addon-sdk'
export const manifest = { id: 'command-proof', name: 'Command proof', description: 'Command proof.', version: '1.0.0', apiVersion: 2, capabilities: [], activation: 'command', commands: [{ id: 'greet', label: 'Greet' }] } satisfies AddonManifest
const create: CapabilityFactory = () => ({ start(context) { context.commands.register({ id: 'greet', label: 'Greet', run: () => context.notify('Hello.') }) } })
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

    const installable = join(scratch, 'installable')
    await mkdir(installable)
    await writeFile(
      join(installable, 'hibi-addon.json'),
      JSON.stringify({
        id: 'command-proof',
        name: 'Command proof',
        description: 'Compiled against the packed SDK.',
        version: '1.0.0',
        apiVersion: 2,
        kind: 'extension',
        capabilities: [],
        activation: 'command',
        commands: [{ id: 'greet', label: 'Greet' }],
        authors: [{ displayName: 'Hibi tests' }],
        entry: 'index.js',
      }),
    )
    await writeFile(join(installable, 'README.md'), '# Command proof\n')
    await copyFile(
      join(consumer, 'compiled/command.js'),
      join(installable, 'index.js'),
    )
    const { electron } = await import('./electron.mjs')
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
    await page.getByRole('textbox', { name: /document editor/i }).waitFor()
    await page.evaluate(() => window.hibi.installAddon())
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
      await readFile(join(consumer, 'compiled/command.js'), 'utf8'),
    )
  } finally {
    if (app) await app.close()
    await rm(scratch, { recursive: true, force: true })
  }
})
