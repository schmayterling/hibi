import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = join(root, 'packages/addon-sdk')
const out = join(root, 'out')
const declarations = join(packageRoot, 'dist')
const tsc = join(root, 'node_modules/typescript/bin/tsc')

await mkdir(out, { recursive: true })
const scratch = await mkdtemp(join(out, 'addon-sdk-build-'))
try {
  await rm(declarations, { recursive: true, force: true })
  const config = join(scratch, 'tsconfig.json')
  await writeFile(
    config,
    JSON.stringify({
      extends: join(root, 'tsconfig.web.json'),
      compilerOptions: {
        noEmit: false,
        noEmitOnError: true,
        declaration: true,
        emitDeclarationOnly: true,
        skipLibCheck: false,
        incremental: false,
        rootDir: root,
        outDir: declarations,
      },
      files: [
        join(root, 'src/addons/api.ts'),
        join(root, 'src/addons/sdk.ts'),
        join(root, 'src/addons/sdk-loader.ts'),
      ],
      include: [],
    }),
  )
  const result = spawnSync(process.execPath, [tsc, '-p', config], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.status !== 0) {
    process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`)
    throw new Error(
      `addon sdk declarations failed: ${result.status ?? result.error}`,
    )
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
