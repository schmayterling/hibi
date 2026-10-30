# LaTeX

Turn on **LaTeX** in **Settings → Addons** to write LaTeX documents and add equations to Markdown.

## LaTeX documents

Open a `.tex` file or choose **New LaTeX document**. Install Tectonic, then choose **Compile document** in side-by-side view to preview the PDF. Choose **Export PDF** to save it.

Use **Check tools** in the addon's settings to check your installation, or **Manage dependencies** to open **Settings → Dependencies**. There you can install Tectonic, choose an executable, and see its version. Save files included by your document before compiling; Hibi uses the active note's unsaved text.

Tectonic downloads packages as needed. You can search for packages or clear downloads under **Settings → LaTeX → Packages**. Add them to your document with `\usepackage{package-name}`.

## Equations in Markdown

Write `$x^2$` for an inline equation. As in Obsidian, the expression can't start with a space or tab, and the next `$` closes it, skipping any `$` with a space or tab before it or a digit after it: `$a $b$` is the equation `a $b`, and currency such as `$5 and $10` stays text. An inline equation can continue on the next lines of its paragraph and can end right before another `$`.

For a centered display block, put the expression between `$$` lines, optionally indented by up to three spaces. As in Obsidian, the expression can start on the opening line, as in `$$ x^2`, and end on the closing one, as in `x^2 $$`: the block ends at the first line that ends in `$$`, apart from spaces, with no other dollar sign on it. A line such as `x $$ y` or `$$ more` doesn't close it, and a backslash before the closing `$$` escapes nothing. Without a closing line, the block runs to the end of its quote, list item, or note. To keep `$$` lines inside a block, open it with `$$$` and close it with `$$$`. A `$$` line with another dollar sign on it, such as `$$x^2$$`, is display math within its paragraph instead. These rules also apply inside list items and blockquotes, after their Markdown prefixes.

The CodeMirror formatted view also renders `$$x$$` within a heading, paragraph, or table cell as display math, as Obsidian does. The next `$$` closes the expression, even on a later line of the same paragraph. The expression can contain single dollar signs or be blank, and an escaped `\$` inside it never closes it. HTML and PDF exports and Source view's outline read these expressions the same way, as do the formatted view's outline and word counts. The rich editor keeps these pairs as literal text and preserves their delimiters when saving. Use `$x$` for an inline equation in either editor. The outline includes headings with math and headings after math inside lists, blockquotes, and callouts.

A backslash makes the dollar sign after it literal, so `\$x$` stays text. In `\$$x$$`, as in Obsidian, the first dollar sign is literal and `$x$` is an inline equation before the last one; write `\$\$x\$\$` to keep it all literal. Visual edits keep literal text literal when saving; the placement of backslashes can change. An expression longer than 10,000 characters shows as text, dollar signs included; a display block that long still ends at its closing line, so that line starts nothing.

You can also insert equations from the toolbar or command palette. Click a rendered equation to edit it.

In long notes, equations on screen render first. The others show their source for a moment while they render in the background, so you can start typing right away.

Choose which math features to use in **Settings → Syntax**.

Automatic flavor detection ignores dollar signs inside code and escaped dollar signs.

## Credits

This addon uses MIT-licensed [Tiptap Mathematics](https://tiptap.dev/docs/editor/extensions/nodes/mathematics) and [KaTeX](https://katex.org/docs/security), listed in Hibi's **Open source licenses**.
