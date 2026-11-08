import type { SourceOperation } from './source-operations.ts'

/**
 * Operations admitted before their edit commits, held so the append after it
 * passes only the id. A session admits again only after it appended, so a
 * tab's next admission replaces one whose edit failed in between. An id
 * another tab's admission holds is refused before anything changes. `own`
 * returns a copy the caller cannot change afterwards.
 */
export function admittedOperations(
  own: (value: unknown) => SourceOperation,
  check: (operation: SourceOperation) => void = () => {},
) {
  const admitted = new Map<string, SourceOperation>()
  return {
    admit: (value: unknown) => {
      const operation = own(value),
        { tabId } = operation.document
      check(operation)
      if (
        (admitted.get(operation.operationId)?.document.tabId ?? tabId) !== tabId
      )
        throw new Error('Conflicting document change sequence.')
      for (const [id, staged] of admitted)
        if (staged.document.tabId === tabId) admitted.delete(id)
      admitted.set(operation.operationId, operation)
    },
    take: (id: string) => {
      const operation = admitted.get(id)
      if (!operation) throw new Error('Unknown admitted document change.')
      admitted.delete(id)
      return operation
    },
  }
}
