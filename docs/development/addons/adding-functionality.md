# Adding functionality

The `context` passed to `start` connects your addon to Hibi. Use its APIs for commands, editor changes, dialogs, and workspace access. The [AddonContext reference](../addon-api-reference/AddonContext.md) lists them all.

## Change the current document

Add this registration inside `start(context)` to create a command that inserts a heading above the current document.

```typescript
context.commands.register({
  id: 'add-heading',
  label: 'Add a heading',
  run() {
    context.editor.updateMarkdown(source => `# Heading\n\n${source}`)
  },
})
```

The transform receives the current source. Return the replacement text, or `null` to leave it unchanged. For file actions such as saving, use `context.editor.runCommand('save')` so Hibi can handle dialogs and unsaved changes.

`getDocument()` includes `tabId`, `revision`, and `contentVersion`. The revision identifies a replacement editor; the content version advances when text changes, including undo and redo. If you calculate a result asynchronously, compare all three before using it. A matching file name alone does not mean the document is unchanged.

For edits calculated from an earlier snapshot, use `applySourceEdits()`. It validates the version and exact text before applying all changes in one undo operation. Offsets count UTF-16 code units in the complete document source, including frontmatter. Rich view accepts literal text replacements only when the host can prove their exact location and preserve the surrounding structure. Other ranges return `unsupported-view`. Navigation position maps must not be used to build edit ranges.

```typescript
const document = context.editor.getDocument()
if (document) {
  const result = context.editor.applySourceEdits({
    requestId: crypto.randomUUID(),
    tabId: document.tabId,
    revision: document.revision,
    contentVersion: document.contentVersion,
    changes: [{ from: 0, to: 0, insert: '# Heading\n\n', expectedText: '' }],
  })
  if (result.status !== 'applied') context.notify(result.message)
}
```

Handle `stale` by calculating a new proposal from the latest snapshot, and `composing` by waiting until text composition finishes. A stopped addon receives `disposed`. Reusing a request ID with different edits is invalid. Retries with the same payload return the original result while it remains in the addon's bounded cache: at most 128 requests and 8 Mi UTF-16 units of serialized payloads. After eviction, the version check still prevents an old content-changing edit from being applied again.

A request can contain up to 256 non-overlapping changes in source view or 32 in rich view. Each change must include its exact `expectedText`; insertions use an empty string. Edits cannot split a surrogate pair or share an insertion boundary. Inserted and expected text together are limited to 4 Mi UTF-16 units, the serialized request to 8 Mi units, and the resulting document to Hibi's 2 MiB UTF-8 limit. Changes use the host's ordered persistence journal and save barriers.

Source offsets include the original line endings. CodeMirror uses normalized positions internally, but Hibi translates API ranges and retains untouched CRLF and mixed line endings. New lines use the document's first line-ending style. Edits cannot split a CRLF pair; use a whole-source transform for changes that only replace line endings. Source and rich edits share the host's operation history, which retains up to 128 groups and 8 MiB of estimated change payload by default. Retained undo/redo restores exact source, including line endings. Expired groups cannot be undone through a second widget history.

Rich corrections also keep a per-editor source-preservation cache of up to 32 entries and 8 Mi UTF-16 units for matching subsequent serialization results. That cache is separate from authoritative operation history; its eviction does not make retained host undo normalize Markdown. A schema change creates a new rich editor and follows the syntax transition policy. Source editor recreation restores the session's source selection.

## Analyze and mark text

`getTextProjection()` lazily returns literal text with exact spans back to the source. It excludes Markdown code, metadata, destinations, and text that cannot be mapped safely. A projection has its own `id` as well as the document identity and content version. Include that ID as `projectionId` in edit requests so a view or schema change also invalidates stale results.

Offsets in the projection's `text` differ from source offsets. Find a containing span and translate using `span.sourceFrom + offset - span.from`. A result crossing spans is not an exact edit range. Keep the corresponding source substring as `expectedText`.

Use `setDecorations(projection.id, decorations)` to underline up to 32 analysis ranges in the active editor. Each decoration has an ID, `from`, `to`, a short `message`, and an optional `severity` of `info` or `warning`. Invalid or stale results return `false`. Call `clearDecorations()` to remove them; stopping the addon also clears them. Unaffected marks move with ordinary edits only while their exact source text still matches. Rich view omits ranges it cannot prove.

Listen to `onDocumentChange()` for text changes and `onProjectionChange()` for view or schema changes. The built-in Review addon demonstrates asynchronous checks, annotations, stale-result handling, and one-step fixes.

### Run isolated analysis

Declare `analysis: { entry: 'analysis.js' }` in the manifest and ship a self-contained ES module exporting `analyze(projection)`. Bundle its dependencies into that file. Bundled addons instead provide `analysis.ts` beside their manifest; Hibi builds it separately. Call `context.analysis.run(projection)` from your renderer entry. The result is either `complete` with a JSON value and projection ID, or `stale`, `cancelled`, or `failed` with a message. Validate your result shape before using it to change the document.

The host sends only an exact projection of the active document. An analyzer cannot request another document, use the app bridge, access the DOM or filesystem, or connect to the network. Its worker runs in a separate sandboxed renderer process. This boundary applies to the analysis entry; ordinary renderer addons remain trusted code.

Each addon gets one active request and one replaceable queued request. Replacing queued work resolves it as `cancelled`. Call `cancel()` when the view closes or a result is no longer wanted. Disabling the addon, reloading the app renderer, or closing the window revokes its process and pending work. Compare the returned projection ID before applying results; editor or syntax changes can invalidate it even if the source text has not changed.

The host allows four analyzer processes, up to 10,000 projection spans, and 256 Ki UTF-16 units of JSON output per result. Each request has a three-second deadline, including process startup. A 256 MiB working-set guard is sampled every 500 ms; it is a termination threshold, not an operating-system memory quota. Idle processes stop after 30 seconds. A later request starts a fresh process after failure or cancellation. Diagnostics records analysis as asynchronous addon activity.

## Add a toolbar action

Commands and toolbar buttons are separate registrations. Route the toolbar action through `commands.execute()` to use the command's lifecycle checks and diagnostics.

```typescript
const greet = () => context.notify('Hello.')

