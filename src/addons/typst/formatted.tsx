import { EditorView } from '@codemirror/view'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { FormattedContribution } from '../../renderer/src/formatted-contributions'
import {
  dedentedFenceText,
  type FencedRenderer,
  fencedView,
  fenceKeys,
  RenderedBlocks,
} from '../_shared/formatted-fence'
import type { AddonContext } from '../api'
import { editTypstSource, TypstBlockContent } from './Block'

/**
 * Typst fences in the formatted view: the rich view's block heading and
 * preview replace the fence. Compilation stays in the addon's compiler
 * process; a block compiles when it comes into view, and keeps its preview
 * for a while after it scrolls away.
 */
export function typstContribution(context: AddonContext) {
  const blocks = new RenderedBlocks(16)
  const typst: FencedRenderer = {
    id: 'typst',
    className: 'typst-block',
    matches: (info) => info.toLowerCase() === 'typst',
    // As the Typst tokenizer reads a fence.
    source: dedentedFenceText,
    indented: () => true,
    mount(dom, block) {
      const root = createRoot(dom)
      // Rendered before the line is measured and painted, outside any React
      // update that created the widget.
      queueMicrotask(() =>
        flushSync(() =>
          root.render(
            <TypstBlockContent
              source={block.source}
              context={context}
              onEdit={block.edit}
            />,
          ),
        ),
      )
      return () => queueMicrotask(() => root.unmount())
    },
    ask: (source) => editTypstSource(context, source),
    blocks,
  }
  const contribution: FormattedContribution = {
    id: 'typst.blocks',
    feature: 'typst.blocks',
    flavor: 'typst.blocks',
    views: [fencedView(typst)],
    keys: fenceKeys(typst),
    extension: EditorView.baseTheme({
      // The block fills the line that held its fence; the fence's margins apply.
      '.typst-block': {
        display: 'inline-block',
        width: '100%',
        boxSizing: 'border-box',
        marginBlock: '0',
        verticalAlign: 'top',
        whiteSpace: 'normal',
      },
    }),
  }
  return { contribution, dispose: () => blocks.clear() }
}
