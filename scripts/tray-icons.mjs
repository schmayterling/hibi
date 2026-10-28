import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const build = fileURLToPath(new URL('../build/', import.meta.url))
const check = process.argv.includes('--check')
// The letter is its own source: the white h cut from the app icon before the icon became a butterfly.
const glyph = await readFile(join(build, 'tray-glyph.png'))
const { data, info } = await sharp(glyph)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true })
for (let at = 0; at < data.length; at += 4) data.fill(0, at, at + 3)
const blackGlyph = await sharp(data, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .png()
  .toBuffer()
const tile = await readFile(join(build, 'tray-tile.svg'))

async function render(size, template = false) {
  const input = await sharp(template ? blackGlyph : glyph)
    .resize({ height: Math.round(size * (template ? 0.875 : 0.75)) })
    .png()
    .toBuffer()
  const canvas = template
    ? sharp({
        create: {
          width: size,
          height: size,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
    : sharp(tile).resize(size, size)
  return canvas
    .composite([{ input, gravity: 'centre' }])
    .png()
    .toBuffer()
}

async function output(name, png) {
  const path = join(build, name)
  if (check) {
    if (!png.equals(await readFile(path)))
      throw new Error(`${name} is stale; run node scripts/tray-icons.mjs`)
  } else {
    await writeFile(path, png)
  }
}

await output('trayTemplate.png', await render(16, true))
await output('trayTemplate@2x.png', await render(32, true))
await output('tray.png', await render(32))

const images = []
for (const size of [16, 24, 32]) images.push({ size, png: await render(size) })
const header = Buffer.alloc(6 + images.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
let offset = header.length
images.forEach(({ size, png }, index) => {
  const at = 6 + index * 16
  header[at] = header[at + 1] = size
  header.writeUInt16LE(1, at + 4)
  header.writeUInt16LE(32, at + 6)
  header.writeUInt32LE(png.length, at + 8)
  header.writeUInt32LE(offset, at + 12)
  offset += png.length
})
await output(
  'tray.ico',
  Buffer.concat([header, ...images.map(({ png }) => png)]),
)
console.log(check ? 'tray icons are current' : 'tray icons regenerated')
