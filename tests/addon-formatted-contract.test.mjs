import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { formattedCompatibility } from '../src/renderer/src/formatted-compatibility.ts'

test('bundled rich-only addons remain on an explicit migration allowlist', async () => {
  const missing = []
  for (const entry of await readdir('src/addons', { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    const folder = join('src/addons', entry.name)
    const files = (await readdir(folder, { recursive: true })).filter((file) =>
      /\.(ts|tsx)$/.test(file),
    )
    const source = (
      await Promise.all(
        files.map((file) => readFile(join(folder, file), 'utf8')),
      )
    ).join('\n')
    if (
      /\b(?:registerRich\s*\(|richExtensions\s*:)/.test(source) &&
      !/\b(?:registerFormatted\s*\(|formattedRegistry\.register\s*\()/.test(
        source,
      )
    )
      missing.push(entry.name)
  }
  // This allowlist must be empty before the CodeMirror formatted view becomes the default.
  assert.deepEqual(missing.sort(), ['dictionary', 'slash-commands'])
})

test('legacy compatibility follows registrations, including dual-engine updates and cleanup', () => {
  const rich = formattedCompatibility.register('fixture', 'rich')
  const second = formattedCompatibility.register('fixture', 'rich')
  assert.deepEqual(formattedCompatibility.snapshot(), ['fixture'])
  const formatted = formattedCompatibility.register('fixture', 'formatted')
  assert.deepEqual(formattedCompatibility.snapshot(), [])
  formatted()
  assert.deepEqual(formattedCompatibility.snapshot(), ['fixture'])
  rich()
  rich()
  assert.deepEqual(formattedCompatibility.snapshot(), ['fixture'])
  second()
  assert.deepEqual(formattedCompatibility.snapshot(), [])
})
