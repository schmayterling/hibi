# Obsidian themes

Use the theme and CSS snippets of an Obsidian vault in Hibi. The addon is off until you enable it.

When you open a vault, the settings page lists the vault's themes and snippets and starts from the ones the vault uses in Obsidian. Choose **Preview** to try a theme, **Apply** to keep it for this vault, or **Add folder…** to use a theme folder from elsewhere. Snippets turn on and off one at a time. Light or dark follows Hibi's appearance.

Many themes offer options through the Style Settings plugin format. Once a theme is applied, its options appear on the same page, and your choices are kept for each vault. Hibi reads these options as data and never runs the plugin.

Hibi never changes the vault. It reads `.obsidian/themes`, `.obsidian/snippets` and `.obsidian/appearance.json` (or the vault's renamed settings folder) and keeps its own copy of each theme, with its version, author and license, in Hibi's data folder. Your choices for each vault are stored there too.

## Safety

Theme CSS is treated as untrusted data. Before it is used, Hibi:

- removes `@import`, `@charset`, `@namespace`, `@property` and unknown at-rules;
- removes any declaration that loads a remote, `file:`, `app:` or `javascript:` URL, a `data:` URL other than an image or font, `expression()`, `behavior` or `-moz-binding`;
- removes `var()`, `env()` and `attr()` inside image functions, typed `attr()`, URL-like strings in custom properties, and `url(#id)` outside SVG references such as `filter`;
- reads its own output back and drops any rule that would load something it did not write itself;
- removes properties that could hide, cover or move the whole page, such as `opacity`, `filter`, `transform`, `display` or `position`, from rules on `html` and `:root`;
- renames a theme's variables that share a name with Hibi's own, such as `--accent`, so they keep working for the theme without changing Hibi;
- checks stored copies again when the checks change;
- replaces images and fonts from the theme's own folder with copies inside the CSS, and removes references that leave the folder;
- refuses themes over 5 MB and snippets over 1 MB.

Every removed rule is listed under the theme on the settings page.

## If a theme hides the settings

- Choose **Addons → Obsidian themes: turn off for this vault** from the menu bar, or press Command-Option-Shift-O (Control-Alt-Shift-O on Windows and Linux).
- After a theme applies, a **Turn off Obsidian theme** button shows in the corner for 12 seconds. Themes cannot hide or restyle it.
- Run **Obsidian themes: turn off for this vault** from the command palette.
- Start Hibi with `--disable-obsidian-themes`, or with `HIBI_DISABLE_OBSIDIAN_THEMES=1` set, to start without any theme or snippet.

## How themes reach Hibi's interface

All theme CSS goes into one stylesheet that is removed at once when you turn the theme off.

**Variables.** Obsidian themes set Obsidian's variables on `body`. The addon gives `body` Obsidian's default variables, taken from Hibi's current colours, and then reads Hibi's own colour, font and size tokens back from them (`bridge.ts`). A theme that only sets variables therefore recolours Hibi, and a variable a theme leaves alone keeps Hibi's look.

**Selectors.** `body` gets `theme-dark` or `theme-light`. Other Obsidian classes are rewritten to also match the Hibi element that plays the same part, for example `.HyperMD-header-1` becomes `:is(.HyperMD-header-1, .hibi-lp-h1)` (`SELECTOR_ALIASES` in `sanitize.ts`). Hibi's interface and editor redraw their own class names, so classes added to their elements would not last. Settings controls (`.checkbox-container`, `.vertical-tab-*`, `.setting-item`) are left unmatched on purpose so a theme cannot break the settings page.

### Coverage

Measured against the 47 themes that parsed in the 50 most downloaded community themes (`theme-survey`, 2026-10-27):

| Measure | Covered |
| --- | --- |
| Top 30 classes, by number of themes | 24 of 30; 85.8% of their uses |
| Top 50 classes | 40 of 50; 85.8% of their uses |
| Top 100 classes | 66 of 100; 76.3% of their uses |
| Every class use in the survey | 33.4% |
| Top 30 variables themes define | 27 of 30 |
| Top 30 variables themes refer to | 26 of 30 |
| Theme references to documented variables that resolve | 912 of 2,476 (36.8%) |

Covered classes include `.cm-line` and `.modal`, which Hibi already has, and Obsidian's state classes (`is-active`, `is-selected`, `mod-active`, `is-collapsed`), which match Hibi's ARIA and data attributes. While a theme is on, source editors also carry Obsidian's token classes (`.cm-header-N`, `.cm-strong`, `.cm-em`, `.cm-link`, `.cm-url`, `.cm-quote`, `.cm-hr`, `.cm-inline-code`, `.cm-formatting`). The most common classes left out have no Hibi equivalent: the ribbon and side docks (`workspace-ribbon`, `mod-left`, `mod-right`), task list lines, popovers and folder rows. Settings controls (`checkbox-container`, `dropdown`, `vertical-tab-*`) are left out on purpose, and `is-mobile` never matches. Variables left out are `--text-highlight-bg`, `--background-modifier-error`, `--tag-background`, `--header-height`, `--accent-h` and the cyan and orange palette colours. Selector coverage shows which rules can match; it does not measure how close a theme looks to Obsidian.
