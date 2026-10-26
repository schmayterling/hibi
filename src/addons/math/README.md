# LaTeX

Turn on **LaTeX** in **Settings → Addons** to write LaTeX documents and add equations to Markdown.

## LaTeX documents

Open a `.tex` file or choose **New LaTeX document**. Install Tectonic, then choose **Compile document** in side-by-side view to preview the PDF. Choose **Export PDF** to save it.

Use **Check tools** in the addon's settings to check your installation, or **Manage dependencies** to open **Settings → Dependencies**. There you can install Tectonic, choose an executable, and see its version. Save files included by your document before compiling; Hibi uses the active note's unsaved text.

Tectonic downloads packages as needed. You can search for packages or clear downloads under **Settings → LaTeX → Packages**. Add them to your document with `\usepackage{package-name}`.

## Equations in Markdown

Write `$x^2$` for an inline equation. For a centered display block, start a line with `$$`, optionally indented by up to three spaces. Write `$$x^2$$` on that line, or put the expression between separate `$$` lines. The closing delimiter must end its line, apart from spaces or tabs. These rules also apply inside list items and blockquotes, after their Markdown prefixes.

Mid-paragraph pairs such as `text $$x$$` and `text $$x$$ more` stay literal text. Switching between source and visual views preserves their original bytes without adding line breaks. Use `$x$` to render math within a paragraph. Hibi uses this content-preserving rule rather than interpreting mid-paragraph double dollars as an equation; rendering can differ from Obsidian and GitHub.

Use `\$x$` or `\$$x$$` to write literal dollar-delimited text. Visual edits keep that text literal when saving; the placement of backslashes can change. Currency such as `$5 and $10` stays unchanged.

You can also insert equations from the toolbar or command palette. Click a rendered equation to edit it.

In long notes, equations on screen render first. The others show their source for a moment while they render in the background, so you can start typing right away.

Choose which math features to use in **Settings → Syntax**.

Automatic flavor detection ignores dollar signs inside code and escaped dollar signs.

## Credits

This addon uses MIT-licensed [Tiptap Mathematics](https://tiptap.dev/docs/editor/extensions/nodes/mathematics) and [KaTeX](https://katex.org/docs/security), listed in Hibi's **Open source licenses**.
