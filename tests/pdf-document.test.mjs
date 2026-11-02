import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MAX_PDF_BYTES, readPdfBytes } from '../src/main/pdf-document.ts'

const dir = await mkdtemp(join(tmpdir(), 'hibi-pdf-'))
test.after(() => rm(dir, { recursive: true, force: true }))

const write = async (name, data) => {
  const path = join(dir, name)
  await writeFile(path, data)
  return path
}

test('returns the bytes of a PDF', async () => {
  const data = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
  const bytes = await readPdfBytes(await write('valid.pdf', data))
  assert.ok(bytes && Buffer.from(bytes).equals(data))
})

test('accepts the header anywhere in the first 1024 bytes', async () => {
  const data = Buffer.concat([
    Buffer.alloc(500, 'x'),
    Buffer.from('%PDF-1.7\n%%EOF\n'),
  ])
  const bytes = await readPdfBytes(await write('offset.pdf', data))
  assert.ok(bytes && Buffer.from(bytes).equals(data))
})

test('returns null without a PDF header in the first 1024 bytes', async () => {
  assert.equal(
    await readPdfBytes(await write('text.pdf', 'just some text\n')),
    null,
  )
  const late = Buffer.concat([
    Buffer.alloc(1024, 'x'),
    Buffer.from('%PDF-1.4'),
  ])
  assert.equal(await readPdfBytes(await write('late.pdf', late)), null)
})

test('reads a file of exactly the size limit', async () => {
  const path = await write('limit.pdf', '%PDF-1.4\n')
  await truncate(path, MAX_PDF_BYTES)
  assert.equal((await readPdfBytes(path))?.byteLength, MAX_PDF_BYTES)
})

test('returns null for a file one byte over the size limit', async () => {
  const path = await write('over.pdf', '%PDF-1.4\n')
  await truncate(path, MAX_PDF_BYTES + 1)
  assert.equal(await readPdfBytes(path), null)
})

test('returns null for a folder and for a missing file', async () => {
  const folder = join(dir, 'folder.pdf')
  await mkdir(folder)
  assert.equal(await readPdfBytes(folder), null)
  assert.equal(await readPdfBytes(join(dir, 'missing.pdf')), null)
})
