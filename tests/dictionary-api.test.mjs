import assert from 'node:assert/strict'
import test from 'node:test'
import { createDictionaryApi } from '../src/addons/dictionary/api.ts'

test('exported vocabulary uses one offline pack request and follows custom word changes', async () => {
  const calls = []
  let custom = []
  const native = {
    query: async (method, input) => {
      assert.equal(method, 'packCompleteAll')
      calls.push(input)
      return [{ id: 'en', words: ['happy'] }]
    },
  }
  const api = createDictionaryApi(
    native,
    () => ['en', 'fr'],
    () => custom,
  )
  assert.equal(api.version, 2)
  assert.deepEqual(await api.complete('hap', ['en', 'fr', 'en'], 24), [
    { lang: 'en', words: ['happy'] },
  ])
  assert.deepEqual(calls, [{ ids: ['en', 'fr'], prefix: 'hap', limit: 24 }])
  custom = [{ word: 'Hibiland' }, { word: 'kilig', lang: 'tl' }]
  assert.equal(await api.customWords(), custom)
  custom = []
  assert.deepEqual(await api.customWords(), [])
  assert.deepEqual(await api.complete('', ['en'], 24), [])
  assert.deepEqual(await api.complete('hap', [], 24), [])
  assert.deepEqual(await api.complete('hap', ['en'], NaN), [])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(api.complete('hap', ['en'], 24, controller.signal), {
    name: 'AbortError',
  })
  assert.equal(calls.length, 1)
})
