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

Creating a package does not publish it to the garden.
