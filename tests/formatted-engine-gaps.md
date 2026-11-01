# formatted view product gaps

these todos execute their assertions. each row identifies a reproduced gap, its annotation, and the owning product work. the product fix must remove the todo and this row, then rerun the complete file. setup failures and flakes do not belong here.

`HIBI_EXPECT_FORMATTED_GAPS=0 node --test tests/formatted-engine-gaps.test.mjs` checks that none remain. the count is annotation count; a shared annotation can execute in more than one fixture. locations identify the todo option or literal map entry to remove.

| gap id | test file:line | behavior | owning slice |
| --- | --- | --- | --- |

## accepted differences

corpus-004, corpus-014: a reference in a `-# ` subtext line resolves against a definition later in the note in the formatted view ([markdown-semantics-native.test.mjs:118](markdown-semantics-native.test.mjs#L118), [markdown-semantics-native.test.mjs:119](markdown-semantics-native.test.mjs#L119)). Export and word count read subtext text before later definitions exist, so they leave it literal. Each asserts its own outcome.
