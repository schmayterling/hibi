# shared ui and theme tokens

command palette selection uses one moving background with the shared selection timing. keyboard navigation, hovering, and filtered results share that marker; reduced motion removes its transition.

shared `Modal` supplies native focus trapping and dismissal for the command palette and dialog API. `DialogProvider` supplies the window-level queue; app and addon dialogs share tokens, controls, spacing, motion, and reduced-motion handling.

titlebar titles receive 16 px of inset when no leading action icons are present. `--titlebar-edge-inset` controls outer chrome spacing: macOS reserves the traffic-light area, while Windows and Linux reserve right-side caption controls. buttons use the shared control radius; the native window shape remains controlled by the operating system.

app and exported-site headers have an opaque page-colored backing, so scrolled settings, plugin pages, and document content cannot overlap their controls. app backings belong to the editor/settings page layers and inherit their position and fade. the site's backing sits below its full-height sidebar. no separate edge animation or scroll listener is needed, so opening settings, reversing a sidebar slide, and resizing cannot produce a second moving color boundary.

desktop and exported documentation use the same `src/ui/tokens.css`. its [generated reference](../reference/theme-tokens.md) is checked by `npm run docs:check`.

## semantic colors

`--background`, `--surface`, `--sidebar`, `--ink`, `--muted`, `--accent`, `--border`, and `--overlay` describe surfaces and foregrounds. `--hover`, `--active`, `--selection`, `--selection-ink`, and `--caret` cover interaction. `--code-background`, `--code-ink`, and the `--syntax-*` roles cover source and rendered markdown. components consume these roles instead of defining their own palette.

`src/shared/color-palettes.ts` holds the nine bundled schemes. `src/ui/colorschemes.ts` applies them for both the app and static site without remounting editors. appearance settings persist a mode and a light/dark pair. Electron receives validated solid background/foreground colors and persists them before the next window is created.

base tokens live in CSS layer `hibi-base`; selected palettes live in `hibi-theme`. unlayered addon CSS overrides retain precedence. `:root[data-colorscheme="catppuccin-mocha"]` and `:root[data-appearance="dark"]` allow scoped overrides. use `context.colorschemes.register` for selectable palettes; arbitrary theme-file loading is not supported. preserve readable contrast. see [colorschemes](../guides/colorschemes.md) and the [generated contract](../reference/colorscheme-api.md).

## shared measurements

UI fonts, type sizes, spacing, control/panel radii, icon size, and motion durations use tokens. durations use milliseconds; the editor's text-fade animation reads `--motion-feedback` too. document typography, pane geometry, and user-selected padding/sidebar width remain separate from UI decoration. reduced-motion preferences override animations.

all rounded app components use the input's 6 px `--radius-control`. popover, panel, pill, shortcut-key, and outer-button radius tokens alias it. full-width navigation rows remain square.

## shortcuts

use `ShortcutKeys` from `src/addons/ui.ts` in addons, or `src/ui/ShortcutKeys.tsx` in core UI. it uses the shared shortcut formatter and keycap styles in every surface: title bar, command rows, hotkey bindings, palette footer, and exported search. pass the effective binding and platform; do not render a separate `kbd` or hard-code a modifier symbol.

`--key-height`, `--key-min-width`, `--key-radius`, `--key-background`, `--key-ink`, and `--key-border` control all shortcut hints together. text tooltips also use the shared formatter. exported documentation always uses its own cmd/ctrl+k binding.

## settings

write UI labels and descriptions in sentence case, preserving proper names such as GitHub, Vim, Markdown, and Typst. the optional lowercase interface style uses `--ui-text-transform`; controls must inherit it. never transform document content or editable field values. status items can set `verbatim: true` for case-sensitive data such as Vim commands. shared setting labels, menus, dialog titles, notifications, and ordinary status labels normalize sentence case at their rendering boundary.

group related rows on one surface with inset separators. each row puts its label and description on the left and its control on the right. controls wrap inside narrow panels, including when the sidebar is widened. keep native input semantics, labels, descriptions, and keyboard focus behavior.

