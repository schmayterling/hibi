# formatted engine product gaps

these todos execute their assertions. each row identifies a reproduced parity gap, its annotation, and the owning product work. the product fix must remove the todo and this row, then rerun the complete native file. setup failures and flakes do not belong here.

owner numbers follow the ordered formatted engine readiness plan. the default flip requires `HIBI_EXPECT_FORMATTED_GAPS=0 node --test tests/formatted-engine-gaps.test.mjs` to pass. the count is annotation count; a shared annotation can execute in more than one fixture. locations identify the todo option or literal map entry to remove.

| gap id | test file:line | behavior | owning slice |
| --- | --- | --- | --- |
| reload-001 | [addon-reload.test.mjs:783](addon-reload.test.mjs#L783) | addon reload must retain selection and document focus | 3b: addon reload selection and focus |
| reload-004 | [addon-reload.test.mjs:924](addon-reload.test.mjs#L924) | unlocked formatted editor must expose aria-readonly false | 3b: addon reload selection and focus |
| reload-002 | [addon-reload.test.mjs:951](addon-reload.test.mjs#L951) | addon reload must retain selection moved while read-only | 3b: addon reload selection and focus |
| reload-003 | [addon-reload.test.mjs:969](addon-reload.test.mjs#L969) | typing must resume at retained selection after addon reload | 3b: addon reload selection and focus |
| api-001 | [addon-toolbar-command.test.mjs:149](addon-toolbar-command.test.mjs#L149) | api 2 rich selection must report rendered text | 6: verbatim projections and selection contracts |
| completion-001 | [autocomplete-addon.test.mjs:369](autocomplete-addon.test.mjs#L369) | a fresh rich completion list must accept the word with tab | 8a: native input, structure and toolbar state |
| syntax-001 | [code-syntax-settings.test.mjs:23](code-syntax-settings.test.mjs#L23) | syntax settings must refresh formatted code highlighting | 8c: highlighting and grammar lifecycle |
| syntax-004 | [code-syntax-settings.test.mjs:250](code-syntax-settings.test.mjs#L250) | code blocks must retain horizontal scrolling | 8c: highlighting and grammar lifecycle |
| syntax-002 | [code-syntax-settings.test.mjs:293](code-syntax-settings.test.mjs#L293) | formatted code highlighting must appear before source-mode lifecycle checks | 8c: highlighting and grammar lifecycle |
| syntax-003 | [code-syntax-settings.test.mjs:442](code-syntax-settings.test.mjs#L442) | formatted code must retain visible tokens on scrolled and wrapped long lines | 8c: highlighting and grammar lifecycle |
| split-001 | [cursor.test.mjs:266](cursor.test.mjs#L266) | split formatted view must remain read-only | 3: read-only access and shared history guards |
| history-001 | [edit-menu-history.test.mjs:341](edit-menu-history.test.mjs#L341) | keyboard redo must preserve read-only formatted source and history | 3: read-only access and shared history guards |
| api-002 | [editor-extension-context.test.mjs:251](editor-extension-context.test.mjs#L251) | source and formatted editors must preserve hosting view identities | 6: verbatim projections and selection contracts |
| input-015 | [editor-input.test.mjs:2280](editor-input.test.mjs#L2280) | native table cell input emits one signal with inserted text | 8a: native input, structure and toolbar state |
| input-026 | [editor-input.test.mjs:2284](editor-input.test.mjs#L2284) | native table cells selection preserves both source endpoints | 8a: native input, structure and toolbar state |
| input-027 | [editor-input.test.mjs:2286](editor-input.test.mjs#L2286) | native multiline cells preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-028 | [editor-input.test.mjs:2288](editor-input.test.mjs#L2288) | native table cells input preserves rendered cells | 8a: native input, structure and toolbar state |
| input-029 | [editor-input.test.mjs:2290](editor-input.test.mjs#L2290) | native table cells input emits one signal with inserted text | 8a: native input, structure and toolbar state |
| input-030 | [editor-input.test.mjs:2292](editor-input.test.mjs#L2292) | native table cells input advances source version once | 8a: native input, structure and toolbar state |
| input-031 | [editor-input.test.mjs:2294](editor-input.test.mjs#L2294) | native multiline cells keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-043 | [editor-input.test.mjs:2298](editor-input.test.mjs#L2298) | native table into a table selection preserves both source endpoints | 8a: native input, structure and toolbar state |
| input-044 | [editor-input.test.mjs:2300](editor-input.test.mjs#L2300) | native multiline into a table preserves literal text and block structure | 8a: native input, structure and toolbar state |
| input-045 | [editor-input.test.mjs:2302](editor-input.test.mjs#L2302) | native table into a table input preserves rendered cells | 8a: native input, structure and toolbar state |
| input-046 | [editor-input.test.mjs:2304](editor-input.test.mjs#L2304) | native multiline into a table keeps inserted caret and following text | 8a: native input, structure and toolbar state |
| input-057 | [editor-input.test.mjs:2318](editor-input.test.mjs#L2318) | toolbar states match live heading selection | 8a: native input, structure and toolbar state |
| input-058 | [editor-input.test.mjs:2320](editor-input.test.mjs#L2320) | toolbar states match live plain text selection | 8a: native input, structure and toolbar state |
| input-059 | [editor-input.test.mjs:2322](editor-input.test.mjs#L2322) | toolbar states match live bold text selection | 8a: native input, structure and toolbar state |
| input-060 | [editor-input.test.mjs:2324](editor-input.test.mjs#L2324) | toolbar states match live italic selection selection | 8a: native input, structure and toolbar state |
| input-061 | [editor-input.test.mjs:2326](editor-input.test.mjs#L2326) | toolbar states match live mixed selection selection | 8a: native input, structure and toolbar state |
| input-062 | [editor-input.test.mjs:2328](editor-input.test.mjs#L2328) | toolbar states match live inline code selection | 8a: native input, structure and toolbar state |
| input-063 | [editor-input.test.mjs:2329](editor-input.test.mjs#L2329) | toolbar states match live link selection | 8a: native input, structure and toolbar state |
| input-064 | [editor-input.test.mjs:2331](editor-input.test.mjs#L2331) | toolbar states match live first list item selection | 8a: native input, structure and toolbar state |
| input-065 | [editor-input.test.mjs:2333](editor-input.test.mjs#L2333) | toolbar states match live second list item selection | 8a: native input, structure and toolbar state |
| input-066 | [editor-input.test.mjs:2335](editor-input.test.mjs#L2335) | toolbar states match live nested list item selection | 8a: native input, structure and toolbar state |
| input-067 | [editor-input.test.mjs:2337](editor-input.test.mjs#L2337) | toolbar states match live numbered list selection | 8a: native input, structure and toolbar state |
| input-068 | [editor-input.test.mjs:2339](editor-input.test.mjs#L2339) | toolbar states match live checklist selection | 8a: native input, structure and toolbar state |
| input-069 | [editor-input.test.mjs:2340](editor-input.test.mjs#L2340) | toolbar states match live quote selection | 8a: native input, structure and toolbar state |
| input-070 | [editor-input.test.mjs:2342](editor-input.test.mjs#L2342) | toolbar states match live code block selection | 8a: native input, structure and toolbar state |
| input-071 | [editor-input.test.mjs:2344](editor-input.test.mjs#L2344) | toolbar states match live table cell selection | 8a: native input, structure and toolbar state |
| input-072 | [editor-input.test.mjs:2346](editor-input.test.mjs#L2346) | toolbar states match live whole document selection | 8a: native input, structure and toolbar state |
| input-056 | [editor-input.test.mjs:2934](editor-input.test.mjs#L2934) | native enter preserves four line feeds between paragraphs | 8a: native input, structure and toolbar state |
| input-073 | [editor-input.test.mjs:3307](editor-input.test.mjs#L3307) | native bold typing keeps bold action pressed | 8a: native input, structure and toolbar state |
| input-074 | [editor-input.test.mjs:3321](editor-input.test.mjs#L3321) | native bold typing renders strong text in canonical source | 8a: native input, structure and toolbar state |
| semantics-001 | [editor-plugins.test.mjs:67](editor-plugins.test.mjs#L67) | source-view word counts must include markdown characters | 9: outline semantics and diagram lifecycle |
| api-003 | [editor-view-bridge.test.mjs:189](editor-view-bridge.test.mjs#L189) | switching source view must retain the hosting view identity | 6: verbatim projections and selection contracts |
| api-006 | [editor-view-bridge.test.mjs:201](editor-view-bridge.test.mjs#L201) | switching to source must stale the previous formatted selection | 6: verbatim projections and selection contracts |
| split-002 | [editor.test.mjs:187](editor.test.mjs#L187) | split formatted view must remain read-only | 3: read-only access and shared history guards |
| api-004 | [formatted-completions.test.mjs:223](formatted-completions.test.mjs#L223) | typing context must preserve rich selection offsets | 6: verbatim projections and selection contracts |
| find-001 | [formatted-find.test.mjs:210](formatted-find.test.mjs#L210) | formatted find must match rendered phrases across hidden marks | 4a: rendered find projection |
| find-002 | [formatted-find.test.mjs:339](formatted-find.test.mjs#L339) | undo must restore matches without a current find result | 4b: find wiring and navigation |
| find-006 | [formatted-find.test.mjs:384](formatted-find.test.mjs#L384) | increasing total matches must preserve the viewport highlight budget | 4b: find wiring and navigation |
| find-003 | [formatted-find.test.mjs:451](formatted-find.test.mjs#L451) | formatted phrase counts must include matches across marks | 4a: rendered find projection |
| split-003 | [formatted-find.test.mjs:551](formatted-find.test.mjs#L551) | split formatted view must remain read-only | 3: read-only access and shared history guards |
| find-005 | [formatted-find.test.mjs:710](formatted-find.test.mjs#L710) | wide code matches must scroll horizontally with their start visible | 4b: find wiring and navigation |
| release-001 | [formatted-hidden-source.test.mjs:167](formatted-hidden-source.test.mjs#L167) | reopening source must restore its saved scroll position | 2c: hidden source release and mapped bookmarks |
| release-002 | [formatted-hidden-source.test.mjs:188](formatted-hidden-source.test.mjs#L188) | formatted edits must map the saved source scroll position | 2c: hidden source release and mapped bookmarks |
| release-003 | [formatted-hidden-source.test.mjs:327](formatted-hidden-source.test.mjs#L327) | a note that grows huge must release its hidden source view | 2c: hidden source release and mapped bookmarks |
| release-004 | [formatted-hidden-source.test.mjs:336](formatted-hidden-source.test.mjs#L336) | releasing a grown huge source must destroy its editor | 2c: hidden source release and mapped bookmarks |
| split-004 | [github-alerts.test.mjs:203](github-alerts.test.mjs#L203) | split formatted view must remain read-only | 3: read-only access and shared history guards |
| marker-001 | [markdown-markers.test.mjs:515](markdown-markers.test.mjs#L515) | left arrow must reenter nested final formatting before typing | 8b: hidden markers and math caret placement |
| marker-002 | [markdown-markers.test.mjs:574](markdown-markers.test.mjs#L574) | one right arrow must leave final formatting for the next paragraph | 8b: hidden markers and math caret placement |
| marker-003 | [markdown-markers.test.mjs:700](markdown-markers.test.mjs#L700) | the caret beside tall math must remain text sized | 8b: hidden markers and math caret placement |
| marker-004 | [markdown-markers.test.mjs:729](markdown-markers.test.mjs#L729) | focused paragraphs must reveal all their formatting markers | 8b: hidden markers and math caret placement |
| marker-005 | [markdown-markers.test.mjs:757](markdown-markers.test.mjs#L757) | formatted copying must preserve rendered plain text | 8b: hidden markers and math caret placement |
| marker-006 | [markdown-markers.test.mjs:785](markdown-markers.test.mjs#L785) | select all must hide formatting markers | 8b: hidden markers and math caret placement |
| split-013 | [markdown-markers.test.mjs:850](markdown-markers.test.mjs#L850) | read-only split formatting must hide editable markers | 3: read-only access and shared history guards |
| corpus-001 | [markdown-semantics-native.test.mjs:98](markdown-semantics-native.test.mjs#L98) | lazy reference definitions must render only native paragraph text | 9: outline semantics and diagram lifecycle |
| corpus-002 | [markdown-semantics-native.test.mjs:100](markdown-semantics-native.test.mjs#L100) | gfm tables and alerts must report native formatted character counts | 9: outline semantics and diagram lifecycle |
| corpus-003 | [markdown-semantics-native.test.mjs:102](markdown-semantics-native.test.mjs#L102) | reference definitions must hide while resolved labels remain visible | 9: outline semantics and diagram lifecycle |
| corpus-004 | [markdown-semantics-native.test.mjs:104](markdown-semantics-native.test.mjs#L104) | forward definitions must resolve formatted labels without showing definitions | 9: outline semantics and diagram lifecycle |
| corpus-005 | [markdown-semantics-native.test.mjs:106](markdown-semantics-native.test.mjs#L106) | formatted references must render labels before a destination edit | 9: outline semantics and diagram lifecycle |
| corpus-006 | [markdown-semantics-native.test.mjs:108](markdown-semantics-native.test.mjs#L108) | formatted references must retain labels after a destination edit | 9: outline semantics and diagram lifecycle |
| corpus-007 | [markdown-semantics-native.test.mjs:110](markdown-semantics-native.test.mjs#L110) | formatted grapheme character counts must match native counts | 9: outline semantics and diagram lifecycle |
| corpus-008 | [markdown-semantics-native.test.mjs:112](markdown-semantics-native.test.mjs#L112) | multiline reference titles must hide and avoid false headings | 9: outline semantics and diagram lifecycle |
| corpus-009 | [markdown-semantics-native.test.mjs:114](markdown-semantics-native.test.mjs#L114) | quoted reference titles must hide definitions and resolve labels | 9: outline semantics and diagram lifecycle |
| corpus-010 | [markdown-semantics-native.test.mjs:116](markdown-semantics-native.test.mjs#L116) | disabled syntax must preserve native lazy reference rendering | 9: outline semantics and diagram lifecycle |
| corpus-011 | [markdown-semantics-native.test.mjs:118](markdown-semantics-native.test.mjs#L118) | disabled heading syntax must preserve bold formatting inside alerts | 9: outline semantics and diagram lifecycle |
| corpus-012 | [markdown-semantics-native.test.mjs:120](markdown-semantics-native.test.mjs#L120) | disabled heading syntax must preserve bold formatting inside subtext | 9: outline semantics and diagram lifecycle |
| corpus-013 | [markdown-semantics-native.test.mjs:122](markdown-semantics-native.test.mjs#L122) | disabled heading syntax must still hide reference definitions | 9: outline semantics and diagram lifecycle |
| corpus-014 | [markdown-semantics-native.test.mjs:124](markdown-semantics-native.test.mjs#L124) | disabled heading syntax must hide forward reference definitions | 9: outline semantics and diagram lifecycle |
| corpus-015 | [markdown-semantics-native.test.mjs:126](markdown-semantics-native.test.mjs#L126) | disabled heading syntax must hide definitions before reference edits | 9: outline semantics and diagram lifecycle |
| corpus-016 | [markdown-semantics-native.test.mjs:128](markdown-semantics-native.test.mjs#L128) | disabled heading syntax must hide definitions after reference edits | 9: outline semantics and diagram lifecycle |
| corpus-017 | [markdown-semantics-native.test.mjs:130](markdown-semantics-native.test.mjs#L130) | disabled heading syntax must preserve native grapheme character counts | 9: outline semantics and diagram lifecycle |
| corpus-018 | [markdown-semantics-native.test.mjs:132](markdown-semantics-native.test.mjs#L132) | disabled heading syntax must hide multiline reference titles | 9: outline semantics and diagram lifecycle |
| corpus-019 | [markdown-semantics-native.test.mjs:134](markdown-semantics-native.test.mjs#L134) | disabled heading syntax must hide quoted reference titles | 9: outline semantics and diagram lifecycle |
| split-012 | [markdown-syntax.test.mjs:163](markdown-syntax.test.mjs#L163) | split formatted view must remain read-only | 3: read-only access and shared history guards |
| math-001 | [math-rendering.test.mjs:626](math-rendering.test.mjs#L626) | tall formula rendering must preserve the reading position | 8b: hidden markers and math caret placement |
| split-005 | [motion.test.mjs:223](motion.test.mjs#L223) | split formatted view must remain read-only without an input caret | 3: read-only access and shared history guards |
| split-006 | [motion.test.mjs:281](motion.test.mjs#L281) | typing in a read-only split preview must preserve source | 3: read-only access and shared history guards |
| semantics-003 | [outline-navigation.test.mjs:320](outline-navigation.test.mjs#L320) | formatted and source outlines must reuse one document worker | 9: outline semantics and diagram lifecycle |
| link-001 | [outline-navigation.test.mjs:365](outline-navigation.test.mjs#L365) | formatted heading references must render resolved link labels | 5a: reference labels and destinations |
| contracts-001 | [raw-html-editor.test.mjs:1147](raw-html-editor.test.mjs#L1147) | clipboard html must exclude markup outside the selected fragment | 3c: clipboard fragments and trusted source |
| contracts-002 | [raw-html-editor.test.mjs:1156](raw-html-editor.test.mjs#L1156) | a clipboard fragment must restore its exact selected markdown source | 3c: clipboard fragments and trusted source |
| contracts-003 | [raw-html-editor.test.mjs:1241](raw-html-editor.test.mjs#L1241) | modified inline html copies must fall back without restoring raw markup | 3c: clipboard fragments and trusted source |
| contracts-004 | [raw-html-editor.test.mjs:1243](raw-html-editor.test.mjs#L1243) | superseded inline html copies must fall back without restoring raw markup | 3c: clipboard fragments and trusted source |
| contracts-005 | [raw-html-editor.test.mjs:1247](raw-html-editor.test.mjs#L1247) | modified block html copies must fall back without restoring raw markup | 3c: clipboard fragments and trusted source |
| contracts-006 | [raw-html-editor.test.mjs:1249](raw-html-editor.test.mjs#L1249) | superseded block html copies must fall back without restoring raw markup | 3c: clipboard fragments and trusted source |
| api-005 | [rich-edit-api.test.mjs:295](rich-edit-api.test.mjs#L295) | rich source edits must reject structural markup changes | 6: verbatim projections and selection contracts |
| split-007 | [rich-editability.test.mjs:72](rich-editability.test.mjs#L72) | split formatted view must remain read-only | 3: read-only access and shared history guards |
| marker-007 | [sidebar-views.test.mjs:105](sidebar-views.test.mjs#L105) | outline navigation must expose rendered heading text | 8b: hidden markers and math caret placement |
| syntax-005 | [sideload.test.mjs:283](sideload.test.mjs#L283) | disabling an addon must remove its formatted syntax colors | 8c: highlighting and grammar lifecycle |
| link-003 | [site.test.mjs:518](site.test.mjs#L518) | heading links must navigate to canonical and legacy destinations | 5a: reference labels and destinations |
| split-008 | [slash.test.mjs:344](slash.test.mjs#L344) | split formatted view must remain read-only | 3: read-only access and shared history guards |
| split-009 | [source-markdown-lifecycle.test.mjs:337](source-markdown-lifecycle.test.mjs#L337) | split formatted view must remain read-only | 3: read-only access and shared history guards |
| projection-002 | [source-preservation.test.mjs:105](source-preservation.test.mjs#L105) | formatted body edits must preserve custom source prefixes and line endings | 6: verbatim projections and selection contracts |
| semantics-002 | [source-reference-navigation.test.mjs:160](source-reference-navigation.test.mjs#L160) | formatted and source references must reuse one document worker | 9: outline semantics and diagram lifecycle |
| addon-001 | [source-reference-navigation.test.mjs:185](source-reference-navigation.test.mjs#L185) | rich-only addon syntax must retain native editing and source reference isolation | 2b: legacy feature notices and literal fallback |
| split-010 | [split-preview-catchup.test.mjs:470](split-preview-catchup.test.mjs#L470) | split formatted view must remain read-only | 3: read-only access and shared history guards |
| split-016 | [split-preview-catchup.test.mjs:591](split-preview-catchup.test.mjs#L591) | typing in a read-only split preview must preserve source | 3: read-only access and shared history guards |
| split-011 | [split-preview-ime.test.mjs:491](split-preview-ime.test.mjs#L491) | split formatted view must remain read-only during native composition | 3: read-only access and shared history guards |
| split-017 | [split-preview-ime.test.mjs:575](split-preview-ime.test.mjs#L575) | composition in a read-only split preview must preserve source and content version | 3: read-only access and shared history guards |
| split-014 | [typst.test.mjs:432](typst.test.mjs#L432) | split formatted view must remain read-only | 3: read-only access and shared history guards |

## accepted differences

the formatted view does not repeat these rich editor results, so their tests assert the formatted outcome and are not gaps. evidence: electron 45 (chromium 156), `page.keyboard.insertText` into the rich editor's own DOM with its input handler off and its DOM observer paused, and into a plain `contenteditable`.

- input-041, `editor-input.test.mjs` multiline block kinds, structure: replacing `b`…`c` in `ab` / `## cd` with `X\nY`, the rich editor makes `Yd` bold. chromium copies the heading's theme style onto the joined text (`<span style="font-size: 24px; font-weight: 600; letter-spacing: -0.02em; caret-color: transparent;">Yd</span>`) and the rich editor reads the weight as bold; with default styles chromium leaves `Yd` plain. the formatted view keeps it plain: `aX\n\nYd`.
- input-042 (block kinds) and input-048 (task), caret: the rich editor leaves the caret before the last typed line (`|Yd`, `|b`). chromium's own multi-line input leaves the caret early even in a plain paragraph (`start|END` with `a\n\nb` leaves it in the empty middle paragraph), and the rich editor's handler moves it after the input in every case it handles; these two are cases it leaves to the browser. the formatted view puts the caret after the last typed line: `Y|d`, `b|`.
- input-049, multiline nested list end, structure: with `a\n\nb` at the end of `y` in `- x` / `  - y`, the rich editor gives `- x\n- ya\n- b`. chromium outdents the emptied item by moving the nested list out of its item (`<ul><li><p>x</p></li><ul><li><p>ya</p></li></ul><li>b</li></ul>`, which still shows `ya` nested), and the rich editor's parser flattens that invalid nesting, so `ya` loses its level. the formatted view keeps `ya` nested and outdents the new item, as its Enter does: `- x\n  - ya\n- b`.
