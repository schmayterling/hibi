# Shared UI and themes

Use the controls exported by `src/addons/ui.ts` instead of copying their markup. The app and exported documentation share `src/ui/tokens.css`; `npm run docs:check` checks its [generated reference](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2Ftheme-tokens.md).

## Colors and measurements

Components use semantic colors: `--background`, `--surface`, `--sidebar`, `--ink`, `--muted`, `--accent`, `--border`, and `--overlay`. Interaction colors include `--hover`, `--active`, `--selection`, `--selection-ink`, and `--caret`. Code uses `--code-background`, `--code-ink`, and `--syntax-*`.

`src/shared/color-palettes.ts` defines the nine bundled schemes. `src/ui/colorschemes.ts` applies them without remounting editors. Preferences store an appearance mode and a light/dark pair. Electron validates and saves solid window colors before creating the next window.

Base tokens use CSS layer `hibi-base`; palettes use `hibi-theme`. Unlayered addon styles take precedence. Scope overrides with selectors such as `:root[data-colorscheme="catppuccin-mocha"]` or `:root[data-appearance="dark"]`. Register selectable palettes with `context.colorschemes.register` or a package's `themes` field; palettes contain color roles only, never CSS. See [colorschemes](../../guides/colorschemes.md) and the [API](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FColorscheme.md).

UI fonts, sizes, spacing, icons, radii, and motion durations use tokens. Durations are milliseconds. The editor's text fade uses `--motion-feedback`. Document typography, pane geometry, and user-selected padding or sidebar width remain separate. Reduced motion overrides animations.

CSS owns the editor caret's blink animation, including reduced motion. Moving the caret must not query or reset animations: animation discovery and state access can flush pending document layout. Keep its position updates immediate while the existing CSS animation continues naturally.

In split view, the inactive formatted pane refreshes once after 200 ms of source inactivity when every rich attachment declares `preview: 'deferred'`, whatever the document grammar. Canonical edits, history, recovery, and saving remain synchronous. Rich interaction and host formatting flush pending content before reading selections or building transactions; attachments without the declaration keep their existing synchronization. Linked scrolling and the mirrored caret require matching canonical, rich, and published projection versions.

Rectangular controls share the input's 6 px `--radius-control`; popover, panel, pill, shortcut-key, and outer-button tokens alias it. Full-width navigation rows remain square. Switches and range thumbs use `--radius-round`.

## Focus, fields, and actions

Focus indicators sit inside control borders, using the accent color and a negative outline offset. Honor the focus-outline setting for non-input controls. Text inputs keep a visible focus indicator without changing layout.

`src/ui/controls.css` styles text-like native inputs and textareas, including addon controls. Checkbox, radio, range, file, color, and hidden inputs keep their own behavior. Addon CSS should define layout and document rendering rather than duplicate field colors, borders, fonts, padding, or focus styles.

Use `TextInput` and `TextArea` from `src/addons/ui.ts`, or `sdk.ui` in installed extensions. They forward native props and refs. Use the default bordered field for forms, `variant="subtle"` for editable row metadata, and `variant="inline"` inside search or rename controls. Use `monospace` for source fields. Keep labels, descriptions, validation, and disabled states accessible. Textareas resize vertically unless their layout fixes their height.

`--field-background`, `--field-border`, and `--field-placeholder` inherit theme colors. The control padding, height, and radius tokens align fields with actions. Hover, focus, invalid, disabled, placeholder, and reduced-motion states are shared. Rename fields retain row icons, nesting, and text size; their focus cue is an underline. Find-in-note uses the enclosing search field's focus indicator. Command-palette search has no border or focus underline.

`Button variant="primary"` uses the theme's inverse foreground/background pair, as does the older `dialog-primary` class. Hover must preserve both colors for primary and selected buttons. Disabled buttons keep their disabled appearance on hover. `variant="ghost"` is for quiet inline actions; `variant="row"` is for full-width selectable results. Selected rows also apply the selection foreground to muted counts and icons.

## Settings

