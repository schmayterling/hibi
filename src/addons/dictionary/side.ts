import {
  type DictionaryRegistry,
  type Entry,
  type Gathered,
  gather,
  type Lang,
  type Related,
} from './providers.ts'

export type SideResult = {
  definitions: Gathered<Entry[]>
  thesaurus: Gathered<Related>
}

/**
 * Definitions and related words for the side view. Without `online`, only
 * installed packs and answers already fetched this session are used, so
 * nothing is sent.
 */
export async function lookUpSide(
  registry: DictionaryRegistry,
  word: string,
  langs: readonly Lang[],
  online: boolean,
  signal: AbortSignal,
): Promise<SideResult> {
  const cached = (provider: { kind: string }, cachedOnly: boolean) =>
    cachedOnly || (!online && provider.kind === 'online')
  // One kind at a time keeps network permission prompts sequential.
  const definitions = await gather(
    registry,
    langs,
    'lookup',
    (provider, lang, cachedOnly) =>
      provider.lookup(word, lang, signal, cached(provider, cachedOnly)),
  )
  const thesaurus = await gather(
    registry,
    langs,
    'related',
    async (provider, lang, cachedOnly) =>
      (await provider.related?.(
        word,
        lang,
        signal,
        cached(provider, cachedOnly),
      )) ?? null,
  )
  // Online answers do not replace a pack: offer every missing one. A pack
  // that cannot say whether it is installed is not offered.
  const installable: Lang[] = []
  for (const lang of langs)
    if (await registry.installable(lang).catch(() => false))
      installable.push(lang)
  return {
    definitions: { ...definitions, installable },
    thesaurus: { ...thesaurus, installable },
  }
}

/** Synonyms grouped by the meaning they share, labeled with its first gloss. */
export function meaningGroups(entries: readonly Entry[], word: string) {
  const groups: { label: string; words: string[] }[] = []
  const self = word.toLowerCase()
  for (const entry of entries) {
    const words = [...new Set(entry.synonyms ?? [])].filter(
      (item) => item.toLowerCase() !== self,
    )
    const [sense] = entry.senses
    if (!words.length || !sense) continue
    groups.push({
      label: [entry.partOfSpeech, sense.gloss].filter(Boolean).join(' · '),
      words,
    })
  }
  return groups
}
