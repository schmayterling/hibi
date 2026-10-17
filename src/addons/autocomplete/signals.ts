import {
  type CompletionItem,
  type CompletionRequest,
  sameCompletionView,
  type TypingContext,
} from '../../shared/completions.ts'
import type { Lang } from '../dictionary/providers.ts'
import type { LearningObservation } from './learning.ts'
import { precedingWords, type TypingSession } from './suggestions.ts'

type Position = {
  view: CompletionRequest['view']
  editor: CompletionRequest['editor']
}
type TypedSpan = Position & {
  from: number
  to: number
  version: number
  scope: TypingSession['scope']
}

type Accepted = {
  view: CompletionRequest['view']
  editor: CompletionRequest['editor']
  from: number
  to: number
  at: number
  observations: LearningObservation[]
}

/** Transient edit receipts; no document text or keystroke log is retained. */
export function createTypingSignals(
  observe: (value: LearningObservation) => void,
  now = Date.now,
) {
  let accepted: Accepted | undefined
  let typed: TypedSpan | undefined
  return {
    reset() {
      accepted = undefined
      typed = undefined
    },
    accept(
      request: CompletionRequest,
      item: CompletionItem,
      session: TypingSession,
      languages: readonly Lang[],
    ) {
      typed = undefined
      if (
        !session.personal ||
        !request.prose ||
        request.view.documentId !== session.documentId
      )
        return
      const before = request.prose.before.slice(
        0,
        request.prose.before.length - (item.to - item.from),
      )
      const words = item.insertText.split(/\s+/)
      const context = precedingWords(before)
      const observations: LearningObservation[] = []
      for (const word of words) {
        if (!/^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u.test(word)) {
          context.length = 0
          continue
        }
        const observation: LearningObservation = {
          scope: session.scope,
          documentId: session.documentId,
          languages,
          context: context.slice(-2),
          word,
          kind: 'accepted',
        }
        observations.push(observation)
        observe(observation)
        context.push(word)
      }
      accepted = {
        view: request.view,
        editor: request.editor,
        from: item.from,
        to: item.from + item.insertText.length,
        at: now(),
        observations,
      }
    },
    input(
      event: TypingContext,
      session: TypingSession,
      languages: readonly Lang[],
    ) {
      if (!session.personal || event.view.documentId !== session.documentId) {
        accepted = undefined
        typed = undefined
        return
      }
      let skipWord = false
      if (accepted) {
        if (!sameCompletionView(accepted, event)) accepted = undefined
      }
      if (accepted && now() - accepted.at > 10000) {
        skipWord =
          event.change.from === accepted.to &&
          event.change.to === event.change.from
        accepted = undefined
      }
      if (accepted) {
        const { from, to, insertedLength } = event.change
        const overlaps = from < accepted.to && to > accepted.from
        const inside =
          from >= accepted.from && from < accepted.to && insertedLength > 0
        const extendsWord =
          from === accepted.to &&
          insertedLength > 0 &&
          /[\p{L}\p{M}]$/u.test(event.before)
        skipWord = from === accepted.to && to === from
        if (overlaps || inside || extendsWord) {
          for (const observation of accepted.observations)
            observe({
              ...observation,
              kind: event.kind === 'undo' ? 'undo' : 'overwrite',
            })
          accepted = undefined
        } else if (to <= accepted.from) {
          const delta = insertedLength - (to - from)
          accepted.from += delta
          accepted.to += delta
        }
      }
      const { from, to, insertedLength } = event.change
      if (
        typed &&
        (!sameCompletionView(typed, event) ||
          typed.scope !== session.scope ||
          event.contentVersion !== typed.version + 1)
      )
        typed = undefined
      if (
        event.kind === 'delete' &&
        typed &&
        from >= typed.from &&
        to <= typed.to &&
        insertedLength === 0
      ) {
        typed.to -= to - from
        typed.version = event.contentVersion
        return
      }
      if (event.kind !== 'input' && event.kind !== 'composition') {
        typed = undefined
        return
      }
      if (insertedLength <= 0) {
        typed = undefined
        return
      }
      if (typed && from === typed.to && to === from) {
        typed.to += insertedLength
        typed.version = event.contentVersion
      } else {
        typed = {
          view: event.view,
          editor: event.editor,
          scope: session.scope,
          from,
          to: from + insertedLength,
          version: event.contentVersion,
        }
      }
      if (skipWord) {
        typed = undefined
        return
      }
      const committed =
        /(?:^|\s)([\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*)(\r?\n|[\s.,!?;:])$/u.exec(
          event.before,
        )
      if (!committed) return
      const word = committed[1]
      const separator = committed[2]
      if (!word || !separator) return
      // Enter can insert paragraph tokens, so its word ends at the old edit position.
      const wordEnd =
        /[\r\n]/.test(separator) && event.kind === 'input'
          ? from
          : event.selection.head - separator.length
      const covered = typed.from <= wordEnd - word.length && typed.to >= wordEnd
      typed = undefined
      if (!covered) return
      observe({
        scope: session.scope,
        documentId: session.documentId,
        languages,
        word,
        kind: 'typed',
        context: precedingWords(
          event.before.slice(
            0,
            event.before.length - word.length - separator.length,
          ),
        ),
      })
    },
  }
}
