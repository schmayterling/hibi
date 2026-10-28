# formatted engine product gaps

these todos execute their assertions. each row identifies a reproduced parity gap, its annotation, and the owning product work. the product fix must remove the todo and this row, then rerun the complete native file. setup failures and flakes do not belong here.

owner numbers follow the ordered formatted engine readiness plan. the default flip requires `HIBI_EXPECT_FORMATTED_GAPS=0 node --test tests/formatted-engine-gaps.test.mjs` to pass. the count is annotation count; a shared annotation can execute in more than one fixture. locations identify the todo option or literal map entry to remove.

accepted differences are not gaps; their tests assert each engine. the codemirror side-by-side formatted pane stays editable, with its caret and the markers under it, while the rich editor previews read-only.

| gap id | test file:line | behavior | owning slice |
| --- | --- | --- | --- |
| reload-001 | [addon-reload.test.mjs:783](addon-reload.test.mjs#L783) | addon reload must retain selection and document focus | 3b: addon reload selection and focus |
| reload-004 | [addon-reload.test.mjs:929](addon-reload.test.mjs#L929) | unlocked formatted editor must expose aria-readonly false | 3b: addon reload selection and focus |
| reload-002 | [addon-reload.test.mjs:956](addon-reload.test.mjs#L956) | addon reload must retain selection moved while read-only | 3b: addon reload selection and focus |
| reload-003 | [addon-reload.test.mjs:974](addon-reload.test.mjs#L974) | typing must resume at retained selection after addon reload | 3b: addon reload selection and focus |
| api-001 | [addon-toolbar-command.test.mjs:149](addon-toolbar-command.test.mjs#L149) | api 2 rich selection must report rendered text | 6: verbatim projections and selection contracts |
| completion-001 | [autocomplete-addon.test.mjs:369](autocomplete-addon.test.mjs#L369) | a fresh rich completion list must accept the word with tab | 8a: native input, structure and toolbar state |
| syntax-004 | [code-syntax-settings.test.mjs:238](code-syntax-settings.test.mjs#L238) | code blocks must retain horizontal scrolling | 8c: highlighting and grammar lifecycle |
| syntax-002 | [code-syntax-settings.test.mjs:281](code-syntax-settings.test.mjs#L281) | formatted code highlighting must appear before source-mode lifecycle checks | 8c: highlighting and grammar lifecycle |
| syntax-003 | [code-syntax-settings.test.mjs:430](code-syntax-settings.test.mjs#L430) | formatted code must retain visible tokens on scrolled and wrapped long lines | 8c: highlighting and grammar lifecycle |
| input-001 | [editor-input.test.mjs:2280](editor-input.test.mjs#L2280) | native multiline markdown preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-002 | [editor-input.test.mjs:2284](editor-input.test.mjs#L2284) | native multiline paragraph preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-003 | [editor-input.test.mjs:2286](editor-input.test.mjs#L2286) | native multiline paragraph keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-004 | [editor-input.test.mjs:2290](editor-input.test.mjs#L2290) | native multiline heading middle preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-005 | [editor-input.test.mjs:2294](editor-input.test.mjs#L2294) | native multiline list preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-006 | [editor-input.test.mjs:2298](editor-input.test.mjs#L2298) | native multiline list end preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-007 | [editor-input.test.mjs:2300](editor-input.test.mjs#L2300) | native multiline list end keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-008 | [editor-input.test.mjs:2304](editor-input.test.mjs#L2304) | native multiline item paragraphs preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-009 | [editor-input.test.mjs:2306](editor-input.test.mjs#L2306) | native multiline item paragraphs keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-010 | [editor-input.test.mjs:2310](editor-input.test.mjs#L2310) | native multiline ordered end preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-011 | [editor-input.test.mjs:2312](editor-input.test.mjs#L2312) | native multiline ordered end keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-012 | [editor-input.test.mjs:2316](editor-input.test.mjs#L2316) | native multiline nested list preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-013 | [editor-input.test.mjs:2318](editor-input.test.mjs#L2318) | native multiline nested list keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-014 | [editor-input.test.mjs:2322](editor-input.test.mjs#L2322) | native multiline quote preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-015 | [editor-input.test.mjs:2326](editor-input.test.mjs#L2326) | native table cell input emits one signal with inserted text | 8a: native input, structure and toolbar state |
| input-016 | [editor-input.test.mjs:2330](editor-input.test.mjs#L2330) | native multiline selection preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-017 | [editor-input.test.mjs:2332](editor-input.test.mjs#L2332) | native multiline selection keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-018 | [editor-input.test.mjs:2336](editor-input.test.mjs#L2336) | native multiline bold preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-019 | [editor-input.test.mjs:2338](editor-input.test.mjs#L2338) | native multiline bold keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-020 | [editor-input.test.mjs:2342](editor-input.test.mjs#L2342) | native multiline link end preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-021 | [editor-input.test.mjs:2344](editor-input.test.mjs#L2344) | native multiline link end keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-022 | [editor-input.test.mjs:2348](editor-input.test.mjs#L2348) | native multiline code end preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-023 | [editor-input.test.mjs:2350](editor-input.test.mjs#L2350) | native multiline code end keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-024 | [editor-input.test.mjs:2354](editor-input.test.mjs#L2354) | native multiline stored mark preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-025 | [editor-input.test.mjs:2356](editor-input.test.mjs#L2356) | native multiline stored mark keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-026 | [editor-input.test.mjs:2360](editor-input.test.mjs#L2360) | native table cells selection preserves both source endpoints | 8a: native input, structure and toolbar state |
| input-027 | [editor-input.test.mjs:2362](editor-input.test.mjs#L2362) | native multiline cells preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-028 | [editor-input.test.mjs:2364](editor-input.test.mjs#L2364) | native table cells input preserves rendered cells | 8a: native input, structure and toolbar state |
| input-029 | [editor-input.test.mjs:2366](editor-input.test.mjs#L2366) | native table cells input emits one signal with inserted text | 8a: native input, structure and toolbar state |
| input-030 | [editor-input.test.mjs:2368](editor-input.test.mjs#L2368) | native table cells input advances source version once | 8a: native input, structure and toolbar state |
| input-031 | [editor-input.test.mjs:2370](editor-input.test.mjs#L2370) | native multiline cells keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-032 | [editor-input.test.mjs:2374](editor-input.test.mjs#L2374) | native multiline blocks preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-033 | [editor-input.test.mjs:2376](editor-input.test.mjs#L2376) | native multiline blocks keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-034 | [editor-input.test.mjs:2380](editor-input.test.mjs#L2380) | native multiline blocks into a list preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-035 | [editor-input.test.mjs:2382](editor-input.test.mjs#L2382) | native multiline blocks into a list keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-036 | [editor-input.test.mjs:2386](editor-input.test.mjs#L2386) | native multiline items preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-037 | [editor-input.test.mjs:2388](editor-input.test.mjs#L2388) | native multiline items keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-038 | [editor-input.test.mjs:2392](editor-input.test.mjs#L2392) | native multiline all preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-039 | [editor-input.test.mjs:2396](editor-input.test.mjs#L2396) | native multiline all from a list preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-040 | [editor-input.test.mjs:2400](editor-input.test.mjs#L2400) | native multiline line breaks only preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-041 | [editor-input.test.mjs:2404](editor-input.test.mjs#L2404) | native multiline block kinds preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-042 | [editor-input.test.mjs:2406](editor-input.test.mjs#L2406) | native multiline block kinds keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-043 | [editor-input.test.mjs:2410](editor-input.test.mjs#L2410) | native table into a table selection preserves both source endpoints | 8a: native input, structure and toolbar state |
| input-044 | [editor-input.test.mjs:2412](editor-input.test.mjs#L2412) | native multiline into a table preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-045 | [editor-input.test.mjs:2414](editor-input.test.mjs#L2414) | native table into a table input preserves rendered cells | 8a: native input, structure and toolbar state |
| input-046 | [editor-input.test.mjs:2416](editor-input.test.mjs#L2416) | native multiline into a table keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-047 | [editor-input.test.mjs:2420](editor-input.test.mjs#L2420) | native multiline task preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-048 | [editor-input.test.mjs:2422](editor-input.test.mjs#L2422) | native multiline task keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-049 | [editor-input.test.mjs:2426](editor-input.test.mjs#L2426) | native multiline nested list end preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-050 | [editor-input.test.mjs:2430](editor-input.test.mjs#L2430) | native multiline item start preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-052 | [editor-input.test.mjs:2436](editor-input.test.mjs#L2436) | native 500 line input into empty paragraph preserves literal blocks | 8a: native input, structure and toolbar state |
| input-053 | [editor-input.test.mjs:2437](editor-input.test.mjs#L2437) | native 1000 line input into empty paragraph preserves literal blocks | 8a: native input, structure and toolbar state |
| input-054 | [editor-input.test.mjs:2440](editor-input.test.mjs#L2440) | native 500 line input into select all preserves literal blocks | 8a: native input, structure and toolbar state |
| input-055 | [editor-input.test.mjs:2441](editor-input.test.mjs#L2441) | native 1000 line input into select all preserves literal blocks | 8a: native input, structure and toolbar state |
| input-057 | [editor-input.test.mjs:2447](editor-input.test.mjs#L2447) | toolbar states match live heading selection | 8a: native input, structure and toolbar state |
| input-058 | [editor-input.test.mjs:2449](editor-input.test.mjs#L2449) | toolbar states match live plain text selection | 8a: native input, structure and toolbar state |
| input-059 | [editor-input.test.mjs:2451](editor-input.test.mjs#L2451) | toolbar states match live bold text selection | 8a: native input, structure and toolbar state |
| input-060 | [editor-input.test.mjs:2453](editor-input.test.mjs#L2453) | toolbar states match live italic selection selection | 8a: native input, structure and toolbar state |
| input-061 | [editor-input.test.mjs:2455](editor-input.test.mjs#L2455) | toolbar states match live mixed selection selection | 8a: native input, structure and toolbar state |
| input-062 | [editor-input.test.mjs:2457](editor-input.test.mjs#L2457) | toolbar states match live inline code selection | 8a: native input, structure and toolbar state |
| input-063 | [editor-input.test.mjs:2458](editor-input.test.mjs#L2458) | toolbar states match live link selection | 8a: native input, structure and toolbar state |
| input-064 | [editor-input.test.mjs:2460](editor-input.test.mjs#L2460) | toolbar states match live first list item selection | 8a: native input, structure and toolbar state |
| input-065 | [editor-input.test.mjs:2462](editor-input.test.mjs#L2462) | toolbar states match live second list item selection | 8a: native input, structure and toolbar state |
| input-066 | [editor-input.test.mjs:2464](editor-input.test.mjs#L2464) | toolbar states match live nested list item selection | 8a: native input, structure and toolbar state |
| input-067 | [editor-input.test.mjs:2466](editor-input.test.mjs#L2466) | toolbar states match live numbered list selection | 8a: native input, structure and toolbar state |
| input-068 | [editor-input.test.mjs:2468](editor-input.test.mjs#L2468) | toolbar states match live checklist selection | 8a: native input, structure and toolbar state |
| input-069 | [editor-input.test.mjs:2469](editor-input.test.mjs#L2469) | toolbar states match live quote selection | 8a: native input, structure and toolbar state |
| input-070 | [editor-input.test.mjs:2471](editor-input.test.mjs#L2471) | toolbar states match live code block selection | 8a: native input, structure and toolbar state |
| input-071 | [editor-input.test.mjs:2473](editor-input.test.mjs#L2473) | toolbar states match live table cell selection | 8a: native input, structure and toolbar state |
| input-072 | [editor-input.test.mjs:2475](editor-input.test.mjs#L2475) | toolbar states match live whole document selection | 8a: native input, structure and toolbar state |
| input-051 | [editor-input.test.mjs:2761](editor-input.test.mjs#L2761) | native multiline input exits empty list and preserves following paragraph | 8a: native input, structure and toolbar state |
| input-056 | [editor-input.test.mjs:3067](editor-input.test.mjs#L3067) | native enter preserves four line feeds between paragraphs | 8a: native input, structure and toolbar state |
| input-073 | [editor-input.test.mjs:3440](editor-input.test.mjs#L3440) | native bold typing keeps bold action pressed | 8a: native input, structure and toolbar state |
| input-074 | [editor-input.test.mjs:3454](editor-input.test.mjs#L3454) | native bold typing renders strong text in canonical source | 8a: native input, structure and toolbar state |
| semantics-001 | [editor-plugins.test.mjs:67](editor-plugins.test.mjs#L67) | source-view word counts must include markdown characters | 9: outline semantics and diagram lifecycle |
| find-001 | [formatted-find.test.mjs:401](formatted-find.test.mjs#L401) | formatted find must match rendered phrases across hidden marks | 4a: rendered find projection |
| find-003 | [formatted-find.test.mjs:664](formatted-find.test.mjs#L664) | formatted phrase counts must include matches across marks | 4a: rendered find projection |
| find-005 | [formatted-find.test.mjs:916](formatted-find.test.mjs#L916) | wide code matches must scroll horizontally with their start visible | 4b: find wiring and navigation |
| release-001 | [formatted-hidden-source.test.mjs:167](formatted-hidden-source.test.mjs#L167) | reopening source must restore its saved scroll position | 2c: hidden source release and mapped bookmarks |
| release-002 | [formatted-hidden-source.test.mjs:188](formatted-hidden-source.test.mjs#L188) | formatted edits must map the saved source scroll position | 2c: hidden source release and mapped bookmarks |
| corpus-008 | [markdown-semantics-native.test.mjs:100](markdown-semantics-native.test.mjs#L100) | a quoted title with a blank line must not define a reference | 5a: shared reference definition parsing |
| corpus-011 | [markdown-semantics-native.test.mjs:98](markdown-semantics-native.test.mjs#L98) | disabled heading syntax must preserve bold formatting inside alerts | 9: outline semantics and diagram lifecycle |
| corpus-012 | [markdown-semantics-native.test.mjs:104](markdown-semantics-native.test.mjs#L104) | disabled heading syntax must preserve bold formatting inside subtext | 9: outline semantics and diagram lifecycle |
| corpus-020 | [markdown-semantics-native.test.mjs:102](markdown-semantics-native.test.mjs#L102) | counts must include a definition whose quoted title holds a blank line | 5a: shared reference definition parsing |
| corpus-021 | [markdown-semantics-native.test.mjs:108](markdown-semantics-native.test.mjs#L108) | disabled heading syntax counts must include a blank-line title definition | 5a: shared reference definition parsing |
| export-001 | [marked-large-paragraph.test.mjs:597](marked-large-paragraph.test.mjs#L597) | export must keep a blank-line title definition and its heading as visible text | 5a: shared reference definition parsing |
| corpus-018 | [markdown-semantics-native.test.mjs:106](markdown-semantics-native.test.mjs#L106) | disabled heading syntax must keep a blank-line title definition literal | 5a: shared reference definition parsing |
| semantics-003 | [outline-navigation.test.mjs:320](outline-navigation.test.mjs#L320) | formatted and source outlines must reuse one document worker | 9: outline semantics and diagram lifecycle |
| contracts-003 | [raw-html-editor.test.mjs:1225](raw-html-editor.test.mjs#L1225) | modified inline html copies must fall back without restoring raw markup | 3c: clipboard fragments and trusted source |
| contracts-004 | [raw-html-editor.test.mjs:1227](raw-html-editor.test.mjs#L1227) | superseded inline html copies must fall back without restoring raw markup | 3c: clipboard fragments and trusted source |
| contracts-005 | [raw-html-editor.test.mjs:1231](raw-html-editor.test.mjs#L1231) | modified block html copies must fall back without restoring raw markup | 3c: clipboard fragments and trusted source |
| contracts-006 | [raw-html-editor.test.mjs:1233](raw-html-editor.test.mjs#L1233) | superseded block html copies must fall back without restoring raw markup | 3c: clipboard fragments and trusted source |
| semantics-002 | [source-reference-navigation.test.mjs:160](source-reference-navigation.test.mjs#L160) | formatted and source references must reuse one document worker | 9: outline semantics and diagram lifecycle |
| addon-001 | [source-reference-navigation.test.mjs:185](source-reference-navigation.test.mjs#L185) | rich-only addon syntax must retain native editing and source reference isolation | 2b: legacy feature notices and literal fallback |

## accepted differences

api-004: typing context uses opaque editor-local positions in API 1, 2, and 3. `editor: 'rich'` does not identify the implementation. Legacy rich view retains ProseMirror positions, including node boundaries; CodeMirror source and formatted views use normalized-source UTF-16 offsets. Replacing `chosen` in `before chosen after 😀` reports 8..14 in ProseMirror and 7..13 in CodeMirror. Both must report the live committed selection and matching nearby text, with `change.from + change.insertedLength === selection.head`. The complete formatted-completions file verifies both implementations and CodeMirror CRLF normalization.

API 1/2 and the public docs promised ProseMirror numbering for `rich`; this difference is accepted because no known addon depends on it. The API 2 declaration at `8bd8d8bda86d54cbd3fc0ad6a004ec83c69d71f8` distinguished CodeMirror and ProseMirror positions. The pinned public guide at docs revision `de79e8e0fb6066a155a96482f690e3a543239b46`, `development/addons/adding-functionality.md:74`, still says ProseMirror positions in rich view. Update that page in hibigarden/docs and bump the pinned revision before changing the default engine. The addon starter uses no positions. The published catalog's five extensions (fatass-horse, fnaf-jumpscare, oneko, typing-speed, and hibi-doom at `446296f572ba80ba6290fba864f104412794bca2`) use no selection/completion position APIs; its six themes use no editor positions. Bundled autocomplete compares changes with captured selections, and writing-suggestions derives ranges from selection.head; neither requires ProseMirror numbering.

corpus-004, corpus-014: a reference in a `-# ` subtext line resolves against a definition later in the note in the formatted view ([markdown-semantics-native.test.mjs:118](markdown-semantics-native.test.mjs#L118), [markdown-semantics-native.test.mjs:119](markdown-semantics-native.test.mjs#L119)). The native schema reads subtext text before later definitions exist, so the rich view, export and word count leave it literal. Each engine asserts its own outcome; word count and export keep the native reading.

marker-005: copying from the formatted view puts the selection's exact Markdown on the clipboard as text, as a Markdown editor does, and its rendered HTML as HTML ([markdown-markers.test.mjs:867](markdown-markers.test.mjs#L867)). The rich editor copies rendered text. A formatted-view copy pastes back as the same Markdown; formatted-clipboard.test.mjs covers that contract.

marker-007: with markers shown, the formatted view reveals a focused heading's `# ` as editable text, so the heading's text content includes it; the heading's name in the accessibility tree is the rendered heading text ([sidebar-views.test.mjs:103](sidebar-views.test.mjs#L103)). The rich editor draws the marker as generated content outside the text. Each engine asserts its own outcome.

find-002: with the find bar open, undoing an edit that replaced the selected match restores that selection in the formatted view, so the restored match is the current one (1/10000), as in source view; the find count reflects the selection it is given ([formatted-find.test.mjs:531](formatted-find.test.mjs#L531)). The rich editor leaves a caret after the restored text, so it shows 0/10000. After closing the bar, typing and undoing, reopening it searches again from the selection, and both engines show the first match as current (1/10000).
