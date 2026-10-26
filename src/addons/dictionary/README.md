# Dictionary and thesaurus

Look up a word's definitions and synonyms without leaving your document. Lookups support English, Chinese (Mandarin, in simplified or traditional characters), Cantonese, Japanese, Filipino, French, and German. Enable **Dictionary and thesaurus** under **Settings → Addons**. It is off by default because lookups use online services.

Place the cursor in a word or select a word or phrase, then choose **Define word** or **Find synonyms** from the command palette or the editor's right-click menu. **Find synonyms** also has the default shortcut `Shift+F7`, which you can change under **Settings → Hotkeys**. Both commands work in the formatted editor and in Source view.

**Define word** shows each part of speech with numbered definitions and an example when one is available. **Find synonyms** shows synonyms and antonyms. Choose one of these words to replace the word you looked up. A capitalized word stays capitalized, and one undo restores the original. Press Escape to close the results and return to your document. Each result names its source and license.

## Side view

Run **Open dictionary side view** from the command palette, or choose **Dictionary** in the sidebar picker, to keep a word's details beside your document. The view opens on the right side of the window.

While **Follow the cursor** is on, the view shows the word at the cursor shortly after the cursor stops moving. It has three sections:

- **Definition** lists each part of speech with numbered definitions, examples, and readings for Chinese and Japanese words.
- **Thesaurus** lists synonyms and antonyms. Choose one to replace the word in your document. A capitalized word stays capitalized, and one undo restores the original.
- **By meaning** groups synonyms under each definition when a word has more than one meaning with synonyms.

Each section names its source and license. Use the arrow keys to move between words in a list, and press Enter to choose one. Long lists show **Show all** to reveal the rest.

Following the cursor uses installed offline packs, your custom words, and answers already fetched during this session only. It never sends a word online. When nothing local answers, choose **Look up online** to ask the online services, install the offline pack it offers for each language without one, or choose **Add to dictionary** to keep the word as your own. After the pack dialog closes, the view looks the word up again.

Type any word in **Look up a word** and press Enter to look it up, online if needed. A searched word stays in the view until you press Escape in the search field or turn **Follow the cursor** back on. Choosing a word in search results looks that word up instead of changing your document.

## Suggestions as you type

Enable the separate [Autocomplete addon](../autocomplete/README.md) for word and phrase suggestions while typing. It uses this addon's installed offline packs and custom words, then learns local word patterns from normal editing. Its settings include suggestion languages, Tab acceptance, learning, exclusions, and clearing learned words. Existing dictionary suggestion and Tab preferences are preserved.

The dictionary keeps lookups and the side view. Autocomplete never requests an online lookup or downloads a pack.

## Custom words

Add your own words, such as names, slang, or terms from your field, so lookups and suggestions know them. Choose **Add to dictionary** when the side view or **Define word** finds no entry, or run **Add word to dictionary** from the command palette or the editor's right-click menu to add the word at the cursor.

**Settings → Dictionary and thesaurus → Custom words** lists your words. Give a word a language and a note, such as its meaning, or remove it. A word without a language belongs to the first language Hibi tries for it. **Export as text** copies your words with one word per line, followed by a tab, the language code, and the note when they have them. A word starting with `#` is written with a backslash before it, since lines starting with `#` are skipped as comments on import. Paste that text and choose **Import text** to add the words on another computer; imported words update matching ones. Both export options wait for changed notes to finish saving. **Export to file…** saves the same text as a new `.txt` file and never replaces an existing file, and **Import from file…** adds the words from a UTF-8 text file in this format. There is no fixed word count, word length, or note length limit. Available disk space and limits on individual transfers still apply.

Hibi copies and verifies an existing custom-word list before using the new store. The old list is kept for older builds. Those builds show the original list; later words and edits stay in the new store. When you upgrade again, Hibi compares older-version changes with the original snapshot. Newer edits win when both versions change the same field, and words removed in the newer build stay removed. Words missing from the older snapshot stay in the newer list. Recovery and merge notices can be dismissed.

Custom words are shown as **Your word** in lookups, with your note as the definition. An entry from an installed pack for the same word and language comes first. Custom words are kept with your Hibi settings on this computer, not in a workspace, and are never sent online.

## Vocabulary export for addons

The `vocabulary` export now uses version 2. A consumer that accepts only `api.version === 1` skips the integration until it accepts version 2. Calling `api.customWords().filter(...)` without awaiting version 2 throws because `customWords()` returns a promise. Read the full list only when needed:

```ts
if (api.version === 1 || api.version === 2) {
  const words = await api.customWords()
  const matches = words.filter((word) => word.lang === 'en')
}
```

