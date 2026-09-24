import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { RichExtension } from '../api'
import { tagMatches } from './syntax'

export function richTags(browse: (tag: string) => void): RichExtension {
  return {
    id: 'highlights',
    attach(editor) {
      const key = new PluginKey('tags')
      let previous: typeof editor.state.doc | null = null
      let decorations = DecorationSet.empty
      const plugin = new Plugin({
        key,
        props: {
          decorations(state) {
            if (state.doc === previous) return decorations
            previous = state.doc
            const marks: Decoration[] = []
            state.doc.descendants((node, position) => {
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
                      position + match.from,
                      position + match.to,
                      {
                        class: 'hibi-tag',
                        'data-tag': match.tag,
                        'data-tooltip': `Shift-click to browse #${match.tag}`,
                      },
                    ),
                  )
            })
            decorations = DecorationSet.create(state.doc, marks)
            return decorations
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
