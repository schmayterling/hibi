# LaTeX

Turn on **LaTeX** in **Settings → Addons** to write LaTeX documents and add equations to Markdown.

## LaTeX documents

Open a `.tex` file or choose **New LaTeX document**. Install Tectonic, then choose **Compile document** in side-by-side view to preview the PDF. Choose **Export PDF** to save it.

Use **Check tools** in the addon's settings to check your installation, or **Manage dependencies** to open **Settings → Dependencies**. There you can install Tectonic, choose an executable, and see its version. Save files included by your document before compiling; Hibi uses the active note's unsaved text.

Tectonic downloads packages as needed. You can search for packages or clear downloads under **Settings → LaTeX → Packages**. Add them to your document with `\usepackage{package-name}`.

## Equations in Markdown

Write `$x^2$` for an inline equation or use `$$` delimiters for a centered block in display math style. You can also insert equations from the toolbar or command palette. Click a rendered equation to edit it.

Choose which math features to use in **Settings → Syntax**.

Automatic flavor detection ignores dollar signs inside code and escaped dollar signs.

## Credits

This addon uses MIT-licensed [Tiptap Mathematics](https://tiptap.dev/docs/editor/extensions/nodes/mathematics) and [KaTeX](https://katex.org/docs/security), listed in Hibi's **Open source licenses**.
