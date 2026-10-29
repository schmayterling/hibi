import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { EditorSelection, EditorState } from '@codemirror/state'
import { transformSync } from 'esbuild'

// The engine uses a parameter property, which Node's strip-only loader cannot read.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (!specifier.startsWith('.') || error.code !== 'ERR_MODULE_NOT_FOUND')
        throw error
      return next(`${specifier}.ts`, context)
    }
  },
  load(url, context, next) {
    if (!url.endsWith('/src/addons/vim/engine.ts')) return next(url, context)
    return {
      format: 'module',
      shortCircuit: true,
      source: transformSync(readFileSync(new URL(url), 'utf8'), {
        loader: 'ts',
        format: 'esm',
      }).code,
    }
  },
})
const { createVim } = await import('../src/addons/vim/engine.ts')

test('vim retains block ranges while ordinary source retains only one range', () => {
  const doc = 'alpha\nbravo\ncharlie'
  const selection = EditorSelection.create(
    [
      EditorSelection.range(0, 2),
      EditorSelection.range(6, 8),
      EditorSelection.range(12, 14),
    ],
    2,
  )
  const ordinary = EditorState.create({ doc, selection })
  assert.equal(ordinary.selection.ranges.length, 1)
  const vim = EditorState.create({ doc, selection, extensions: createVim({}) })
  assert.equal(vim.selection.ranges.length, 3)
})
