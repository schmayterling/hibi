# Typst

Turn on **Typst** in **Settings → Addons** to write and preview typeset documents. Open a `.typ` file or choose **New Typst document** from the command palette.

Use source view to write or side-by-side view to see the preview. Choose **Export PDF** to save the result.

To compile with an installed Typst version, turn on **Use system Typst** in this addon's settings. Choose its executable under **Settings → Dependencies** if Hibi does not find it. The bundled compiler remains available when this option is off.

## Typst in Markdown

Choose **Insert Typst block** from the command palette or slash menu, or write a fenced block:

````markdown
```typst
$ sum_(k=1)^n k = (n(n+1))/2 $
```
````

Click the block's pencil button to edit it or its PDF button to export it. Markdown's inline `$…$` equations use the separate LaTeX addon.

Automatic flavor detection requires a closed Typst fence. A Typst example inside a longer code fence does not count as a preview block.

## Files and packages

Local imports must stay inside your workspace, or the current file's folder when no workspace is open. Packages are not downloaded automatically.

See the [Typst guide](../../../docs/editing/typst.md) for more help.

## Credits

- [Typst](https://github.com/typst/typst) is by the Typst project developers, under Apache-2.0.
- [typst.ts](https://github.com/Myriad-Dreamin/typst.ts) is by Myriad-Dreamin and contributors, under Apache-2.0.
- Bundled fonts and assets keep their [upstream notices](../../../docs/licenses/typst-assets.md), also in Hibi's **Open source licenses**.