Use `api.customCompletions(...)` for indexed prefix suggestions instead of loading the full vocabulary on activation. Completion work stops after 4,096 indexed steps per request so lookups cannot wait behind a large suggestion scan. If that budget is reached, the result contains the best matches found so far and can omit a shorter or earlier match. Narrowing the prefix can reveal other matches; saved words and exact lookups are unaffected.

## Languages

Hibi chooses the language from the word's script. Words with kana are looked up in Japanese. Words written only in Chinese characters use the language chosen under **Settings → Dictionary and thesaurus → Words in Chinese characters**, then the other Chinese-character languages. Words in Latin letters use the language chosen under **Words in Latin letters**, then English, Filipino, French, and German. When the Wiktionary page for a word has entries in several of these languages, **Define word** shows all of them, the first language that has an entry on top, without sending another request. Korean and other scripts are not supported yet.

Chinese and Japanese text has no spaces between words, so Hibi finds the word at the cursor using the system's word boundaries. If it picks too few or too many characters, select the exact word first. Cantonese definitions come from Wiktionary's Chinese entries, which also cover Mandarin.

Online synonyms are available for English. Offline English, Filipino, French, and German packs supply synonyms and antonyms when their sources have them; Chinese and Japanese thesaurus coverage is limited. The results offer **Install offline pack** when a pack may help.

## Privacy

Hibi sends nothing while you type. When you run a lookup that no installed offline pack can answer, the word you looked up is sent to one of these services:

