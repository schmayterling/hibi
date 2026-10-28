import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Match the renderer's extensionless import resolution.
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
})
const { captureEditorCommandTarget, isEditorCommandTargetCurrent } =
  await import('../src/renderer/src/editor-command-targets.ts')

// A decoded entity can contribute two UTF-16 units at the source sample's edge.
test('command samples preserve scalars and the original selection coordinates', () => {
  for (const [selectedText, expected] of [
    ['a'.repeat(300), 'a'.repeat(256)],
    ['a'.repeat(255) + '😀', 'a'.repeat(255)],
    ['a'.repeat(254) + '😀b', 'a'.repeat(254) + '😀'],
  ]) {
    const request = {
      view: {
        documentId: 'document',
        documentGeneration: 1,
        viewId: 'view',
        viewGeneration: 1,
      },
      contentVersion: 0,
      editor: 'rich',
      documentLength: 300,
      position: 300,
      selection: { anchor: 0, head: 300 },
      before: '',
      after: '',
      selectedText,
    }
    const target = captureEditorCommandTarget(
      { source: 'toolbar' },
      request,
      () => request,
    )
    try {
      assert.equal(target.context.selection.selectedText, expected)
      assert.equal(target.context.selection.anchor, 0)
      assert.equal(target.context.selection.head, 300)
      assert.equal(target.context.selection.position, 300)
      assert.equal(isEditorCommandTargetCurrent(target.context), true)
    } finally {
      target.release()
    }
    assert.equal(isEditorCommandTargetCurrent(target.context), false)
  }
})
