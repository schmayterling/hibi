import type { DocumentState } from '../../shared/desktop.ts'

type EditorKind = 'rich' | 'source'
type Identity = Pick<DocumentState, 'tabId' | 'revision' | 'contentVersion'>

let generation = 0

export const invalidateProjectionIdentity = () => {
  generation++
}

export const projectionIdentity = (kind: EditorKind, document: Identity) =>
  `${generation}:${kind}:${document.tabId}:${document.revision}:${document.contentVersion}`

export const matchesProjectionIdentity = (
  kind: EditorKind,
  document: Identity,
  id: string,
) => id === projectionIdentity(kind, document)
