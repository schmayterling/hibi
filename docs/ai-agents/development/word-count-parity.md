# formatted word count parity

formatted counts follow the rendered markdown structure. character totals include block separators, so a different empty list or paragraph can change the total by one even when its visible text is unchanged. these are intended cold-count differences from the rich schema; edits and undo must still match a fresh formatted count.

## list and definition cases

inputs below use literal `\n` escapes. each total is words / characters. the ordered-list rules follow [commonmark 0.31.2](https://spec.commonmark.org/0.31.2/#list-items); tasks and footnotes use their enabled addon syntax.

| input | formatted | rich schema | classification |
| --- | --- | --- | --- |
| `1. e\n=` | 1 / 3 | 1 / 4 | list continuation and its block separators |
| `1. 2.` | 0 / 3 | 0 / 4 | nested empty list item |
| `2.\n    e` | 1 / 3 | 1 / 4 | ordered item beginning with an empty line |
| `- [ ]\n ` | 0 / 2 | 0 / 3 | empty task with trailing whitespace |
| `1. one\n2.\n two` | 2 / 11 | 3 / 12 | empty ordered item, with gfm on or off; the rich tokenizer retains `2.` as text |
| `1. one\n[^a]:` | 1 / 5 | 2 / 11 | empty footnote definition next to a list; schema comparison only |

the four one-character differences retain the formatted view's list structure rather than introducing extra separators to imitate a different rich schema. the empty ordered item is valid commonmark in both gfm settings. the footnote case follows the enabled definition syntax, which is outside core commonmark; native rich editing may use a source fallback, so this is not an active-rich parity claim.

[the projection regressions](../../../tests/word-count-formatted.test.mjs) pin these cases against both counters and the real rich markdown parser and schema. a task marker followed by a tab is not an intended difference: `- [ ] a\n- [ ]\tbuy milk` must count as 3 words / 13 characters in both formatted engines. [gfm task markers](https://github.github.com/gfm/#task-list-items-extension-) permit whitespace after the marker.

## other pinned differences

existing controls retain document-wide forward reference and footnote semantics in tasks, ignore duplicate link definitions, keep the nine-digit ordered-marker limit, preserve code from indented fences the rich schema omits, and retain extra blank paragraphs after task lists. see the projection regressions and [schema corpus](../../../tests/word-count-corpus.test.mjs) for exact inputs and results. these exceptions do not permit stale counts after a source edit, undo, document switch, or syntax change.
