# Notifications

Use `context.toasts` in addons and `useToasts()` from `src/ui/Sonner.tsx` in built-in UI. One shared `Sonner` renders both. The older `context.notify(message)` uses this service too.

Notifications appear at the bottom right and close after five seconds by default. Their progress line shows the time remaining. Hovering or keyboard focus pauses the timer; it resumes when both leave. Reduced motion disables the entrance and exit animations.

Settings → Appearance → Notifications controls position and timeout, including **Never**. Position changes move the current stack; timeout changes apply to future notifications. Top positions sit below window controls. Preferences are saved locally and appear in command-palette search.

```typescript
const notice = context.toasts.show({
  message: 'exporting documentation…',
  description: 'preparing local pages',
  duration: 0,
})
notice.update({ message: 'documentation exported', description: '', variant: 'success', duration: 5000 })
// notice.dismiss() closes this notification; context.toasts.dismissAll() closes this addon's notices.
```

`show` accepts `message` and optional `description`, `variant` (`info`, `success`, or `error`), `duration` in milliseconds, and `action: { label, run }`. A duration of zero disables automatic dismissal and hides the progress line. `update` preserves the remaining time unless given a new duration. Every notification has a close button. Errors use an assertive live region; other notices use polite announcements.

An `action` makes the whole notification clickable and renders a ghost button with its label. The button is the keyboard target; its accessible name is the message followed by the label. Selecting runs `run` once and then dismisses, even if `run` throws. Notifications never take focus. **Focus notifications** (palette command, unbound by default, rebindable in Settings → Hotkeys) focuses the newest one. Toast buttons use `tabIndex={-1}`, so plain `Tab` never enters the stack; inside it, arrows cycle buttons and `Tab` past either end restores focus; `Escape` dismisses it and focus returns to the element focused before entering the stack. Core targets: update available opens About at `install-update`; addon startup and modal-switch errors open Addons at that addon. Main-process notices pass a target string as the second argument on the notice channel; the preload drops unknown targets.

`getPreferences()` returns a copy. `setPreferences({ position, duration })` updates window defaults. Position names use `center`, such as `top-center`; durations range from 0 to 600,000 ms.

Stopping or removing an addon removes its notices and cancels their timers. Old handles cannot bring them back. Notifications appear above an active modal and remain dismissible. They need no desktop notification permission.

See the [toast API](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FToastApi.md) and [dialog API](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FDialogApi.md).
