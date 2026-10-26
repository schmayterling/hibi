import { EditorView } from '@codemirror/view'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { FormattedContribution } from '../../renderer/src/formatted-contributions'
import {
  type FenceBlock,
  type FencedRenderer,
  fencedView,
  fenceKeys,
  markedFenceText,
  RenderedBlocks,
} from '../_shared/formatted-fence'
import type { AddonContext } from '../api'
import type { editMermaidSource, MermaidBlockContent } from './Block'

/**
 * Mermaid fences in the formatted view: the diagram replaces the fence, drawn
 * by the same renderer and edit dialog as the rich view's diagram blocks.
 */
/**
 * The rich view's block content and dialog come from the addon's own chunk,
 * so this one shares no modules with it and the addon loads without change.
 */
type BlockParts = {
  MermaidBlockContent: typeof MermaidBlockContent
  editMermaidSource: typeof editMermaidSource
}

export function diagramContribution(
  context: AddonContext,
  { MermaidBlockContent, editMermaidSource }: BlockParts,
) {
  const blocks = new RenderedBlocks(32)
  const diagrams: FencedRenderer = {
    id: 'mermaid',
    className: 'mermaid-block',
    matches: (info) => info.toLowerCase() === 'mermaid',
    // The rich view reads diagrams from Marked's code tokens.
    source: markedFenceText,
    indented: ({ marker }) => marker.startsWith('`'),
    mount(dom, block) {
      const root = createRoot(dom)
      // Rendered before the line is measured and painted, outside any React
      // update that created or changed the widget.
      const render = ({ source, edit }: FenceBlock) =>
        queueMicrotask(() =>
          flushSync(() =>
            root.render(<MermaidBlockContent source={source} onEdit={edit} />),
          ),
        )
      render(block)
      return {
        update: render,
        dispose: () => queueMicrotask(() => root.unmount()),
      }
    },
    // Diagrams draw only in view, so a kept one waits without work.
    settled: () => true,
    ask: (source) => editMermaidSource(context, source),
    blocks,
  }
  const contribution: FormattedContribution = {
    id: 'mermaid.blocks',
    feature: 'mermaid.blocks',
    flavor: 'mermaid.blocks',
    views: [fencedView(diagrams)],
    keys: fenceKeys(diagrams),
    extension: EditorView.baseTheme({
      // The block fills the line that held its fence; the fence's margins apply.
      '.mermaid-block': {
        display: 'inline-block',
        width: '100%',
        boxSizing: 'border-box',
        margin: '0',
        verticalAlign: 'top',
        whiteSpace: 'normal',
      },
    }),
  }
  return { contribution, dispose: () => blocks.clear() }
}
