import { spawnSync } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratchParent = join(root, 'out')
await mkdir(scratchParent, { recursive: true })
const scratch = await mkdtemp(join(scratchParent, 'addon-declarations-'))
const declarations = join(scratch, 'declarations')
const tsc = join(root, 'node_modules/typescript/bin/tsc')
const typescriptVersion = JSON.parse(
  await readFile(join(root, 'node_modules/typescript/package.json'), 'utf8'),
).version
console.log(
  `runtime: node ${process.version}; typescript ${typescriptVersion}; ${process.platform} ${process.arch}`,
)

function check(label, config, args = []) {
  const start = performance.now()
  const result = spawnSync(process.execPath, [tsc, '-p', config, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) {
    process.stderr.write(`${label} failed:\n${output}`)
    throw new Error(`${label} exited with ${result.status ?? result.error}`)
  }
  const diagnostics = output
    .split('\n')
    .filter((line) =>
      /^(Files|Lines of Definitions|Memory used|Check time|Emit time|Total time):/.test(
        line,
      ),
    )
    .map((line) => line.trim())
  console.log(
    `${label}: ${(performance.now() - start).toFixed(0)} ms wall; ${diagnostics.join('; ')}`,
  )
  return output
}

async function declarationSize(directory) {
  let files = 0
  let bytes = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const child = await declarationSize(path)
      files += child.files
      bytes += child.bytes
    } else if (entry.name.endsWith('.d.ts')) {
      files++
      bytes += (await stat(path)).size
    }
  }
  return { files, bytes }
}

try {
  const sourceConfig = join(scratch, 'source.json')
  await writeFile(
    sourceConfig,
    JSON.stringify({
      extends: join(root, 'tsconfig.web.json'),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        skipLibCheck: false,
        incremental: true,
        tsBuildInfoFile: join(scratch, 'source.tsbuildinfo'),
        rootDir: root,
        outDir: declarations,
        extendedDiagnostics: true,
      },
      files: [
        join(root, 'src/addons/api.ts'),
        join(root, 'src/addons/sdk.ts'),
        join(root, 'src/addons/sdk-loader.ts'),
      ],
      include: [],
    }),
  )
  check('declarations clean', sourceConfig)
  check('declarations incremental', sourceConfig)

  const total = await declarationSize(declarations)
  const entries = ['api', 'sdk', 'sdk-loader']
  let publicBytes = 0
  for (const entry of entries)
    publicBytes += (
      await stat(join(declarations, 'src/addons', `${entry}.d.ts`))
    ).size
  console.log(
    `declarations: ${total.files} files, ${total.bytes} bytes closure; ${publicBytes} bytes public entries`,
  )

  const consumer = join(declarations, 'src/addons/consumer.ts')
  await copyFile(
    join(root, 'scripts/fixtures/foundation-addon-consumer.ts'),
    consumer,
  )
  const cssTypes = join(declarations, 'src/addons/css.d.ts')
  await copyFile(join(root, 'scripts/fixtures/addon-css.d.ts'), cssTypes)
  const consumerConfig = join(scratch, 'consumer.json')
  await writeFile(
    consumerConfig,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        jsx: 'react-jsx',
        strict: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
        skipLibCheck: false,
        noUncheckedSideEffectImports: true,
        noEmit: true,
        types: [],
        extendedDiagnostics: true,
      },
      files: [consumer, cssTypes],
    }),
  )
  const consumerOutput = check(
    'standalone declaration consumer',
    consumerConfig,
    ['--listFiles'],
  )
  if (
    consumerOutput
      .split('\n')
      .some((line) => line.startsWith(join(root, 'src/')))
  )
    throw new Error('consumer loaded application source')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
