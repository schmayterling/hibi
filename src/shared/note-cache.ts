/** Raw source coordinates: zero-based lines/UTF-16 columns and exclusive ends. */
export type Loc = { line: number; col: number; offset: number }
export type Pos = { start: Loc; end: Loc }
export type NoteLoc = Loc
export type NotePosition = Pos
export type NoteCacheHeading = { depth: number; text: string; position: Pos }
export type NoteCacheLink = {
  link: string
  original: string
  displayText?: string
  position: Pos
}
export type NoteCacheTag = { tag: string; position: Pos }
export type NoteCacheListItem = {
  position: Pos
  /** Parent item's zero-based source line; roots negate their list's first item line. */
  parent: number
  task?: string
  id?: string
}
export type NoteCacheSection = {
  /** Built-in block kind; additional grammar nodes may supply other kinds. */
  type: string
  position: Pos
  id?: string
}
export type NoteCacheBlock = { id: string; position: Pos }
export type NoteCacheFrontmatter = {
  values: Record<string, unknown>
  position: Pos
}
export type NoteCacheFrontmatterLink = NoteCacheLink & {
  key: string
  /** Cooked YAML can hide delimiters in the raw source spelling. */
  syntax?: 'wiki' | 'markdown'
}

export type NoteCacheValues = {
  heading: NoteCacheHeading
  link: NoteCacheLink
  embed: NoteCacheLink
  tag: NoteCacheTag
  listItem: NoteCacheListItem
  section: NoteCacheSection
  block: NoteCacheBlock
  frontmatter: NoteCacheFrontmatter
  frontmatterLink: NoteCacheFrontmatterLink
}
export type NoteCacheEntry = {
  [Kind in keyof NoteCacheValues]: { kind: Kind; value: NoteCacheValues[Kind] }
}[keyof NoteCacheValues]
