export type NoteSyntax = {
  readonly gfm: boolean
  readonly wikilinks: boolean
  readonly hashtags: boolean
  readonly frontmatter: boolean
  readonly disabledFeatures: readonly string[]
}

export const defaultNoteSyntax: NoteSyntax = {
  gfm: true,
  wikilinks: true,
  hashtags: true,
  frontmatter: true,
  disabledFeatures: [],
}

export function builtInNoteSyntax(
  selected: ReadonlySet<string>,
  disabledFeatures: readonly string[],
  hashtags: boolean,
  frontmatter: boolean,
): NoteSyntax {
  return {
    gfm: selected.has('markdown.github'),
    wikilinks: selected.has('markdown.obsidian'),
    hashtags,
    frontmatter,
    disabledFeatures,
  }
}
