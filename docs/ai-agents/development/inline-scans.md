# Inline scan audit

Scope: every Marked inline extension and inline tokenizer override in `src/`, on main `5126c8d3`. Complexity below is per inline run of n UTF-16 units. Nested labels and emphasis own separate token arrays. Syntax registration metadata (`math/engine.ts`, `markdown-syntax.ts`, `source-outline-label.worker.ts`) declares no tokenizer.

| Reader | Worst case before this follow-up | Bound |
| --- | --- | --- |
| `shared/note-syntax.ts`: Obsidian embed/highlight starts | Dense lone dollars or currency split one native text run at every math hint; absent `==` and `![[` repeatedly scan its remainder, O(n²). | Independent `inlineStart` caches each marker per token array; O(n). |
| `addons/markdown/obsidian-markdown.ts`: embed/wiki/highlight starts | Absent markers amid ordinary links or dollar hints, O(n²). | Same independent marker caches; O(n). |
| Obsidian embed/wiki tokenizers in both paths | Exporter's repeated unclosed `![[a ` scans to the same missing closer, O(n²). Note parser already caches the next `]`/line boundary. | Both use the existing forward reader in `shared/marked-obsidian.ts`; O(n). Successful labels consume what they copy. |
| Obsidian highlight tokenizer in both paths | Exporter's repeated `==a ` without a closer scans the same suffix, O(n²). Note parser already caches its closer/line boundary. | Both use the existing forward reader, including single-character fallback; O(n). |
| `addons/math/grammar.ts`: inline math start | Absent dollar amid ordinary Markdown tokens was fixed in #1026. | `inlineStart('$')`, O(n). |
| Math tokenizer, `inline-display.ts` | Many currency candidates can share a rejected closer. | Per-run `Closers` searches each closer once. Double-dollar search has existing 65,536-unit ceiling; no new ceiling here. Backslash runs are inspected at their adjacent candidate. |
| `addons/text-extras/grammar.ts`: subscript start | Absent tilde scan was fixed in #1026. | `inlineStart('~')`, O(n). |
| Subscript tokenizer | Missing closer, whitespace edges, or doubled tilde. | Anchored regex cannot cross the next tilde/newline; accepted token consumes its body. O(n). Nested body has no tilde. |
| `shared/marked-footnotes.ts`: dependency reference start | Absent marker scan was fixed in #1026. | `inlineStart('[^')`, O(n). |
| Dependency reference tokenizer and count copy in `word-count/formatted-text.ts` | Dense `[^`, with or without a distant `]`, retries the greedy label regex and case-folded lookup, O(n²). | Separate lane `markdown-footnote-scan-1111`: one delimiter scan and reversed definition trie recognize suffix candidates together before invoking the dependency on a bounded, known reference. |
| `shared/markdown-link.ts`: `LinkTokenizer.reflink` | Delegates to Marked's native reference reader; tracks its lookup key with a proxy. | No added suffix search or retry loop. Native Markdown readers remain upstream responsibility. |

`shared/marked-inline-start.ts` owns both start hints and the tokenizer wrapper that identifies their token array. Its absent-marker cache and suffix-relative offsets were already covered by #1026. No other source inline start/tokenizer was found by searches for `level: 'inline'`, `tokenizer`, `extends Tokenizer`, and `inlineTokens`. Block tokenizers, Lezer node parsers, and external addon code are separate interfaces.

The Obsidian regression suite counts inspected search/regex/character units and checks eight 1 MiB export/count shapes under the existing 20 CPU second budget. Differential checks cover shared note tokens, exported tokens/HTML, count projection, nested runs, and malformed delimiters. No startup budget term or syntax limit changes.
