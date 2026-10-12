# Creating a theme

A theme package contains color data and does not need JavaScript. Create `hibi-addon.json` and `README.md` in a folder.

```json
{
  "id": "evening",
  "name": "Evening",
  "description": "A dark blue color scheme.",
  "version": "1.0.0",
  "apiVersion": 2,
  "kind": "theme",
  "authors": [{ "displayName": "Your name" }],
  "themes": [{
    "id": "evening-dark",
    "name": "Evening",
    "appearance": "dark",
    "author": "Your name",
    "license": { "name": "Your license", "text": "Your license text" },
    "colors": {
      "background": "#141B2D",
      "surface": "#1E2940",
      "ink": "#E6EDF7",
      "muted": "#ACBAD0",
      "accent": "#A5CDF5",
      "border": "#455773"
    }
  }]
}
```

Replace the author and license with your own information. Use opaque hex colors. The six colors above are required; [ColorschemeColors](../addon-api-reference/ColorschemeColors.md) lists the optional roles. Check that text, controls, and focus indicators remain readable against their backgrounds.

[Install the folder](sideloading.md), enable the theme, and select it in **Settings → Appearance**. A package can include both light and dark schemes in its `themes` array.

Each `themes` entry can also be the path of a JSON file in the package, such as `"themes/evening-dark.json"`, containing one color scheme in the same format. Theme packages contain color data only. An extension that also needs CSS can list the same `themes` entries beside its `styles`; see [stylesheets and themes](sideloading.md#add-stylesheets-and-themes).

For a bundled or local source addon, register a [ColorschemeInput](../addon-api-reference/ColorschemeInput.md) through `context.colorschemes.register()` instead. Keep upstream credits and license notices when adapting another theme.
