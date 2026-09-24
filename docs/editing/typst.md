# Typst

Enable **Typst** under **Settings → Addons**, then open a `.typ` file or run **New Typst document** from the command palette. No separate Typst installation is needed.

To use features from a newer Typst release, turn on **Use system Typst** in the Typst addon settings. Install Typst and check or choose its executable under **Settings → Dependencies**. Hibi then uses that compiler for previews and PDF export. Turn the option off to use the bundled compiler again.

## Write and export

Use Source view to edit Typst, or Side-by-side for a live typeset preview. Typst has no visual editor.

Choose **Export PDF** above the preview, or run **Export Typst PDF** from the command palette.

## Typst inside Markdown

Use **Insert Typst block** from the command palette or slash menu, or add a fenced block:

````markdown
```typst
$ integral_0^1 x dif x = 1/2 $
```
````

Use the block's pencil button to edit its source or its PDF button to export it. For inline `$…$` math, enable the separate LaTeX addon.

## Local files and limits

Keep imports, images, data, and fonts inside the workspace or current file's folder. Hidden files and symbolic links are unsupported, and automatic package downloads are disabled.

If a project exceeds a size or time limit, the preview explains the error. The [addon page](../../src/addons/typst/README.md) includes credits and bundled font notices.
