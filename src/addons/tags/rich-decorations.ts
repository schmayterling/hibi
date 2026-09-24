import { Plugin, PluginKey } from '@tiptap/pm/state'
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { RichExtension } from '../api'
import { tagMatches } from './syntax.ts'

export function richTags(browse: (tag: string) => void): RichExtension {
  return {
    id: 'highlights',
    attach(editor) {
      const key = new PluginKey<DecorationSet>('tags')
      function decorate(
        doc: typeof editor.state.doc,
        previous = DecorationSet.empty,
        from = 0,
        to = doc.content.size,
      ) {
        const marks: Decoration[] = []
        doc.nodesBetween(from, to, (block, position) => {
          if (!block.isTextblock) return
          previous = previous.remove(
            previous.find(position + 1, position + block.nodeSize - 1),
          )
          if (block.type.spec.code) return false
          block.descendants((node, offset) => {
            if (
              node.type.spec.code ||
              node.marks.some((mark) =>
                ['code', 'link'].includes(mark.type.name),
              )
            )
              return false
            if (node.isText)
              for (const match of tagMatches(node.text ?? ''))
                marks.push(
                  Decoration.inline(
                    position + 1 + offset + match.from,
                    position + 1 + offset + match.to,
                    {
                      class: 'hibi-tag',
                      'data-tag': match.tag,
                      'data-tooltip': `Shift-click to browse #${match.tag}`,
                    },
                  ),
                )
          })
          return false
        })
        return previous.add(doc, marks)
      }
      const plugin = new Plugin({
        key,
        state: {
          init: (_config, state) => decorate(state.doc),
          apply(transaction, previous) {
            if (!transaction.docChanged) return previous
            let from = transaction.doc.content.size
            let to = 0
            for (const [index, step] of transaction.steps.entries()) {
              const remaining = transaction.mapping.slice(index + 1)
              let mapped = false
              step.getMap().forEach((_oldFrom, _oldTo, start, end) => {
                mapped = true
                from = Math.min(from, remaining.map(start, -1))
                to = Math.max(to, remaining.map(end, 1))
              })
              if (!mapped) {
                if (
                  !(
                    step instanceof AddMarkStep ||
                    step instanceof RemoveMarkStep
                  )
                )
                  return decorate(transaction.doc)
                from = Math.min(from, remaining.map(step.from, -1))
                to = Math.max(to, remaining.map(step.to, 1))
              }
            }
            return decorate(
              transaction.doc,
              previous.map(transaction.mapping, transaction.doc),
              Math.max(0, from - 1),
              Math.min(transaction.doc.content.size, Math.max(from, to) + 1),
            )
          },
        },
        props: {
          decorations(state) {
            return key.getState(state)
          },
          handleDOMEvents: {
            click(_view, event) {
              const tag =
                event.target instanceof Element
                  ? event.target.closest<HTMLElement>('.hibi-tag')?.dataset.tag
                  : undefined
              if (!tag || !event.shiftKey) return false
              event.preventDefault()
              browse(tag)
              return true
            },
          },
        },
      })
      editor.registerPlugin(plugin)
      return () => {
        if (!editor.isDestroyed) editor.unregisterPlugin(key)
      }
    },
  }
}
