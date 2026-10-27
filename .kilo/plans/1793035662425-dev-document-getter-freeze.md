# Fix: dev build freezes after closing a tab

## Problem

In the development build, closing any document tab (the X button, `Ctrl+W`, or middle-click) leaves the UI frozen: menu items no longer open, tab selection stops updating, and the closing tab stays in the tab strip. Production builds are unaffected.

This is pre-existing and unrelated to PR #455 (bulk/middle-click close); it reproduces on unmodified `main` by clicking the normal tab X.

## Root cause

- `src/renderer/src/document-runtime.ts:595-600` calls `releaseDocuments(id)` synchronously when a tab disappears from the new document state.
- `src/renderer/src/document-transfer.ts:76-84` deletes that tab's entry from the `sources` WeakMap.
- `src/renderer/src/document-transfer.ts:51-60` defines `markdown` and `savedMarkdown` as **enumerable own getters** that call `sourceOf(state)` and throw `StaleDocumentError` when the source is gone.
- In dev, React DevTools' render logging diffs old and new props with `for...in` (`addObjectDiffToProperties` in `react-dom_client.js`). It reads the old `DocumentState` after the source was released, hits `StaleDocumentError`, and aborts React's passive effect/commit. React then stops applying updates, so the app appears frozen and the closing tab is never removed. Production has no DevTools hook, so the same getter is never read during the diff.

## Fix

Keep the stale-read guarantee, but keep the content getters out of enumerable property walks:

- In `sourceDocument` (`src/renderer/src/document-transfer.ts:43-73`), define `markdown` and `savedMarkdown` with `Object.defineProperties` / `enumerable: false` instead of object-literal getters.
- Freeze the state after defining the getters and registering it in `sources`.
- Direct reads (`state.markdown`) still work while open and still throw `StaleDocumentError` after close.
- Add a short comment explaining that React DevTools' `for...in` prop diff must not read released content.

Sketch:

```ts
const document = { ...metadata } as DocumentState
Object.defineProperties(document, {
  // Keep content off enumerable walks: React DevTools diffs props with
  // for...in after this tab's source may already be released.
  markdown: {
    enumerable: false,
    get() {
      const source = sourceOf(document)
      source.text ??= source.current.materialize()
      return source.text
    },
  },
  savedMarkdown: {
    enumerable: false,
    get() {
      const source = sourceOf(document)
      source.savedText.value ??= source.saved.materialize()
      return source.savedText.value
    },
  },
})
sources.set(document, { current, saved, savedText })
// ...tabStates bookkeeping...
return Object.freeze(document)
```

Only the renderer state needs this. The main-process `getDocument()` object must keep enumerable getters so IPC serialization still transfers `markdown` and `savedMarkdown`.

## Consumer audit

Spreading a `DocumentState` no longer copies the two content getters. Checked call sites:

- `src/renderer/src/document-runtime.ts:161` builds a `ViewTarget` from `{ ...document, viewId, viewGeneration }`; `ViewTarget` only declares target identifiers and does not use content.
- `src/renderer/src/document-runtime.ts:631` stores `#metadata` with type `Omit<DocumentState, 'markdown' | 'savedMarkdown'>`.
- Addons read `document.markdown` directly, not through spreads.

If a new consumer depends on spread/`for...in` copying content, change it to direct property access rather than re-enumerating the getters.

## Tests

Add coverage to `tests/document-runtime.test.mjs` near the existing closed-tab test (around lines 506-528):

1. While open, `state.markdown` / `state.savedMarkdown` return content, but both properties are non-enumerable and absent from `Object.keys(state)`.
2. After the tab closes, direct reads still throw `StaleDocumentError` (keep the existing assertions).
3. Simulate the DevTools diff after close:
   ```js
   assert.doesNotThrow(() => {
     for (const key in closing) void closing[key]
   })
   ```
4. Keep `tests/closed-tab-memory.test.mjs` green (it asserts no stale errors leak into the renderer console in production).

## Validation

- `npm run typecheck`
- `npm run lint`
- `node --test tests/document-runtime.test.mjs`
- `node --test tests/closed-tab-memory.test.mjs`
- `npm run build`
- Manual dev check (`npm run dev`):
  - create 3+ tabs
  - close the active tab with the X, then with middle-click
  - verify the closing tab disappears, tab switching still updates the editor, right-click still opens the tab menu, and DevTools shows no `StaleDocumentError`
  - verify direct stale reads still throw by checking the existing test, not by adding production behavior

## Risks and fallback

- Enumerability is observable. The audit above covers current consumers; review any new `{ ...document }` or `for...in` use in the follow-up PR.
- If a future React DevTools version uses `Object.getOwnPropertyNames`, this fix stops working. Fallback: defer `releaseDocuments` until after React's commit (for example from a renderer effect) or materialize content on release. Do not implement the fallback unless the primary fix is insufficient.

## Out of scope

- Changing `StaleDocumentError` semantics or making stale reads return content.
- Changing when `releaseDocuments` runs.
- Any changes to PR #455 or the tab close feature.

## Acceptance

- Dev build: closing a tab by X, keyboard, or middle-click leaves the app fully interactive and removes the closing tab.
- No `StaleDocumentError` during React DevTools render diffs.
- Production behavior is unchanged.
- Existing stale-read tests still throw as before.

## Suggested branch / PR

- Branch: `fix/dev-stale-document-getters`
- PR title: `fix(dev): keep closed-tab content getters out of React DevTools diffs`
