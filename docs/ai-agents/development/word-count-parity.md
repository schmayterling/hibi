# formatted word count parity

formatted counts target the rendered markdown structure. character totals include block separators, so a different empty list or paragraph can change the total by one even when its visible text is unchanged. intended differences from the rich schema and known projection limits are listed below. edits and undo must still match a fresh formatted count.

## list and definition cases

inputs below use literal `\n` escapes. each total is words / characters. the ordered-list rules follow [commonmark 0.31.2](https://spec.commonmark.org/0.31.2/#list-items); tasks and footnotes use their enabled addon syntax.

| input | formatted counter | rich schema | classification |
| --- | --- | --- | --- |
| `1. e\n=` | 1 / 3 | 1 / 4 | projection limit: marked reads a heading; the rendered `=` text would count 1 / 5 |
| `1. 2.` | 0 / 3 | 0 / 4 | nested empty list item |
| `2.\n    e` | 1 / 3 | 1 / 4 | ordered item beginning with an empty line |
| `- [ ]\n ` | 0 / 2 | 0 / 3 | empty task with trailing whitespace |
| `1. one\n2.\n two` | 2 / 11 | 3 / 12 | empty ordered item, with gfm on or off; the rich tokenizer retains `2.` as text |
| `1. one\n[^a]:` | 1 / 5 | 2 / 11 | empty footnote definition next to a list; schema comparison only |
| `-     [ ] x` | 1 / 7 | 1 / 3 | indented code inside a list item; the rich tokenizer treats it as a task |

the nested empty list, ordered item beginning with an empty line, and empty task retain the formatted view's block separators. the lazy `=` continuation is a projection limit, not an intended difference from the rendered view. the empty ordered item is valid commonmark in both gfm settings. the footnote case follows the enabled definition syntax, which is outside core commonmark; native rich editing may use a source fallback, so this is not an active-rich parity claim.

[the projection regressions](../../../tests/word-count-formatted.test.mjs) pin these cases against both counters and the real rich markdown parser and schema. a task marker followed by a tab is not an intended difference: `- [ ] a\n- [ ]\tbuy milk` must count as 3 words / 13 characters in both formatted engines. [gfm task markers](https://github.github.com/gfm/#task-list-items-extension-) permit whitespace after the marker.

## other task projection limits and differences

- `1. [ ] x` renders a checkbox in the formatted view, while the counter and rich schema keep `[ ]` as text. this is a projection limit for ordered tasks.
- `- [ ] # h`, with a space or tab after the checkbox, keeps `#` as text in both views. the counter re-lexes the first line as blocks and drops `#`; this is a projection limit.
- `- [ ]\tbuy\n\t- [ ]\tnested` retains nested task structure in the formatted view and counter (2 / 14). the rich tokenizer mishandles tab indentation (2 / 17); this is an intended difference from rich.

## other pinned differences

existing controls retain document-wide forward reference and footnote semantics in tasks, ignore duplicate link definitions, keep the nine-digit ordered-marker limit, preserve code from indented fences the rich schema omits, and retain extra blank paragraphs after task lists. see the projection regressions and [schema corpus](../../../tests/word-count-corpus.test.mjs) for exact inputs and results. these exceptions do not permit stale counts after a source edit, undo, document switch, or syntax change.