give each distinct settings group a section heading when a page contains multiple groups. editor settings separate saving from layout; appearance separates interface text, colors, cursor, window, toolbar, and notifications. use the shared heading margins so adjacent cards never touch or appear to belong to the previous section.

use `SettingsFilter` for a compact search field and reset-all action. keep filtered `SettingRow` components mounted with `hidden`, so the command palette can still discover every setting. navigation from the palette reveals its target by clearing the filter. reset applies to the whole page, including hidden results. see the [generated component reference](../reference/settings-filter-api.md).

## reusable components

`src/ui/controls.css` owns shared field and action styling. text-like native inputs and textareas inherit themed defaults, including controls supplied by installed extensions. checkbox, radio, range, file, color, and hidden inputs keep their own semantics. extension css should describe layout and document-specific rendering, not recreate field colors, borders, type, padding, or focus rings.

use `TextInput` and `TextArea` from `src/addons/ui.ts` (or `sdk.ui` in sideloaded extensions). both forward native props and refs. their default is the standard bordered field; `variant="subtle"` blends editable metadata into its row; `variant="inline"` embeds input inside a search control or rename row. use `monospace` for yaml, typst, and other source fields. labels, `aria-describedby`, `aria-invalid`, and disabled state remain native. multiline fields resize vertically unless their layout deliberately fixes their height.

`--field-background`, `--field-border`, and `--field-placeholder` inherit semantic theme colors. `--control-padding-x`, `--control-padding-y`, `--control-height`, and `--radius-control` keep fields and actions aligned. focus, invalid, disabled, placeholder, hover, and reduced-motion states are shared. inline rename keeps its borderless appearance and underline focus cue; find-in-note uses its enclosing search field's focus ring. command palette search stays borderless without a focus underline.

`Panel` supplies the compact spacing and typography used by git, graph, and tags. `ControlRow` wraps filter inputs and actions at narrow widths. `Button` supports `variant="ghost"` for quiet inline actions and `variant="row"` for full-width selectable results; rows share hover and selected colors. selected actions also use the selection foreground for muted counts and icons, keeping those details readable across themes. keep data visualizations and rendered documents in their own layout styles.

`Button variant="primary"` uses the theme's inverse foreground/background pair. the legacy `dialog-primary` class uses that same shared rule. hovering primary or selected buttons preserves their color pair; generic hover surfaces must never replace only the background. disabled buttons retain their disabled appearance on hover.

- `Sidebar`: settings categories, workspace tree, and exported navigation share row height, selection motion, focus behavior, and resize controls.
- `SettingRow`: padding, cursor, line-number, window, and addon settings share label/description layout and spacing.
- `Toggle`: native checkbox semantics with one switch style for all settings.
- `Button`: bordered text actions, including resets and apply/cancel actions.
- `Select`: native keyboard/menu behavior with one shared chevron and spacing.
- `TextInput` and `TextArea`: text fields, filters, source forms, and property values share one theme-aware field style.
- `Panel` and `ControlRow`: extension panels share spacing, typography, and wrapping controls.
- `IconButton`: file/view controls, find navigation, workspace actions, palette close, notification close, hotkey actions, and exported navigation share size, radius, and icon stroke.
- `ShortcutKeys`: every visible shortcut uses the same formatter and keycap styles.

sidebar items may introduce a section label. selection offsets include both row and section-height tokens, keeping plugin pages aligned while keyboard navigation skips the labels. app and Electron versions live as small text in the settings sidebar footer.

the page outline nests each heading beneath the nearest preceding heading of a lower level. branches stay open and every heading navigates, including parents. its selection follows the cursor's current section in rich, Markdown, and split views, rather than remembering only the last sidebar click. the shared sidebar's optional `collapsible: false` mode provides this always-open tree behavior without changing workspace folder controls.

plugin status items use one bottom-left pill style through `context.statusBar`. the bar appears only when visible items exist and reserves space below the editor page. it moves and resizes with that page; the workspace sidebar remains full-height beside it.

these components are exported from `src/addons/ui.ts`. use them for new UI instead of copying their markup. grouped panels, input/select controls, notifications, and focus/hover states use the same semantic token values. short file operations mark the toolbar busy without flashing its icons.
