# Obsidian themes

Use Obsidian themes and CSS snippets in Hibi, in any folder or with no folder open. The addon is off until you enable it in Settings → Addons.

Installed themes and snippets live in Hibi's data folder. Hibi never changes an Obsidian vault: it reads a vault's themes, snippets and appearance settings only to suggest them, and keeps its own copy of what you use.

## Choosing a theme

Obsidian themes appear in Settings → Appearance, in the light and dark colorscheme lists under **Obsidian themes**, next to Hibi's own colorschemes. Choose one for light, for dark, or both. Light or dark follows Hibi's appearance setting, as with any colorscheme. Your choice applies everywhere in Hibi.

Install themes from Obsidian's community directory in Settings → Addon Manager, or choose **Add theme folder…** in Appearance and pick a folder that contains `theme.css` (or `obsidian.css` for older themes). Addon Manager also lists installed themes with their author, version, source and license, and can preview, apply or remove them. Installing never applies a theme on its own.

## Snippets and theme options

Snippets are listed in Appearance, each with its own switch. They apply on top of whichever colorscheme you use.

Many themes offer options through the Style Settings format, such as colours, fonts, widths and layout switches. While such a theme is chosen, its options appear in Appearance below the snippets. Changes apply right away. Hibi reads these options from the theme and never runs the Style Settings plugin.

## Vaults with their own look

When you open an Obsidian vault that uses a theme or snippets in Obsidian, Hibi tells you once and offers them in Appearance. **Use it** copies them into Hibi and turns them on. Nothing changes until you choose it.

## Turning themes off

**Turn off Obsidian themes** in Appearance puts Hibi's own colorschemes back and turns snippets off. If a theme makes Hibi hard to use or hides the settings, you can also:

- choose **Addons → Obsidian themes: turn off** from the menu bar;
- press Command-Option-Shift-O on macOS, or Control-Alt-Shift-O on Windows and Linux;
- choose the **Turn off Obsidian theme** button that shows in the bottom-left corner for a few seconds after a theme applies;
- run **Obsidian themes: turn off** from the command palette;
- start Hibi with `--disable-obsidian-themes`, or with `HIBI_DISABLE_OBSIDIAN_THEMES=1` set, to start without any theme or snippet.

No theme can hide or restyle the menu item, the shortcut or the corner button.

## What to expect

Most themes change Hibi's colours, fonts, headings, links, code, quotes, callouts, tags and properties the way they do in Obsidian. Parts of Obsidian that Hibi doesn't have, such as the ribbon, side docks and hover popovers, are not styled. Hibi's settings pages keep their own look so a theme can't make them unusable. A theme can look slightly different from Obsidian where Hibi draws something in its own way.

## Safety

Themes and snippets are treated as untrusted. Hibi checks every rule before using it and leaves out anything that could load files from the internet or elsewhere on your computer, run code, or hide the whole window. Images and fonts that come with a theme are kept with Hibi's copy. Each theme can be up to 5 MB and each snippet up to 1 MB. Addon Manager lists every rule that was left out of a theme and why.
