import { syntaxTree } from '@codemirror/language'
import {
  Decoration as SourceDecoration,
  type DecorationSet as SourceDecorationSet,
  ViewPlugin,
} from '@codemirror/view'
import { readFrontmatter } from '../../shared/frontmatter'
import type { SourceExtension } from '../api'
import { tagMatches } from './syntax'

export function sourceTags(
  browse: (tag: string) => void,
  enabled: () => boolean,
): SourceExtension {
  return {
    id: 'highlights',
    create: () =>
      ViewPlugin.fromClass(
        class {
          decorations: SourceDecorationSet = SourceDecoration.none
          constructor(view: import('@codemirror/view').EditorView) {
            this.highlight(view)
          }
          update(update: import('@codemirror/view').ViewUpdate) {
            if (
              update.docChanged ||
              update.viewportChanged ||
              syntaxTree(update.state) !== syntaxTree(update.startState)
            )
              this.highlight(update.view)
          }
          highlight(view: import('@codemirror/view').EditorView) {
            if (!enabled()) {
              this.decorations = SourceDecoration.none
              return
            }
            const source = view.state.doc.toString()
            const prefix = readFrontmatter(source)?.prefix.length ?? 0
            const ranges = []
            for (const match of tagMatches(source)) {
              if (match.from < prefix) continue
              let allowed = true
              for (
                let node = syntaxTree(view.state).resolveInner(match.from, 1);
                node;
                node = node.parent!
              )
                if (/Code|Link|URL|HTML|Escape/.test(node.name)) {
                  allowed = false
                  break
                }
              if (allowed)
                ranges.push(
                  SourceDecoration.mark({
                    class: 'hibi-tag',
                    attributes: {
                      'data-tag': match.tag,
                      'data-tooltip': `Shift-click to browse #${match.tag}`,
                    },
                  }).range(match.from, match.to),
                )
            }
            this.decorations = SourceDecoration.set(ranges)
          }
        },
        {
          decorations: (value) => value.decorations,
          eventHandlers: {
            click(event) {
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
      ),
  }
}