Use sentence case for labels and descriptions. Preserve names such as GitHub, Vim, Markdown, and Typst. Controls inherit the optional lowercase style through `--ui-text-transform`; document content and editable values must never inherit it. Use `verbatim: true` for case-sensitive status data, such as Vim commands. Shared labels, menus, dialogs, notifications, and ordinary status text normalize case when rendered.

Group related rows on one surface with inset separators. Put the label on the left and the control on the right. Add a description only when the label needs explanation; `SettingRow` accepts one as an optional prop. Controls, shortcut badges, and reset buttons must wrap within narrow panels. Give distinct groups a heading and use shared heading margins so adjacent cards remain separate.

Use `SettingsFilter` for search and reset. Keep filtered `SettingRow` components mounted with `hidden` so the command palette can find them. Palette navigation clears the filter to reveal its target. Reset applies to the whole page, including hidden results. See the [component reference](https://docs.hibi.garden/#page=development%2Faddon-api-reference%2FSettingsFilter.md).

The titlebar holds sidebar controls, tabs, and view switches. New, open, and save actions live in the File menu; settings and the command palette are available from View or their shortcuts. Opening settings focuses its selected sidebar category. **Back to app** and Escape return to the editor. App and Electron versions appear in the settings sidebar footer.

## Layout and motion

The rich editor disables font pair kerning. In native Chromium measurements, replacing a 240,000-character unbroken word in Geist otherwise spent seconds in selection-triggered layout; disabling kerning kept the same operation in tens of milliseconds. This changes adjacent-letter spacing and may shift line breaks. Wrapping, ligatures, required script shaping, selection, and source content retain their normal behavior. It does not make the complete rich document a viewport-bounded model.

Headers use an opaque page-colored backing so content cannot scroll over controls. App backings move and fade with their editor/settings layer; the exported site's backing sits below its full-height sidebar. Avoid separate scroll listeners or edge animations.

`--titlebar-edge-inset` reserves macOS traffic lights or Windows/Linux caption controls. Titles have a 16 px inset when no action icons precede them. The operating system controls the window's outer shape.

When typing hides both bars, their reserved height collapses too, keeping document padding even. A pinned toolbar keeps its window-control inset. Focused titlebar controls and an open find bar keep the bars visible. Short file operations mark the toolbar busy without flashing its icons.

`PanelMessage` centers an icon, title, and optional description. Its loading pulse respects reduced motion. Startup placeholder CSS loads from HTML before JavaScript and uses system light/dark colors until the chosen palette is available.

The command palette uses one moving selection background for keyboard, pointer, and filtered results. Reduced motion disables the transition. `Modal` supplies focus trapping and dismissal; `DialogProvider` queues app and addon dialogs.

## Shared components

- `Sidebar`: tree or flat navigation, section labels, keyboard focus, selection motion, and resizing. Selection offsets include section heights; keyboard navigation skips labels.
- `SettingRow`: labels, descriptions, and controls.
- `Toggle`: a switch with native checkbox semantics.
- `Select`: native selection behavior with shared spacing and a chevron.
- `Button` and `IconButton`: text and icon actions with shared sizing and states.
- `TextInput` and `TextArea`: fields, filters, and source forms.
- `Panel` and `ControlRow`: compact panel spacing and wrapping controls.
- `ShortcutKeys`: consistent shortcut formatting and key badges.

Use `ShortcutKeys` with the effective binding and platform instead of separate `kbd` markup or hard-coded modifier symbols. Its `--key-*` tokens style every shortcut hint. Text tooltips use the same formatter. Exported documentation uses its own Cmd/Ctrl+K binding.

The page outline nests headings under the nearest preceding lower-level heading. Every heading navigates, and branches stay open through `collapsible: false`. Selection follows the cursor's section in rich, source, and split views.

Addon status items use `context.statusBar`. The bar reserves space below the editor only when it has visible items, moves with the editor page, and leaves the sidebar full-height. Keep visualizations and rendered documents in their own layout styles.