context.commands.register({ id: 'greet', label: 'Say hello', run: greet })
context.toolbar.register({ id: 'greet', label: 'Say hello', onClick: () => context.commands.execute('greet') })
```

Toolbar and status-bar registrations return handles with `update` and `dispose` methods. Update an existing item when its value changes. Status-bar items should show useful state, such as a count, rather than repeat the addon name.

Users control toolbar order and each action's placement in Appearance settings. Actions can appear in the toolbar, stay in its dropdown, or be hidden. These choices persist across addon reloads. The shared [ToolbarPreferences](../addon-api-reference/ToolbarPreferences.md) API exposes them as `order` and `placements`; preserve other entries when changing one action. Context-specific `hidden` and `when` rules still apply.

## Read the workspace

Use `context.workspace.index()` for note text and drafts. It returns `null` when no workspace is open. Use `snapshot()` when you also need the export data. Pass a workspace-relative path to `openFile()` to open a document.

## Attach editor behavior

`context.editor.registerRich()` attaches behavior to each visual editor. Its `attach(editor)` callback must return a cleanup function. It can register a ProseMirror plugin, but cannot change the editor schema. `registerSource()` creates a CodeMirror extension for each source editor. See [RichExtension](../addon-api-reference/RichExtension.md) and [SourceExtension](../addon-api-reference/SourceExtension.md).

Throw when an attachment cannot be installed. Hibi displays the failure and keeps that editor read-only until the failing addon is disabled or successfully installed. Already attached rich-editor features are detached if a later attachment fails.

Use `onInput()` to observe typed characters, or `onKeyEvent()` to observe editor key events. These hooks do not receive input from settings, search fields, or dialogs.

## Add a system-wide shortcut

Register an Electron accelerator to run an addon action while Hibi is open, even when another application has focus. The registration returns a removal function. Hibi also removes it when the addon stops. Registration rejects a shortcut already owned by another application.

```typescript
const remove = await context.globalShortcuts.register(
  'capture',
  'CommandOrControl+Alt+N',
  () => context.commands.execute('capture'),
)
```

Choose a shortcut that does not overlap with a Hibi editing command. System-wide shortcuts are active only while Hibi is running and this addon is enabled. The operating system may reserve some combinations.

## Clean up

Hibi removes registrations made through `context` when the addon stops. Clean up timers, browser listeners, and other resources you create yourself in `stop()`. Editor attachment callbacks must clean up their own resources when their editor is removed.

Document-edit access is revoked before `stop()` runs.

A failed cleanup does not prevent Hibi from attempting the remaining host cleanups. Your own `stop()` should follow the same rule when releasing several resources.

## Native operations

Bundled addons can include a `native.ts` entry implementing [NativeAddon](../addon-api-reference/NativeAddon.md). Call its methods through `context.native.invoke()`. Read-only handlers belong in `queries` and use `context.native.query()`.

Validate each handler's input before using it. Prefer the document, workspace, and export operations on [NativeAddonContext](../addon-api-reference/NativeAddonContext.md) over accepting arbitrary paths. Sideloaded packages cannot add native handlers.
