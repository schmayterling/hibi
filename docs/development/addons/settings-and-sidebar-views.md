# Settings and sidebar views

Use Hibi's shared controls so your addon follows the app's spacing, colors, and keyboard behavior.

## Add a settings page

An addon can provide a `Settings` component. Hibi supplies the page title, description, and metadata. The title opens the addon’s readme. Put your controls inside the component without repeating that heading.

This local example stores a greeting for the command from the first guide. Rename `index.ts` to `index.tsx` to use JSX.

```tsx
import { useState } from 'react'
import { defineAddon } from '../../addons/api'
import { SettingRow, TextInput } from '../../addons/ui'
import manifest from './manifest'

const key = 'hello.greeting'
const greeting = () => localStorage.getItem(key) ?? 'Hello.'

function Settings() {
  const [value, setValue] = useState(greeting)
  return (
    <SettingRow id="hello-greeting" label="Greeting">
      <TextInput
        id="hello-greeting"
        value={value}
        onChange={event => {
          setValue(event.target.value)
          localStorage.setItem(key, event.target.value)
        }}
      />
    </SettingRow>
  )
}

export default defineAddon({
  manifest,
  Settings,
  start(context) {
    context.commands.register({
      id: 'greet',
      label: 'Say hello',
      run: () => context.notify(greeting()),
    })
  },
})
```

Prefix stored keys with your addon ID. Shared `SettingRow` controls are discoverable through settings search and the command palette. Settings may mount in the background for discovery, so avoid starting work merely because the component mounted.

## Group settings and choose icons

Set `settings` in your manifest to place the default page in a category and choose its icon:

```json
{ "settings": { "category": "editing", "icon": "book-open" } }
```

The built-in category IDs are `general` (the unlabeled section after addon settings), `editing`, `interface`, and `addons`. All addon pages appear in the **Addon settings** section by default, after Addons. Set `category` to place a page elsewhere. Supported manifest icons are `activity`, `audio-lines`, `book-open`, `braces`, `code`, `file`, `file-down`, `file-text`, `folder`, `keyboard`, `palette`, `puzzle`, `settings`, `sigma`, `tags`, and `type`. Unknown names use the addon icon.

For extra pages or a custom category, register them inside `start(context)`. Registered pages can use a React icon component, including icons from Lucide.

```tsx
context.settings.registerCategory({ id: 'workflow', label: 'My workflow' })
context.settings.register({
  id: 'greeting',
  label: 'Greeting',
  category: 'workflow',
  Content: Settings,
})
```

Category and page IDs are local to your addon. Custom categories must use an ID other than the four built-in names. Each method returns a function that removes its registration; Hibi also removes registrations when the addon stops. Pages appear in navigation and the command palette. Use `SettingRow` for individual controls to make them searchable. Existing `Settings` components continue to work.

## Add a sidebar view

Register a [SidebarView](../addon-api-reference/SidebarView.md) inside `start`. The view appears in the sidebar picker and command palette.

```tsx
const view = context.sidebar.register({
  id: 'notes',
  label: 'My notes',
  Content: () => <p>Your addon content goes here.</p>,
})

context.commands.register({
  id: 'open-notes',
  label: 'Open my notes',
  run: () => view.open(),
})
```

Content mounts only while the view is visible. Keep anything that must survive closing the sidebar in addon state. Use the shared [Sidebar](../addon-api-reference/Sidebar.md) component for lists and trees.

Trees with more than 200 expanded rows mount only the viewport and a small buffer, plus selected, focused, editing and dragged rows. Arrow keys, Home and End reveal their targets; renaming retains focus when scrolled away. Stable item IDs preserve the scroll anchor when items change. Use the shared row and section height tokens rather than overriding individual row heights. The complete item model remains in memory; windowing bounds the DOM, not your addon's data preparation. Settings tab lists keep their existing rendering.

Focus navigation reads the current row geometry before scrolling, so a changed row-height token keeps its target visible even before resize observation runs.

