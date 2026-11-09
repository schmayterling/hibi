# Obsidian themes

Use an Obsidian vault's theme and CSS snippets in Hibi. The addon is off until you enable it in Settings → Addons, and it only does something while an Obsidian vault is open.

Hibi never changes your vault. It reads the vault's themes, snippets and appearance settings, keeps its own copy of what you choose, and stores your choices in Hibi's data folder. Obsidian keeps working with the vault exactly as before.

## Choosing a theme

Open the vault, then open Settings → Obsidian themes. The page lists the themes and snippets in the vault's `.obsidian` folder and starts from the ones the vault uses in Obsidian.

1. Pick a theme from **Theme**. Its version, author and license show below it.
2. Turn on the snippets you want. Each snippet turns on and off on its own.
3. Choose **Preview** to try the result. The preview lasts until you apply it, end it, or leave the page.
4. Choose **Apply** to keep the theme and snippets for this vault.

Each vault keeps its own choice. Light or dark follows Hibi's appearance setting, not the vault's Obsidian setting. The vault's accent colour and font size are used when the theme leaves them open.

To use a theme that isn't in the vault, choose **Add folder…** and pick a theme folder that contains `theme.css` (or `obsidian.css` for older themes). Themes added this way can be removed again from the same page.

The **Themes** list on the page shows every theme Hibi knows for this vault with its author, version, where it came from and its license, so you can check a theme's origin before you use it.

## Theme options

Many themes offer options through the Style Settings format, such as colours, fonts, widths and layout switches. After you apply such a theme, its options appear below the theme on the settings page. Changes apply right away and are kept for this vault. Hibi reads these options from the theme and never runs the Style Settings plugin.

## When the vault's theme changes

If the theme or a snippet you use changes in the vault, for example after you update it in Obsidian, Hibi copies it again the next time you open the vault. Older copies are cleaned up, but the one you used just before stays, so you can go back to it.

## Turning themes off

**Turn off all** on the settings page removes the theme and snippets for this vault at once. If a theme makes Hibi hard to use or hides the settings, you can also:

- choose **Addons → Obsidian themes: turn off for this vault** from the menu bar;
- press Command-Option-Shift-O on macOS, or Control-Alt-Shift-O on Windows and Linux;
- choose the **Turn off Obsidian theme** button that shows in the corner for a few seconds after a theme applies;
- run **Obsidian themes: turn off for this vault** from the command palette;
- start Hibi with `--disable-obsidian-themes`, or with `HIBI_DISABLE_OBSIDIAN_THEMES=1` set, to start without any theme or snippet.

No theme can hide or restyle the menu item, the shortcut or the corner button.

## What to expect

Most themes change Hibi's colours, fonts, headings, links, code, quotes, callouts, tags and properties the way they do in Obsidian. Parts of Obsidian that Hibi doesn't have, such as the ribbon, side docks and hover popovers, are not styled. Hibi's settings pages keep their own look so a theme can't make them unusable. A theme can look slightly different from Obsidian where Hibi draws something in its own way.

## Safety

Themes and snippets are treated as untrusted. Hibi checks every rule before using it and leaves out anything that could load files from the internet or elsewhere on your computer, run code, or hide the whole window. Images and fonts that come with a theme are kept with Hibi's copy. Each theme can be up to 5 MB and each snippet up to 1 MB. The settings page lists every rule that was left out and why.
