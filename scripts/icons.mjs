import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

// Regenerate the committed native icons from the supplied PNGs on macOS: build/icon.png for the light
// appearance and the installers, build/icon-dark.png for the dark appearance, which the app switches to at runtime.
const folder = await mkdtemp(join(tmpdir(), 'hibi-icon-'))
const source = resolve('build/icon.png')
const darkSource = resolve('build/icon-dark.png')
try {
  const require = createRequire(import.meta.url)
  for (const [input, output] of [
    [source, folder],
    [darkSource, join(folder, 'dark')],
  ]) {
    await mkdir(output, { recursive: true })
    execFileSync(
      require('electron'),
      [resolve('scripts/render-icons.cjs'), input, output],
      { stdio: 'pipe' },
    )
  }
  for (const [platform, size] of [
    ['mac', 1024],
    ['win', 256],
    ['linux', 512],
  ])
    for (const suffix of ['', '-dark'])
      await cp(
        join(folder, suffix ? 'dark' : '', `${platform}-${size}.png`),
        resolve(`build/icon-${platform}${suffix}.png`),
      )
  // The About panel shows the icon at 44 px; 192 px covers high-density displays.
  for (const [input, suffix] of [
    [source, ''],
    [darkSource, '-dark'],
  ])
    await sharp(input)
      .resize(192, 192)
      .png({ compressionLevel: 9 })
      .toFile(resolve(`src/renderer/src/assets/app-icon${suffix}.png`))
  const iconset = join(folder, 'hibi.iconset')
  await mkdir(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      await cp(
        join(folder, `mac-${size * scale}.png`),
        join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
      )
    }
  }
  execFileSync('iconutil', [
    '-c',
    'icns',
    iconset,
    '-o',
    resolve('build/icon.icns'),
  ])
  const images = await Promise.all(
    [16, 32, 64, 128, 256].map(async (size) => ({
      size,
      png: await readFile(join(folder, `win-${size}.png`)),
    })),
  )
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, index) => {
    const at = 6 + index * 16
    header[at] = header[at + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  await writeFile(
    'build/icon.ico',
    Buffer.concat([header, ...images.map(({ png }) => png)]),
  )
} finally {
  await rm(folder, { recursive: true, force: true })
}
