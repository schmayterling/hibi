# marked block boundary audit

base: `8ffb86cc`. scope: built-in addons and shared marked paths, including export/preview, counts and outline consumers.

fixed: typst emitted `typstBlock` before marked handled its own fences. marked's quote parser only ends lazy continuation after native code/heading/hr/html tokens. typst now leaves native `code` tokens intact, renders closed fences from that token, and consumes the same native tokens in the rich editor and word counter. its detection parser no longer registers export renderers. closed-only detection stays intact. source extraction and serialization reuse the shared native fence helpers. typst now shares marked's closer grammar, including rejecting tab-suffixed and unicode-line-separator false closers.

`tests/marked-block-boundaries.test.mjs` compares raw marked with 13 flavor/consumer configurations over 1,344 cases each: quotes, nested quotes, ordered/unordered lists, mixed containers, lazy lines, setext headings, closed/unclosed backtick/tilde fences, other languages, lf and crlf. it also checks rich typst/mermaid parsing, export through `renderMarkdown`, and diagram word counts. baseline failed in typst, count and combined configurations; the exact reported quote reproduction also failed before the fix.

| audited path | result |
| --- | --- |
| typst `syntax.ts` and `Block.tsx` | fixed: native `code` tokens; no custom block tokenizer or start hint remains |
| mermaid `markdown.ts`, `Block.tsx`, `index.tsx` | earlier native-code fix intact; export transforms rendered code, no custom marked block tokenizer |
| math `blockMath`, rich `engine.ts` | fence corpus unchanged; own syntax has unresolved continuation case below |
| text-extras `subtextToken`, rich `Subtext` | single-line regex and bounded start hint; own syntax has unresolved continuation case below |
| markdown `alertToken` / `GithubAlert` | outer quote span comes from native tokenizer, but custom token identity still affects nested continuation; see below |
| markdown footnote export, detector and count wrapper | uses `marked-github-footnote`; native-fence corpus unchanged, definition body continuation unresolved below |
| markdown `NativeTableKit` | wraps native table tokenizer; bounds start to two lines; no custom fence token identity |
| markdown obsidian and shared `noteParser` | wiki links, embeds and highlights are inline only |
| frontmatter | prefix projection via shared frontmatter reader; no marked block tokenizer; projected body included in corpus |
| graph | no marked block tokenizer; consumes workspace graph data |
| bbcode / shared format renderer registrations | document-syntax declarations, not marked tokenizer extensions |
| shared `BlockTokenizer` / `blockMarkdown` | native list, quote, code, fence, definition, setext and paragraph overrides preserve native types; corpus passes |
| shared semantic/reference parsers | use `BlockTokenizer` plus math/alerts/subtext; native-fence corpus passes |
| word count | typst custom tokenizer removed; now masks enabled closed typst code blocks; disabled and unclosed cases tested |
| `_shared/block-start.ts` | already uses marked paragraph interruption grammar; existing bounded-work suite retained |
| `_shared/fenced-block.ts` | native `Tokenizer.fences`; added closed-fence mode from its own match captures, reused by typst |

## evidence

- fail-first oracle: 9 passed, 3 failed (typst, counts, combined). exact reported quote: 0 passed, 1 failed.
- final node gate: 259 passed, 0 failed, 4 explicit todo reproductions. build/typecheck, biome, copy check and docs links passed.
- typst desktop suite: 2 passed, covering both engines. startup-performance: 10 passed; startup closure 691,804 bytes (170 below the gate). math-rendering: 9 passed.
- docs-export: 1 passed. site-export: 8 passed. site: 7 passed, 2 failed (one codemirror navigation subtest and its parent); targeted retry: 1 passed, 2 failed. the missing `jump 0` link repeats at `tests/site.test.mjs:522`.
- markdown-semantics-native: 19 passed, 1 failed in each of two runs. the codemirror reference-url edit does not publish the expected document source within 7 seconds (`tests/markdown-semantics-native.test.mjs:880`). these two desktop gates remain unresolved.
- selected main runs total 315 passed, 3 failed, 4 todo; retries are recorded separately. large outline/corpus/search and 2,000-formula stress cases were excluded by lane rules.

## unresolved

four executable todo cases remain in the boundary suite. each appends `\noutside\n===\n\n# real\n` to the following body and expects top-level headings `outside`, `real`:

1. math: `> $$\n> x\n> $$` produces only `real`.
2. subtext: `> -# small` produces only `real`.
3. nested alert: `> > [!NOTE]\n> > \x60\x60\x60\n> > x\n> > \x60\x60\x60` produces only `real`.
4. footnote: `[^1]: \x60\x60\x60\n    x\n    \x60\x60\x60` puts `outside` inside the footnote definition, not at top level.

math and subtext also retain an unindented setext heading inside a preceding list item: `- $$\n  x\n  $$\noutside\n===` and `- -# small\noutside\n===`. a quote-only adapter would leave these list boundaries inconsistent. these require a separate container grammar change, rather than extending the diagram fix with another token-type substitution. no temporary parser adapter is retained.

the existing tiptap code-block handler omits ordinary fences with an indented opener. invalid typst closers now correctly fall back to native code and expose that existing omission too; counts intentionally retain native marked text. the existing explicit omission test covers both ordinary code and typst rather than treating tiptap's omission as the count oracle.

this checkout predates the pdf lane's `renderExportDocument`; its shared `renderMarkdown` export entry is tested directly. full-repo tests and the large word-count corpus are excluded by lane rules.
