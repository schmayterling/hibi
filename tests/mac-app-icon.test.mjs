import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { setMacAppIcon } from '../src/main/mac-app-icon.ts'

const execute = promisify(execFile)

test('macOS custom icons persist outside signed contents and can be reset', {
  skip: process.platform !== 'darwin',
  timeout: 30000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-custom-icon-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const bundle = join(folder, "Test ' icon.app")
  await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true })
  await cp('/usr/bin/true', join(bundle, 'Contents/MacOS/test'))
  await writeFile(
    join(bundle, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>garden.hibi.icon-test</string><key>CFBundleExecutable</key><string>test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  )
  await execute('/usr/bin/codesign', ['--force', '--sign', '-', bundle])
  const seal = await readFile(
    join(bundle, 'Contents/_CodeSignature/CodeResources'),
  )
  let darkFork
  for (const dark of [true, false]) {
    await setMacAppIcon(
      bundle,
      resolve(`build/icon-mac${dark ? '-dark' : ''}.png`),
    )
    // The setter process has exited; Finder's custom icon is still attached.
    assert.ok((await readdir(bundle)).includes('Icon\r'))
    const fork = await readFile(join(bundle, 'Icon\r/..namedfork/rsrc'))
    if (dark) darkFork = fork
    else assert.notDeepEqual(fork, darkFork)
    const { stdout } = await execute('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      `ObjC.import('AppKit'); function run(argv) { return $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]).TIFFRepresentation.length; }`,
      bundle,
    ])
    assert.ok(Number(stdout) > 0)
    await execute('/usr/bin/codesign', ['--verify', '--deep', bundle])
    await assert.rejects(
      execute('/usr/bin/codesign', ['--verify', '--strict', bundle]),
      /resource fork, Finder information/,
    )
    assert.deepEqual(
      await readFile(join(bundle, 'Contents/_CodeSignature/CodeResources')),
      seal,
    )
  }
  await setMacAppIcon(bundle, null)
  await execute('/usr/bin/codesign', ['--verify', '--strict', bundle])
  await assert.rejects(
    setMacAppIcon(bundle, join(folder, 'missing.png')),
    /Could not read the app icon/,
  )
})
