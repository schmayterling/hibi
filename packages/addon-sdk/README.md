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
  apiVersion: 2,
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

Use `@hibi/addon-sdk/sdk` for the legacy `SideloadFactory` type. Addons with `capabilities` use `CapabilityFactory`. Set `apiVersion` to `2` for new packages; the host still accepts compatible API v1 packages. The tarball is private and intended for local use. It provides no JavaScript exports, so neither addon code nor its compiled output should import it at runtime.

The declaration closure references React, CodeMirror, Tiptap, and Marked types, so strict TypeScript checking needs the package's listed peers even for a command-only addon. These are development dependencies for addon authors, not libraries to bundle into installed addon JavaScript.
