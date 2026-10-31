# LaTeX

Turn on **LaTeX** in **Settings → Addons** to write LaTeX documents and add equations to Markdown.

## LaTeX documents

Open a `.tex` file or choose **New LaTeX document**. Install Tectonic, then choose **Compile document** in side-by-side view to preview the PDF. Choose **Export PDF** to save it.

Use **Check tools** in the addon's settings to check your installation, or **Manage dependencies** to open **Settings → Dependencies**. There you can install Tectonic, choose an executable, and see its version. Save files included by your document before compiling; Hibi uses the active note's unsaved text.

Tectonic downloads packages as needed. You can search for packages or clear downloads under **Settings → LaTeX → Packages**. Add them to your document with `\usepackage{package-name}`.

## Equations in Markdown

Write `$x^2$` for an inline equation. As in Obsidian, the expression can't start with a space or tab, and the first `$` after it closes it unless a space or tab comes before that `$` or a digit after it, so currency such as `$5 and $10` stays text. An inline equation can continue on the next lines of its paragraph and can end right before another `$`. For a centered display block, start a line with `$$`, optionally indented by up to three spaces. Write `$$x^2$$` on that line, or put the expression between separate `$$` lines. The closing delimiter must end its line, apart from spaces or tabs. These rules also apply inside list items and blockquotes, after their Markdown prefixes.

The CodeMirror formatted view also renders `$$x$$` within a heading, paragraph, or table cell as display math, as Obsidian does. The next `$$` closes the expression, even on a later line of the same paragraph. The expression can contain single dollar signs or be blank, and an escaped `\$` inside it never closes it. HTML and PDF exports and Source view's outline read these expressions the same way, as do the formatted view's outline and word counts. The rich editor keeps these pairs as literal text and preserves their delimiters when saving. Use `$x$` for an inline equation in either editor. The outline includes headings with math and headings after math inside lists, blockquotes, and callouts.

A backslash makes the dollar sign after it literal, so `\$x$` stays text. In `\$$x$$`, as in Obsidian, the first dollar sign is literal and `$x$` is an inline equation before the last one; write `\$\$x\$\$` to keep it all literal. Visual edits keep literal text literal when saving; the placement of backslashes can change. An expression longer than 10,000 characters shows as text, dollar signs included.

You can also insert equations from the toolbar or command palette. Click a rendered equation to edit it.

In long notes, equations on screen render first. The others show their source for a moment while they render in the background, so you can start typing right away.

Choose which math features to use in **Settings → Syntax**.

Automatic flavor detection ignores dollar signs inside code and escaped dollar signs.

## Credits

This addon uses MIT-licensed [KaTeX](https://katex.org/docs/security), listed in Hibi's **Open source licenses**.
