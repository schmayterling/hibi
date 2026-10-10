# Toolbar and tooltips

## Adding a toolbar action

`context.toolbar.register(item)` adds an action below the titlebar. The host prefixes local IDs with the addon ID and rejects duplicate or invalid IDs. The returned handle has `update(partial)` and `dispose()`. Disabling, failed startup, and hot reload remove owned actions. Disposed handles and callbacks do nothing. Async callback failures show an error notification.

```ts
import { Volume2 } from 'lucide-react'

const action = context.toolbar.register({
  id: 'sound', label: 'mute sounds', icon: Volume2,
  tooltip: 'mute keyboard sounds', pressed: false,
  onClick() { action.update({ pressed: true }) },
})
```

`when: 'normal'` shows the action in normal and split views. `when: 'source'` shows it in source and split views. Omitting `when` shows it in every editor view. Settings hide the toolbar, and empty toolbars take no space. Icons are optional; icons-only mode uses a puzzle icon when none is supplied. Labels remain accessible.

`hidden: true` hides a contextual action while preserving its settings position. Built-in formatting uses this API too, follows the active pane, and adds table actions when editing a rich-text table. Unavailable actions are disabled. Hiding the toolbar does not disable addons or commands.

## Preferences and layout

`getPreferences()` returns `{ visible, mode, order?, autoHide?, placements? }`. `setPreferences(partial)` changes saved window preferences. `mode` accepts `icons`, `icons-and-text`, or `text`.

`order` contains fully qualified IDs such as `format.bold` and `keybeats.mute`. Invalid/duplicate IDs are ignored. Unlisted actions follow registration order; disabled addons keep their saved positions. An empty array restores defaults. Returned arrays are copies.

`placements` maps fully qualified IDs to `toolbar`, `menu`, or `hidden`. Omitted IDs default to `toolbar`, which allows automatic overflow. `menu` always puts the action in the dropdown, regardless of available width. `hidden` removes it from both surfaces without disabling its command or shortcut. Contextual `hidden` and `when` still take precedence. Invalid entries are ignored; explicit `toolbar` entries are normalized away. Passing a map replaces the saved map, so merge with `getPreferences().placements` to change one action. Returned maps are copies. Choices survive addon disable/re-enable and app restarts.

The host measures button widths and moves overflow into an ellipsis menu in saved order. It adapts to fonts, sidebar width, and display mode without horizontal scrolling. The toolbar's inset surface uses 12 px horizontal and 4 px vertical padding. Individual buttons get backgrounds only when hovered or active. Overflow supports arrow keys, Home/End, Escape, and outside dismissal.

Appearance settings expose visibility, display mode, and **Arrange toolbar actions**. Users can drag tiles, use Earlier/Later buttons, or press Alt+Left/Right on a focused tile. Tiles wrap, and the selected action's position and placement control appear below them. Dragging is limited to settings. Changes save immediately. Reset order preserves display mode, visibility, and item placements.

## Auto-hide

`autoHide` defaults to false. The toolbar and titlebar share an editor-activity signal and a 1.2-second idle timer, with separate appearance settings. Collapse moves the editor up; expansion moves it back. The toolbar slide uses `--motion-feedback`, with its contents fading out before collapse and in during expansion to avoid clipping.

Hidden bars are inert and excluded from keyboard navigation. Pointer movement near the window top, control focus, find, palette, and settings reveal both bars. Reduced motion disables transitions. The find bar sits below the toolbar and its bottom margin, or directly below the titlebar when no toolbar is shown.

## Showing tooltips

`context.tooltips.show({ anchor, text, placement? })` shows plain text by an HTML or SVG element and returns a function that hides that request. `placement` is `top` or `bottom` (default); the host flips sides when needed and keeps it within the viewport. `hide()` affects only the calling scope. Disabling an addon dismisses its tooltip without closing a newer tooltip owned by another addon.

```tsx
import { Button, Tooltip, useTooltips } from '../ui'

<Tooltip text="export this workspace"><Button>export</Button></Tooltip>

// Built-in imperative usage; addons use context.tooltips instead.
const tooltips = useTooltips()
const hide = tooltips.show({ anchor: buttonElement, text: 'ready to export' })
```

`Tooltip` clones one child without adding a layout wrapper. Custom children must forward data attributes to their DOM element. Shared `Button` and `IconButton` convert `title` into this tooltip; `data-tooltip` also works directly.

Use `data-verbatim="true"` on anchors showing filenames, paths, or other user content. Their tooltip text keeps its original spelling in either interface case setting.

Hover waits 400 ms; focus reached through Tab or arrow-key navigation shows help immediately. Clicking or restoring focus does not reopen dismissed help. Touch and dragging do not open hover tooltips. Key presses, pointer down, pointer exit, scrolling, resizing, and window blur dismiss them. Hiding, removing, moving, or changing an anchor also dismisses its tooltip. Invisible anchors cannot open one. The tooltip temporarily adds its ID to `aria-describedby`, preserving existing IDs. Text stays inert; markup never executes.

`DialogProvider` mounts one `TooltipHost`. Standalone renderers can mount it explicitly. Native popovers place tooltips above modals without blocking clicks. All app hints use compact dark surfaces, white semibold text, and a small arrow toward the control. Long text wraps within the viewport. Motion uses shared timing tokens and respects reduced motion.

See the [toolbar API](../reference/toolbar-api.md) and [tooltip API](../reference/tooltip-api.md).