- **Define word** sends the word to [Wiktionary](https://en.wiktionary.org/) through the Wikimedia REST API at `en.wiktionary.org`.
- **Find synonyms** sends English words to the [Datamuse API](https://www.datamuse.com/api/) at `api.datamuse.com`, once for synonyms and once for antonyms.

Only the word is sent, never the rest of your document. The addon manager lists every declared host before enabling. Enabling the addon allows credential-free requests to those public hosts without another prompt. Requests to other hosts, requests with credentials, and hosts resolving to private addresses still require approval. Answers are kept in memory until the addon is disabled or Hibi closes, so looking up the same word again does not send another request. Datamuse says it keeps a log of queries until the end of the day and then discards it.

The side view, suggestions, and custom words never send a word on their own. Only **Look up online** and the side view's search field ask the online services, and they use the same permission prompts.

## Services and limits

Wiktionary text is available under the [Creative Commons Attribution-ShareAlike 4.0 license](https://creativecommons.org/licenses/by-sa/4.0/). Wikimedia limits clients that identify themselves to 200 requests a minute; Hibi identifies itself in each request as Wikimedia's [API policy](https://www.mediawiki.org/wiki/Wikimedia_APIs/Access_policy) requires.

Datamuse allows up to 100,000 requests a day without a key. Its [API page](https://www.datamuse.com/api/) says it will require an API key for every request starting in early 2027. Synonym lookups may stop working at that point until Hibi supports a key. Thanks to Datamuse for providing the API.

If a service cannot be reached, is limiting requests, or has no entry for the word, the results explain what happened. Choose **Try again** after reconnecting or waiting a minute.

## Offline packs

Open the addon's settings, or run **Dictionary: install offline pack**, and choose **Install pack** beside a language. English, Mandarin in both scripts, Cantonese, Japanese, Filipino (Tagalog), French, and German are available. Each row shows its download size, hosts, sources, and licenses before installation. Hibi downloads directly from those publishers; packs are not bundled or hosted by Hibi.

Measured full packs on 12 October 2026; MB below means 1,000,000 bytes. Download sizes for rolling sources can change. Installed size excludes the small manifest.

| Pack | Source and license | Download hosts | Download MB | Installed MB |
| --- | --- | --- | ---: | ---: |
| English | Open English WordNet, CC BY 4.0 plus Princeton notice | `en-word.net` | 11.36 | 52.07 |
| Mandarin | CC-CEDICT, CC BY-SA 4.0 | `www.mdbg.net` | 3.98 | 35.54 |
| Cantonese | CC-Canto/readings, CC BY-SA 3.0; CC-CEDICT, CC BY-SA 4.0 | `cantonese.org`, `www.mdbg.net` | 7.14 | 38.02 |
| Japanese | JMdict_e, CC BY-SA 4.0 | `www.edrdg.org` | 10.58 | 89.52 |
| Filipino | Wiktionary via Kaikki, CC BY-SA 4.0 / GFDL | `kaikki.org` | 16.28 | 11.86 |
| French | Wiktionary via Kaikki, CC BY-SA 4.0 / GFDL | `kaikki.org` | 58.23 | 103.53 |
| German | Wiktionary via Kaikki, CC BY-SA 4.0 / GFDL | `kaikki.org` | 98.33 | 141.48 |

Keep the app open while a pack downloads and prepares. You can cancel either stage. **Update** fetches the current source again and keeps the installed pack until the replacement is ready. **Uninstall** removes that pack's local data. Update regularly to receive corrections, particularly for the daily CC-CEDICT and JMdict sources.

Packs load when a lookup or suggestion first needs them. The first lookup can take longer while a pack is checked and loaded; typing stays available. Later launches reuse checksum verification while the installed files are unchanged.

Installed packs are preferred across the candidate languages. A local answer requires no lookup request. If no installed pack has an answer, the online providers may use the declared public hosts without another permission prompt. Pack installation contacts the displayed publishers but never sends the word you are looking up.

English uses WordNet definitions, synonym groups, antonyms, and explicit inflected forms, with conservative suffix matching when the exact form is absent. Chinese pairs connect simplified and traditional headwords; Japanese entries connect kanji spellings and kana readings. Filipino, French, and German also match lowercase headwords. Readings appear with the definitions.

CC-CEDICT, CC-Canto, and JMdict do not supply a general thesaurus. Their packs therefore provide definitions and readings; synonym results depend on available source relations or the online fallback. Filipino, French, and German retain Wiktionary synonym and antonym fields. No extra thesaurus dataset is bundled.

See [offline pack help](https://docs.hibi.garden/#page=features%2Fdictionary-packs.md) and the [pack implementation and measurements](https://docs.hibi.garden/#page=development%2Faddons%2Fdictionary-packs.md).

### Offline dictionary sources

The English pack uses [Open English WordNet 2025](https://en-word.net/downloads), released on 31 December 2025. It is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), with [Princeton WordNet notices](https://github.com/globalwordnet/english-wordnet/blob/2025-edition/LICENSE.md) retained. Attribution is given to the Open English WordNet team and Princeton University WordNet. The 2025 edition covers lexical words; the separate 2025+ edition also includes curated proper names.

The Mandarin pack uses [CC-CEDICT, published by MDBG](https://www.mdbg.net/chinese/dictionary?page=cedict), under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The current download header confirms this licence; the older CC-CEDICT wiki still mentions version 3.0. CC-CEDICT is maintained by its community and includes material from CEDICT, copyright 1997 and 1998 Paul Andrew Denisowski.

The Cantonese pack combines [CC-Canto and CC-CEDICT Cantonese Readings](https://cantonese.org/download.html) with CC-CEDICT definitions. CC-Canto is version 2017-02-02, copyright 2015–17 Pleco Inc.; the Cantonese readings are version 2015-09-23, copyright 2015 Pleco Software Incorporated. Both Pleco datasets use [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). The current CC-CEDICT definitions retain their separate CC BY-SA 4.0 attribution.

The Japanese pack uses the English-gloss [JMdict_e](https://www.edrdg.org/jmdict/j_jmdict.html), copyright James William Breen and the Electronic Dictionary Research and Development Group. It uses [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The [upstream licence statement](https://www.edrdg.org/edrdg/licence.html) requires accessible acknowledgement and a procedure for regular dictionary updates.

The Tagalog pack uses [English Wiktionary data extracted by Wiktextract and distributed through Kaikki.org](https://kaikki.org/dictionary/Tagalog/). Dictionary text is by Wiktionary contributors. [Wiktionary's copyright statement](https://en.wiktionary.org/wiki/Wiktionary:Copyrights) offers CC BY-SA 4.0 and GFDL 1.1 or later; this pack uses the [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) option. The current language-specific postprocessed download is marked deprecated by Kaikki. Its maintained [raw-data alternative](https://kaikki.org/dictionary/rawdata.html) contains all languages and would need Tagalog filtering during pack preparation. The Wiktextract program's MIT licence does not replace the dictionary data licence.

Hibi converts these upstream files into local lookup indexes. The conversion extracts definitions, spellings, readings, forms, synonyms and antonyms where the source provides them, and combines separately attributed sources for Cantonese. Installed pack metadata records the download source, date and hash. Source licence notices remain available through the addon's registered licences.

#### Verified download snapshots

These are observed sizes, not permanent sizes for rolling downloads. Verified on 12 October 2026 in Asia/Manila. French and Tagalog gzip endpoints returned HTTP 200 to HEAD requests and full downloads; their Last-Modified dates were 3 October 2026.

| Source | Official HTTPS download | Download bytes | Expanded bytes | Version or date | Format |
| --- | --- | ---: | ---: | --- | --- |
| Open English WordNet | [english-wordnet-2025.xml.gz](https://en-word.net/downloads/english-wordnet-2025.xml.gz) | 11,363,503 | 89,237,271 | 2025; released 2025-12-31 | gzip, UTF-8 WN-LMF 1.3 XML |
| CC-CEDICT | [cedict_1_0_ts_utf-8_mdbg.txt.gz](https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz) | 3,980,329 | 9,863,447 | v1.0; 2026-10-11T08:29:27Z | gzip, UTF-8 CEDICT text; 125,262 entries |
| CC-Canto | [cccanto-170202.zip](https://cantonese.org/cccanto-170202.zip) | 1,282,537 | 3,446,667 | 2017-02-02 | ZIP; cccanto-webdist.txt |
| Cantonese readings | [cccedict-canto-readings-150923.zip](https://cantonese.org/cccedict-canto-readings-150923.zip) | 1,874,027 | 5,328,574 | 2015-09-23 | ZIP; cccedict-canto-readings-150923.txt |
| JMdict_e | [JMdict_e.gz](https://www.edrdg.org/pub/Nihongo/JMdict_e.gz) | 10,583,340 | 63,164,141 | created 2026-10-11 | gzip, UTF-8 XML with internal DTD/entities |
| Tagalog Wiktionary | [kaikki.org-dictionary-Tagalog.jsonl.gz](https://kaikki.org/dictionary/Tagalog/kaikki.org-dictionary-Tagalog.jsonl.gz) | 16,281,409 | 130,506,107 | extracted 2026-10-03 from dump 2026-09-02 | gzip, UTF-8 JSON Lines |

WordNet XML supplies 4,473 explicit inflected forms. Its optional [WNDB archive](https://en-word.net/downloads/english-wordnet-2025.zip) is 9,616,299 bytes and supplies noun, verb, adjective and adverb exception lists. [Princeton's Morphy documentation](https://wordnet.princeton.edu/documentation/morphy7wn) describes POS-specific suffix rules with dictionary membership checks. Forms and exception lists support irregular lookup; suffix rules can extend regular inflection coverage.

The CEDICT export has traditional and simplified spellings, numbered Pinyin and slash-separated definitions. Cantonese files add Jyutping inside braces; the readings file has no definitions and must be joined to CC-CEDICT. JMdict has kanji spellings, kana readings and restricted senses; its internal DTD defines named POS entities. Kaikki JSON Lines has one entry object per line, including `word`, `lang_code`, `pos`, `senses`, `forms` and optional lexical relation objects. [Wiktextract's upstream documentation](https://github.com/tatuylonen/wiktextract) describes its fields.

#### German

The German pack uses [Kaikki's German extract of English Wiktionary](https://kaikki.org/dictionary/German/), with English definitions and the source's synonym and antonym fields. Hibi uses the [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) option from [Wiktionary's copyright terms](https://en.wiktionary.org/wiki/Wiktionary:Copyrights). Original entry links, contributor attribution, license notices, and conversion notices remain available.

The [official German gzip](https://kaikki.org/dictionary/German/kaikki.org-dictionary-German.jsonl.gz) downloaded and fully decompressed on 12 October 2026: 98,333,861 compressed bytes and 1,085,014,820 expanded bytes. It was extracted on 3 October from the 2 September English Wiktionary dump. The language-specific endpoint is deprecated upstream, like French and Tagalog. German has a 128 MiB download limit and a 1.5 GiB source expansion limit; converted-data and index limits remain unchanged.

German keeps noun capitalization and matches lowercase aliases after exact spelling. Umlauts use Unicode NFC normalization; accents are not removed, and `ß` is not rewritten as `ss`. German synonyms come from Wiktionary for now. After measuring synonym coverage, a dedicated thesaurus could be added; [OpenThesaurus](https://www.openthesaurus.de/about/download) is the preferred follow-up because it uses a single download origin and offers an LGPL 2.1 option alongside CC BY-SA 4.0. Hibi downloads dictionary data from publishers and converts it locally; it does not redistribute the datasets.

#### French

The French pack uses the [French extract of English Wiktionary from Kaikki](https://kaikki.org/dictionary/French/), under the same [Wiktionary CC BY-SA 4.0 / GFDL terms](https://en.wiktionary.org/wiki/Wiktionary:Copyrights) as Tagalog. Hibi uses the CC BY-SA 4.0 option. [The official compressed JSON Lines download](https://kaikki.org/dictionary/French/kaikki.org-dictionary-French.jsonl.gz) was 58,232,930 bytes (583,677,104 bytes expanded) when verified by HEAD and a complete download on 12 October 2026. It was extracted on 3 October 2026 from the 2 September English Wiktionary dump.

Like Tagalog's language-specific feed, this endpoint is deprecated upstream but remains available. Hibi streams it and keeps only French entries. The maintained all-language raw alternative is much larger and is not downloaded by this pack. All Wiktionary packs preserve links to original entries for attribution.
