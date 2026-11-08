// read-only record of source, config, deps, runtime and out. args: <out json>
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const tracked = git('ls-files', '-z').split('\0').filter(Boolean).sort()
const source = createHash('sha256')
for (const path of tracked) source.update(`${hash(path)}  ${path}\n`)
const deps = [
  '.package-lock.json',
  'electron/dist/electron',
  'playwright-core/lib/coreBundle.js',
  '@codemirror/state/dist/index.js',
  '@codemirror/view/dist/index.js',
  '@codemirror/commands/dist/index.js',
  '@codemirror/language/dist/index.js',
  '@lezer/common/dist/index.js',
  '@lezer/markdown/dist/index.js',
  'playwright-core/package.json',
  'electron/package.json',
]
const lines = []
let links = 0
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) links++
    else if (stat.isDirectory()) walk(path)
    else lines.push(`${hash(path)}  ${path}`)
  }
}
walk('out')
writeFileSync(process.argv[2], JSON.stringify({
  head: git('rev-parse', 'HEAD').trim(),
  trackedStatus: git('diff', '--name-only', 'HEAD', '--'),
  sourceFiles: tracked.length,
  source: source.digest('hex'),
  deps: Object.fromEntries(deps.map((name) => [name, hash(join('node_modules', name))])),
  runtime: {
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    electron: JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')).version,
    playwrightCore: JSON.parse(readFileSync('node_modules/playwright-core/package.json', 'utf8')).version,
  },
  outFiles: lines.length,
  outLinks: links,
  out: createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex'),
}, null, 1))
