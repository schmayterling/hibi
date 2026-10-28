import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { electronEnvironment } from '../scripts/electron-runtime.mjs'
import { electron } from './electron.mjs'

test('development runtime uses the hibi bundle name and supplied icon', {
  skip: process.platform !== 'darwin',
  timeout: 60000,
}, async (t) => {
  const env = await electronEnvironment()
  const contents = resolve(dirname(env.ELECTRON_EXEC_PATH), '..')
  const plist = JSON.parse(
    execFileSync(
      'plutil',
      ['-convert', 'json', '-o', '-', join(contents, 'Info.plist')],
      { encoding: 'utf8' },
    ),
  )
  assert.equal(plist.CFBundleDisplayName, 'hibi')
  assert.equal(plist.CFBundleName, 'hibi')
  assert.equal(plist.CFBundleIconFile, 'hibi.icns')
  assert.deepEqual(
    await readFile(join(contents, 'Resources/hibi.icns')),
    await readFile('build/icon.icns'),
  )
  const original = JSON.parse(
    execFileSync(
      'plutil',
      [
        '-convert',
        'json',
        '-o',
        '-',
        'node_modules/electron/dist/Electron.app/Contents/Info.plist',
      ],
      { encoding: 'utf8' },
    ),
  )
  assert.equal(original.CFBundleName, 'Electron')
  const profile = await mkdtemp(join(tmpdir(), 'hibi-branding-'))
  const app = await electron.launch({
    executablePath: env.ELECTRON_EXEC_PATH,
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await (await app.firstWindow())
    .getByRole('textbox', { name: /document editor/i })
    .waitFor()
  assert.equal(await app.evaluate(({ app }) => app.getName()), 'hibi')
  const icons = await app.evaluate(({ app, nativeImage }) =>
    ['mac', 'win', 'linux', 'mac-dark', 'win-dark', 'linux-dark'].map(
      (platform) => {
        const icon = nativeImage.createFromPath(
          `${app.getAppPath()}/build/icon-${platform}.png`,
        )
        const { width, height } = icon.getSize()
        const pixels = icon.toBitmap()
        let left = width,
          right = 0
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            if (pixels[(y * width + x) * 4 + 3]) {
              left = Math.min(left, x)
              right = Math.max(right, x)
            }
          }
        return {
          platform,
          width,
          ratio: (right - left + 1) / width,
          corner: pixels[3],
        }
      },
    ),
  )
  assert.deepEqual(
    icons.map((icon) => icon.width),
    [1024, 256, 512, 1024, 256, 512],
  )
  for (const icon of icons) {
    assert.equal(icon.corner, 0)
    assert.ok(
      Math.abs(icon.ratio - (icon.platform.startsWith('mac') ? 0.8 : 0.875)) <
        0.005,
    )
  }
})
