# Creating your first addon

This addon adds a command that displays a greeting. First, [run Hibi from source](../core/running-the-development-build.md).

Once `create-hibi-addon` is published to npm, generate a standalone addon you can install and share without rebuilding Hibi:

```sh
npx create-hibi-addon hello --name "Hello" --author "Your name"
```

From a Hibi source checkout, use `npm run create:addon -- hello` to run the bundled creator before npm publication.

## Create the files

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
