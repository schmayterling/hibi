# marked block boundary audit

base: `54aa91a6` (merged main, including the pdf export path, electron teardown fixes and legacy footnote-detector correction). scope: every built-in addon and shared marked path used by export, split preview, word counts, references and outline semantics.

## fixes

- typst leaves marked's native `code` tokens intact. closed-only detection, rich parsing, serialization, export and word counts reuse native fence parsing. mermaid's earlier native-code fix remains intact.
- math and subtext mark complete custom blocks as leaves. during native container parsing only, the shared adapter gives them native code identity, then restores their public token types. quoted blocks stop lazy continuation through marked's own blockquote code. lists validate continuation against the indentation recorded by marked and re-read only the shortened native list when a complete leaf ends it. incomplete math retains ordinary paragraph behavior.
- alerts retain native quote text while marked re-reads nested quotes. the registered alert reader is reapplied to the resulting quote, preserving the alert body and the headings after it. tab-normalization wrappers retain reader registration, so tabbed nested alerts keep their styling and literal code bytes.
- footnote definitions are bounded by marked's native list grammar before the existing footnote renderer stores their content. closed code and other completed blocks cannot absorb a following unindented heading. export, reference detection during rendering and both count paths share the adapter.
- catalog detection stays lightweight. runtime syntax upgrades the existing math and text-extras detector objects, preserving startup metadata snapshots. container adapters and math paragraph escaping remain behind editor/export loading.

## audit inventory

| path | result |
| --- | --- |
| typst `syntax.ts`, `markdown.ts`, `Block.tsx` | fixed: native code tokens; no custom fence tokenizer |
| mermaid `markdown.ts`, `Block.tsx`, `index.tsx` | native-code fix intact; no regression |
| math `blockMath`, runtime `syntax.ts`, rich `engine.ts` | fixed: native leaf and list continuation boundaries |
| text-extras `subtextToken`, runtime `syntax.ts`, rich `Subtext` | fixed: native leaf and list continuation boundaries |
| markdown `alertToken`, `GithubAlert` | fixed: nested native quote continuation and custom body retained |
| markdown footnote export and count wrappers | fixed: shared `marked-footnotes.ts` bounds definitions with native list grammar |
| lightweight catalog and shell detectors | boolean probes only; do not publish structural tokens; runtime detectors upgrade in place |
| markdown `NativeTableKit` | native table tokenizer with a two-line start hint; no custom fence identity |
| markdown obsidian and shared `noteParser` | wiki links, embeds and highlights are inline only |
| frontmatter | shared prefix projection, not a marked block tokenizer; projected body included in the oracle |
| graph | no marked block tokenizer; consumes workspace graph data |
| bbcode and shared format registrations | document-syntax declarations, not marked tokenizers |
| shared `BlockTokenizer` and `blockMarkdown` | native list, quote, code, fence, definition, setext and paragraph rules; custom boundary adapter shared |
| shared semantic/reference parsers and word count | consume the same corrected token boundaries |
| `_shared/block-start.ts` | existing marked paragraph-interruption rules retained; bounded-work tests retained |
| `_shared/fenced-block.ts` | native `Tokenizer.fences`; closed-fence mode reused by typst |

## oracle and export coverage

`tests/marked-block-boundaries.test.mjs` compares raw marked with 13 flavor/consumer configurations over 1,344 cases each: quotes, nested quotes, ordered/unordered lists, mixed containers, lazy lines, setext headings, closed/unclosed backtick/tilde fences, other languages, lf and crlf. custom math/subtext cases additionally compare native code/heading container shapes. alert and footnote cases compare native quote/code boundaries. incomplete syntax remains literal.

the four previous todo reproductions are normal passing tests. each appends `\noutside\n===\n\n# real\n` to:

1. math: `> $$\n> x\n> $$`
2. subtext: `> -# small`
3. nested alert: `> > [!NOTE]\n> > ` + three backticks + `\n> > x\n> > ` + three backticks
4. footnote: `[^1]: ` + three backticks + `\n    x\n    ` + three backticks

