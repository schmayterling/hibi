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
import type { editTypstSource, TypstBlockContent } from './BlockContent'

/**
 * Typst fences in the formatted view: the rich view's block heading and
 * preview replace the fence. Compilation stays in the addon's compiler
 * process; a block compiles when it comes into view, and keeps its preview
 * for a while after it scrolls away.
 */
/**
 * The rich view's block content and dialog come from the addon's own chunk,
 * so this one shares no modules with it and the addon loads without change.
 */
type BlockParts = {
  TypstBlockContent: typeof TypstBlockContent
  editTypstSource: typeof editTypstSource
}

export function typstContribution(
  context: AddonContext,
  { TypstBlockContent, editTypstSource }: BlockParts,
) {
  const blocks = new RenderedBlocks(16)
  const typst: FencedRenderer = {
    id: 'typst',
    className: 'typst-block',
    matches: (info) => info.toLowerCase() === 'typst',
    // The rich view reads Typst blocks from Marked's code tokens.
    source: markedFenceText,
    indented: () => true,
    mount(dom, block) {
      const root = createRoot(dom)
      // Rendered before the line is measured and painted, outside any React
      // update that created or changed the widget. New source re-renders the
      // same preview, which restarts its compile debounce.
      const render = ({ source, edit }: FenceBlock) =>
        queueMicrotask(() =>
          flushSync(() =>
            root.render(
              <TypstBlockContent
                source={source}
                context={context}
                onEdit={edit}
              />,
            ),
          ),
        )
      render(block)
      return {
        update: render,
        dispose: () => queueMicrotask(() => root.unmount()),
      }
    },
    // A preview still compiling is removed with its timer, not kept.
    settled: (dom) => !dom.querySelector('.typst-preview[aria-busy="true"]'),
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
