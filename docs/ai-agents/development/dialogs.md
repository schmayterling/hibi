# Dialogs and modals

Addons use `context.dialogs`; built-in React components use `useDialogs()` from `src/ui/DialogProvider.tsx`. The app supplies one provider and one queue. Both APIs share the theme, focus trap, Escape/outside dismissal, focus restoration, and reduced-motion behavior. The command palette uses the same `Modal`, exported from `src/addons/ui.ts` for declarative dialogs.

## Prompts and confirmation

```typescript
const name = await context.dialogs.prompt({
  title: 'name this page',
  label: 'name',
  defaultValue: 'untitled',
  validate: value => value.trim() ? null : 'enter a name.',
})
if (name === null) return
const confirmed = await context.dialogs.confirm({
  title: 'use this name?',
  description: name,
  confirmLabel: 'use name',
})
if (confirmed) await context.dialogs.alert({ title: 'name selected', description: name })
```

`alert` resolves on dismissal. `confirm` returns `true` only from the confirm button; dismissal or addon shutdown returns `false`. `prompt` returns the entered string unchanged, or `null` on cancellation. Its synchronous validator returns an error message or `null`. Validation errors keep the prompt and its text open.

## Custom content

`open<T>({ title, preserveTitleCase?, description?, content, footer?, size?, closeOnOutsideClick? })` returns `{ result: Promise<T | null>, close(value?) }`. The `content({ close })` and optional `footer({ close })` functions must be pure. Render a component inside them if you need hooks. Titles use sentence case; set `preserveTitleCase` when the title is a name, such as an addon or file, so it keeps its exact spelling in either interface case.

Sizes are `normal`, `wide`, and `fullscreen`; all fit the viewport. Use fullscreen only when the view needs the whole app window. The expanded graph uses a wide modal. Outside clicks dismiss by default; a form can disable that behavior. Escape and the close button remain available.

Headers and optional footers stay visible while the body scrolls. Headers use the shared text size and 8 px vertical / 16 px horizontal padding. Modals share settings surfaces, typography, buttons, and fields. Use `dialog-form` to stack labels above full-width inputs, and `settings-group` for related fields. The link form uses these primitives; image insertion uses the native file picker.

```tsx
import { Button } from '../ui'

const dialog = context.dialogs.open<{ format: string }>({
  title: 'export options',
  content: ({ close }) => (
    <Button onClick={() => close({ format: 'html' })}>export html</Button>
  ),
})
const options = await dialog.result
```

## Lifecycle

Dialogs open in request order. Closing a queued dialog removes it immediately. Stopping an addon closes its active and queued dialogs and resolves their results to `null`; old handles cannot reopen them. Rendering errors show a dismissible error message. Close the current dialog before awaiting another queued dialog.

Native file pickers and unsaved-file checks stay in the main process. `isOpen()` reports whether the shared queue is occupied; built-in shortcuts pause while it is. Addon settings should retain the context from `start` and use its owned dialog API. Reserve `useDialogs()` for built-ins. A directly rendered `Modal` follows its React component's lifetime.

See the [dialog API](../reference/dialog-api.md) and [modal component](../reference/modal-api.md).