the list forms `- $$\n  x\n  $$\noutside\n===` and `- -# small\noutside\n===` also pass. rich typst/mermaid parsing, `renderMarkdown`, flavor detection and word-count behavior are covered. `tests/pdf-export.test.mjs` exports all five corrected cases through `renderExportDocument` and asserts the following headings in the actual print html.

## local evidence

- original typst fail-first oracle: 9 passed, 3 failed; exact reported quote: 0 passed, 1 failed.
- follow-up fail-first cases: 128 passed, 44 failed out of 172.
- expanded boundary suite: 223 passed, 0 failed, 0 todo. further fail-first tests caught extra footnote back-links from discarded quote tokens and inline callbacks in structural probes. both now register each reference once, including plain quotes, alerts and tables.
- merged node gate: 629 passed, 0 failed, 0 todo. includes touched addon/shared code, semantics, outline, mermaid, math, count, flavor-detection and parser-state/quote regressions.
- merged build/typecheck, biome, copy and docs-link checks passed. startup closure is 691,878 bytes against the unchanged 691,974-byte limit; full container adapters stay out of startup.
- final serial desktop/export batch: 99 passed, 3 failed, 0 todo. the three failed results are the two confirmed pre-existing codemirror scenarios below, including the site subtest's parent; no new failure remains.
- passed on the merged base: startup-performance, typst in both engines, math-rendering, github-alerts, formatted-tab-indent, markdown-footnotes, outline-addon-syntax, pdf-export in both engines, docs-export and site-export. the pdf checks confirm all five following headings remain at document level.
- the legacy shell-footnote todo was fixed by main #669 and passes on this base.

## scope and known baselines

no continuation finding is deferred. the tiptap core omission of ordinary indented fences is deliberately outside this follow-up: the owner requested skipping it while tiptap is being removed.

the two codemirror desktop failures also reproduce on main `01d1913b`, confirmed against the cm-reds lane's local logs:

- `markdown-semantics-native`: 19 passed, 1 failed. editing a reference definition's url times out at the source-publication check. cm-reds identified its inline-input link handling; the fix is in #658.
- `site`: 7 passed, 2 failed (the missing `jump 0` subtest and its parent). the test inserts multiline markdown as literal formatted text; cm-reds is replacing that with paste.

neither is attributed to these tokenizers or blocks this pr. full-repo, giant/corpus, large outline and 2,000-formula stress runs remain excluded by lane rules.

## review fixes (2026-10-30, merged with main `93cf4d4e`)

- quote re-reads were quadratic: marked's blockquote calls `blockTokens` once per lazy chunk with the same token list, and the leaf adapter re-checked the whole list each time (2,000 `> # h\n> p\nlazy` units: 4,006,000 visits). it now checks only appended tokens; `leafBlockCounters` guards the bound.
- a leaf ending a nested list did not end the outer item at a lazy line where marked would (`1. - para\n     -# small\noutside`). the adapter now applies marked's previous-line fence/heading check to trailing nested leaves, and detects lazy lines the way marked copies them instead of from container columns, so tab continuations inside quoted lists stay in the item.
- `@tiptap/markdown` copies tokenizer results (`{ ...result }`), which dropped the weak-set identity, so the default rich view still swallowed `outside\n===` after quoted math, subtext and nested alerts while counts and export did not. leaf and quote marks are now symbol-keyed token properties that survive the copy.
- the codemirror formatted view still read typst bodies with the old tokenizer's dedent. it now reads them like mermaid (`markedFenceText`), matching the rich view's native code tokens; `dedentedFenceText` is removed.

timings (node, this machine; export = marked with blockMarkdown + all built-in extensions, count = `richText` + `countText`):

| note | branch export | branch count | main export | main count |
| --- | --- | --- | --- | --- |
| 2 MiB mix | 0.55 s | 0.70 s | 17.3 s | 15.9 s |
| 4 MiB mix | — | — | 69.1 s | — |
| 50 MiB mix | 11.8 s | 16.4 s | > 480 s (stopped) | not run |

single giant blockquotes and lazy-quote chains stay superlinear on main and branch alike (marked's own blockquote loop and `marked-blocks.ts` setext candidate search); not changed here.
