# Hibi addon SDK declarations

This local package supplies TypeScript declarations for Hibi addon packages. Its entrypoints contain types only. Hibi supplies `React`, editor libraries, UI controls, and document helpers when it loads an installed addon; use those host values at runtime.

From the Hibi repository, run `npm run sdk:pack`, then install the resulting tarball in an addon development project. Import contracts with `import type`:

```typescript
import type { AddonManifest } from '@hibi/addon-sdk/api'
import type { CapabilityFactory } from '@hibi/addon-sdk/sdk-loader'

export const manifest = {
  id: 'hello',
  name: 'Hello',
  description: 'A greeting.',
  version: '1.0.0',
  apiVersion: 3,
  kind: 'extension',
  capabilities: [],
  activation: 'command',
  commands: [{ id: 'greet', label: 'Greet' }],
} satisfies AddonManifest

const create: CapabilityFactory = () => ({
  start(context) {
    context.commands.register({
      id: 'greet',
      label: 'Greet',
      run: () => context.notify('Hello.'),
    })
  },
})

export default create
```

Hibi loads API 3 packages only. Set `apiVersion` to `3`, and list the SDK parts a factory uses in `capabilities`; it receives them as `CapabilityFactory`'s argument. Use the `formatted` capability for CodeMirror formatted-view extensions and `sdk.codeMirror.markdown` syntax parsers. Flavor `render` hooks share the host's inline `decorate` and cached block `layout` contract. The tarball is private and intended for local use. It provides no JavaScript exports, so neither addon code nor its compiled output should import it at runtime.

The declaration closure references React, CodeMirror, Lezer, and Marked types, so strict TypeScript checking needs the package's listed peers even for a command-only addon. These are development dependencies for addon authors, not libraries to bundle into installed addon JavaScript. Formatted addons receive the host's `sdk.codeMirror.common` and `sdk.codeMirror.markdown` modules; use those values so node properties share the host's identity.

Choose unique syntax node names, preferably starting with your addon id. Hibi rejects declarations that collide with bundled nodes or another active addon. Declare `inlineStops: true` only when inline parsers start at backslash, backtick, `& * _ ! [ ] < > ~ ^ $ : =`, line breaks, or core URL/email starts. Other starting characters require the plain-text shortcut to stay off for that grammar.

Use `context.workspace.metadata({target, path})` to stream one note's positioned metadata. Capture `target` from `context.workspace.changeSnapshot()`; `path` is relative to that folder. The async iterator yields `NoteCacheEntry` values for headings, links, embeds, tag occurrences, list items, sections, blocks and nested frontmatter. It reads the metadata worker's bounded pages, including unsaved open-note edits, without loading source text for every note.

```typescript
const snapshot = await context.workspace.changeSnapshot()
if (snapshot.target) {
  for await (const entry of context.workspace.metadata({
    target: snapshot.target,
    path: 'notes/example.md',
  })) {
    if (entry.kind === 'heading') {
      console.log(entry.value.text, entry.value.position.start)
    }
  }
}
```

Positions use zero-based `{line, col, offset}` locations in the original UTF-16 source, including BOM and CRLF units, with exclusive ends. Use `workspace.query({target, kind: 'resolve-subpath', path, subpath: '#^block-id'})` for an explicit block, or pass a heading name or slug as the subpath. Join heading segments with `#` to select a nested section, such as `#Overview#Details`. Block identifiers match exactly, including case. A successful result contains its source position and source version. Capture document and editor versions before moving a caret; discard a result if they changed while awaiting it. Iterators reject stale folder, source, syntax or continuation identities. Callers that need completeness diagnostics can read `kind: 'metadata'` query pages directly.

Creating a package does not publish it to the garden.
