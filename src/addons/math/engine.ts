import { syntaxTree } from '@codemirror/language'
import { EditorView, ViewPlugin } from '@codemirror/view'
import katex from 'katex'
import { Sigma, SquareRadical } from 'lucide-react'
import type { MarkedExtension } from 'marked'
import { formattedSyntaxTree } from '../../renderer/src/formatted-contributions'
import { formattedRegistry } from '../../renderer/src/formatted-registry'
import { isMarkdownDocument } from '../../shared/document-types'
import type { AddonContext } from '../api'
import type { MathHost } from './formatted'
import { containerPrefix, mathInsertion } from './insert'
import { formulaScheduler } from './rendering'
import { mathStyles } from './styles'
import { mathFlavor, mathTokens } from './syntax'

const options = {
  throwOnError: false,
  trust: false,
  maxExpand: 500,
  maxSize: 20,
}
export function startMath(context: AddonContext) {
  const supported = (name: string) =>
    /\.(?:md|markdown|tex|rmd|qmd|org)$/i.test(name)
  context.editor.registerSyntax({
    id: 'inline',
    label: 'Inline math',
    group: 'LaTeX',
    description: '$expression$',
    level: 'inline',
    matches: (token) => token.type === 'inlineMath',
    slash: {
      markdown: '$$',
      cursor: 1,
    },
  })
  context.editor.registerSyntax({
    id: 'block',
    label: 'Block math',
    group: 'LaTeX',
    description: '$$ expression $$',
    level: 'block',
    matches: (token) => token.type === 'blockMath',
    slash: {
      markdown: '$$\n\n$$',
      cursor: 3,
    },
  })
  let source: EditorView | null = null
  let formatted: EditorView | null = null
  // Unset until a source or formatted editor takes focus.
  let target: 'source' | 'formatted' | null = null
  context.editor.registerSource({
    id: 'editing',
    create: () => [
      ViewPlugin.define((view) => {
        source = view
        return {
          destroy() {
            if (source === view) source = null
          },
        }
      }),
      EditorView.domEventHandlers({
        focus() {
          target = 'source'
        },
      }),
    ],
  })
  const prompt = (value = '') =>
    context.dialogs.prompt({
      title: 'Math',
      label: 'LaTeX',
      defaultValue: value,
      confirmLabel: 'Apply',
      validate: (value) =>
        !value.trim()
          ? 'Enter an expression.'
          : value.length > 10000
            ? 'Use 10,000 characters or fewer.'
            : null,
    })
  async function insert(block: boolean) {
    const document = context.editor.getDocument()
    if (!document || !supported(document.name)) {
      context.notify('Math insertion is not available for this format.')
      return
    }
    // The CodeMirror formatted view takes the same source edit as the source view.
    const codeMirror = () =>
      target === 'formatted' && formatted ? formatted : source
    const view = codeMirror(),
      text = view?.state.doc
    const selection =
      target || !isMarkdownDocument(document.name)
        ? view?.state.selection.main
        : undefined
    if (!selection) {
      context.notify('Enable math from the format menu in the status bar.')
      return
    }
    const latex = await prompt()
    if (latex === null) return
    if (view && view.state.doc === text && view === codeMirror()) {
      // Display math keeps the quotes and list items around the caret.
      const { state } = view
      const value = mathInsertion(
        block
          ? containerPrefix(
              state.doc,
              formattedSyntaxTree(state) ?? syntaxTree(state),
              selection.from,
            )
          : '',
        latex,
        block,
      )
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: value },
        selection: { anchor: selection.from + value.length },
        userEvent: 'input.format',
        scrollIntoView: true,
      })
      view.focus()
    }
  }
  const formulas = formulaScheduler((latex, displayMode) =>
    katex.renderToString(latex, {
      ...options,
      displayMode,
      output: 'htmlAndMathml',
    }),
  )
  const renderers: MarkedExtension = {
    extensions: ['inlineMath', 'blockMath'].map((name) => ({
      name,
      renderer: (token) =>
        formulas.render(
          String(token.latex ?? ''),
          name === 'blockMath' || token.display === true,
        ),
    })),
  }
  context.styles.register('math', mathStyles)
  const host: MathHost = {
    formulas,
    prompt,
    focus(view) {
      formatted = view
      target = 'formatted'
    },
    close(view) {
      if (formatted === view) formatted = null
    },
  }
  const formattedEntries = (['inline', 'block', 'editing'] as const).map((id) =>
    formattedRegistry.register({
      id: `math.${id}`,
      load: () =>
        import('./formatted').then(
          ({ mathContributions }) => mathContributions(host)[id],
        ),
    }),
  )
  context.editor.registerFlavor({
    ...mathFlavor,
    export: {
      extensions: [mathTokens, renderers],
      css: mathStyles,
    },
  })
  for (const block of [false, true]) {
    const id = block ? 'block' : 'inline',
      label = block ? 'Block math' : 'Inline math'
    context.commands.register({
      id,
      label: `Insert ${label.toLowerCase()}`,
      run: () => insert(block),
    })
    const item = context.toolbar.register({
      id,
      label,
      icon: block ? Sigma : SquareRadical,
      commandId: id,
      hidden: true,
    })
    context.editor.onDocumentChange((document) =>
      item.update({ hidden: !supported(document.name) }),
    )
  }
  return () => {
    for (const remove of formattedEntries) remove()
  }
}