Set `side: 'right'` when registering a view to make addon-triggered opens and its command-palette entry use the right sidebar. The default is `'left'`. Registration alone does not open or select a view; the right sidebar starts collapsed and empty. Users can select addon views in either sidebar's picker. `view.open(input, 'right')` overrides the preferred side for that call.

Hibi displays sidebar views as drawers in narrow windows. For a separate layout built with `Sidebar`, set `overlay` and supply `onDismiss` to use the same backdrop and Escape handling. Keep covered content inert while the drawer is open and return focus to its toggle when dismissing it.

If an asynchronous row refresh removes the focused element, the shared drawer restores focus to its selected or first available control so keyboard navigation and Escape keep working. A newer pointer action, explicit blur, or focus outside the drawer takes precedence.

The shared `Sidebar` also accepts `side: 'right'` to mirror its collapse motion and resize edge. Wide layouts allow both sidebars; narrow layouts display one drawer at a time.

## Bind a view to a document

`context.views.register()` supports sidebars, a panel below the editor, and dedicated tabs. Its `Content` receives `document`, `input`, `instanceId`, `binding`, `visible`, `close()`, and `focusDocument()`. Follow views receive the active document. Open with `binding: 'pinned'` to retain the current document snapshot, including its version, when the user switches tabs or continues editing. A pinned snapshot does not grant permission to edit an inactive document; normal edit validation still applies.

```tsx
const report = context.views.register({
  id: 'report',
  label: 'My report',
  location: 'panel',
  lifetime: 'session',
  Content: ({ document }) => <p>{document?.name}</p>,
})
const instance = report.open({ id: 'comparison', binding: 'pinned' })
```

Use `location: 'tab'` for a full-size view beside document tabs. Opening an instance selects its tab; opening the same ID again reuses it. Closing the tab releases that instance. Selecting a document tab hides the addon view without closing it. Tab views remain available when document tabs are turned off, and they are removed when the addon stops.

Use `location: 'start'` to replace the welcome screen when no document tab is open. Hibi opens this view when the addon registers it and returns to the built-in welcome screen when the addon stops. Its `document` prop is `null`. If several addons register start views, the most recently shown one is visible. Calling `show()` selects it again; `hide()` or `close()` reveals another registered start view or the built-in screen. Typing in the editor still creates an `untitled.md` tab.

```tsx
const dashboard = context.views.register({
  id: 'dashboard',
  label: 'Dashboard',
  location: 'tab',
  lifetime: 'session',
  Content: Dashboard,
})
context.commands.register({
  id: 'open-dashboard',
  label: 'Open dashboard',
  run: () => dashboard.open(),
})
```

Opening the same instance ID on the same side reuses it. For sidebar views, `side: 'left' | 'right'` is accepted both at registration and in `open()` options; the open option overrides the registration default. Each side keeps independent instances, so the same view can appear in both sidebars without sharing component state. Panel and tab views ignore `side`. Treat `instanceId` as an opaque identifier.

`hide()` keeps the instance; `show()` reveals it; `close()` releases it. The default `lifetime: 'visible'` unmounts content when hidden. Session views retain React state until closed or until their addon stops. Pause timers and analysis when `visible` is false. The host allows eight instances per addon and 32 across the window, counting instances on both sides.

Opening a view focuses its first control unless `focus: false` is supplied. `focusDocument()` activates the bound tab and returns false if that tab has closed. It never reopens files by path. Local loading and error boundaries keep a suspended or failed view from replacing the editor. The Review addon demonstrates a following sidebar and a pinned report panel.

The existing `context.sidebar` API uses the same host with one default instance per side and remains compatible. Removing an addon clears its instances on both sides. The left sidebar falls back to workspace navigation; the right sidebar returns to its empty view.

## Open a dialog

Use `context.dialogs.prompt()` for a text value or `confirm()` for a decision. For custom content, use `open()` with a React component and choose `size: 'wide'` when needed. The [dialog API](../addon-api-reference/DialogApi.md) handles dismissal and returns the result.
