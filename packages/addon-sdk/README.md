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

Use `@hibi/addon-sdk/sdk` for the legacy `SideloadFactory` type. Addons with `capabilities` use `CapabilityFactory`. Set `apiVersion` to `3` for new packages; the host still accepts API v1 and v2 packages. Use the `formatted` capability for CodeMirror formatted-view extensions and `sdk.codeMirror.markdown` syntax parsers. Flavor `render` hooks share the host's inline `decorate` and cached block `layout` contract. The tarball is private and intended for local use. It provides no JavaScript exports, so neither addon code nor its compiled output should import it at runtime.

The declaration closure references React, CodeMirror, Tiptap, and Marked types, so strict TypeScript checking needs the package's listed peers even for a command-only addon. `@tiptap/core` remains a required development peer while the legacy types ship. These are development dependencies for addon authors, not libraries to bundle into installed addon JavaScript. Formatted addons receive the host's `sdk.codeMirror.common` and `sdk.codeMirror.markdown` modules; use those values so node properties share the host's identity.

Choose unique syntax node names, preferably starting with your addon id. Hibi rejects declarations that collide with bundled nodes or another active addon. Declare `inlineStops: true` only when inline parsers start at backslash, backtick, `& * _ ! [ ] < > ~ ^ $ : =`, line breaks, or core URL/email starts. Other starting characters require the plain-text shortcut to stay off for that grammar.

Released API 2 clients reject newer entries in the shared garden catalog. Keep API 3 packages out of that catalog until clients that skip unsupported versions are released, or publish them through a versioned catalog. Creating an API 3 package does not publish it to the garden.
