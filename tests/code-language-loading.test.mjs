import assert from 'node:assert/strict'
import test from 'node:test'
import { codeLanguages } from '../src/renderer/src/code-languages.ts'

const language = () => ({ parser: { parse() {}, startParse() {} } })

test('language registration stays inert and aliases share one pending load', async (t) => {
  let calls = 0,
    finish
  t.after(
    codeLanguages.register('fixture', {
      id: 'lazy-fixture',
      aliases: ['lazy-alias'],
      load: () => {
        calls++
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    }),
  )
  assert.equal(calls, 0)
  const first = codeLanguages.ensure('lazy-fixture')
  const alias = codeLanguages.ensure('LAZY-ALIAS extra')
  await Promise.resolve()
  assert.equal(calls, 1)
  const result = language()
  finish(result)
  assert.deepEqual(await Promise.all([first, alias]), [result, result])
  assert.equal(codeLanguages.resolve('lazy-alias'), result)
})

test('failed languages retry explicitly, deduplicate retries, and respect disabled preferences', async (t) => {
  const errors = t.mock.method(console, 'error', () => {})
  let calls = 0,
    finish
  t.after(
    codeLanguages.register('fixture', {
      id: 'retry-fixture',
      aliases: ['retry-alias'],
      load: () => {
        if (++calls === 1) throw Error('fixture import failed')
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    }),
  )
  assert.equal(await codeLanguages.ensure('retry-fixture'), null)
  assert.equal(await codeLanguages.ensure('retry-alias'), null)
  assert.equal(calls, 1)
  codeLanguages.setEnabled('retry-fixture', false)
  assert.equal(await codeLanguages.retry('retry-alias'), null)
  assert.equal(calls, 1)
  codeLanguages.setEnabled('retry-fixture', true)
  const first = codeLanguages.retry('retry-fixture')
  const second = codeLanguages.retry('retry-alias')
  await Promise.resolve()
  assert.equal(calls, 2)
  const result = language()
  finish(result)
  assert.deepEqual(await Promise.all([first, second]), [result, result])
  assert.equal(codeLanguages.resolve('retry-fixture'), result)
  assert.deepEqual(
    errors.mock.calls.map(({ arguments: [text, error] }) => [
      text,
      error.message,
    ]),
    [['Could not load code language: retry-fixture', 'fixture import failed']],
  )
})

test('late language completion cannot overwrite a replacement registration', async (t) => {
  let finish
  const remove = codeLanguages.register('fixture', {
    id: 'replaced-fixture',
    load: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  })
  const pending = codeLanguages.ensure('replaced-fixture')
  await Promise.resolve()
  remove()
  const replacement = language()
  t.after(
    codeLanguages.register('fixture', {
      id: 'replaced-fixture',
      language: replacement,
    }),
  )
  finish(language())
  assert.equal(await pending, null)
  assert.equal(codeLanguages.resolve('replaced-fixture'), replacement)
})
