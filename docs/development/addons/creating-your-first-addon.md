# Creating your first addon

This addon adds a command that displays a greeting. Generate a standalone package, or follow the manual source-addon guide below.

## Generate a standalone addon

From a Hibi source checkout, run:

```sh
npm run create:addon -- hello --name "Hello" --author "Your name"
```

Once `create-hibi-addon` is published to npm, the same starter will be available without a checkout:

```sh
npx create-hibi-addon hello --name "Hello" --author "Your name"
```

Use Node.js 22.18 or later and a new destination directory. The creator refuses to overwrite existing paths and removes incomplete output if creation fails, so you can retry. It writes `hibi-addon.json`, `index.js`, `package.json`, and `README.md` without installing dependencies. The folder name becomes the addon ID after removing accents, lowercasing letters, and converting separators to hyphens; `Über Café` becomes `uber-cafe`. The creator prints the derived ID and rejects names that produce an empty or invalid ID.

Run `npm run check` inside the generated folder. In Hibi, choose **Install addon…** from the command palette, select that folder, review it, and enable it in **Settings → Addons**. Run **Say hello** to display a greeting. The addon declares no UI or editor capabilities and loads when its command first runs; disabling it removes the command.

The starter needs no SDK package at runtime. For optional TypeScript checking, use the local, types-only SDK tarball described in [sideloading and sharing](sideloading.md). The SDK is currently private and is not an npm dependency of the starter.

## Create the files manually

First, [run Hibi from source](../core/running-the-development-build.md).

Create `src/useraddons/hello/`. This folder is ignored by Git, so you can experiment without adding the addon to the repository. Add these three files.

### manifest.ts

```typescript
import { ADDON_API_VERSION, type AddonManifest } from '../../addons/api'

export default {
  id: 'hello',
  name: 'Hello',
  description: 'A greeting from your first addon.',
  version: '1.0.0',
  apiVersion: ADDON_API_VERSION,
  authors: [{ displayName: 'Your name' }],
} satisfies AddonManifest
```

The ID must be unique and use lowercase letters, numbers, or hyphens. `version` identifies your addon release; `apiVersion` identifies the Hibi API it uses. List the people who worked on the addon in `authors`. Put upstream credits and license notices in the readme.

### index.ts

```typescript
import { defineAddon } from '../../addons/api'
import manifest from './manifest'

export default defineAddon({
  manifest,
  start(context) {
    context.commands.register({
      id: 'greet',
      label: 'Say hello',
      run: () => context.notify('Hello from your addon.'),
    })
  },
})
```

Hibi calls `start` when the addon is enabled. It prefixes the command ID with your addon ID, so this command becomes `hello.greet`.

### README.md

```markdown
# Hello

Run **Say hello** from the command palette to display a greeting.
```

## Try it

Restart `npm run dev` after creating the folder. Open **Settings → Addons**, enable **Hello**, then open the command palette and choose **Say hello**. Disabling the addon removes its command.

Continue with [adding functionality](adding-functionality.md), or [package the addon](sideloading.md) for an installed copy of Hibi.
