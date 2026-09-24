import { EditorView, ViewPlugin } from '@codemirror/view'
import { type Editor, InputRule } from '@tiptap/core'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import type { Node } from '@tiptap/pm/model'
import katex from 'katex'
import { Sigma, SquareRadical } from 'lucide-react'
import type { MarkedExtension } from 'marked'
import { isMarkdownDocument } from '../../shared/document-types'
import type { AddonContext } from '../api'
import { mathStyles } from './styles'
import { blockMath, inlineMath, mathFlavor, mathTokens } from './syntax'

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
    extensions: ['inlineMath'],
    matches: (token) => token.type === 'inlineMath',
    slash: {
      markdown: '$$',
      cursor: 1,
      rich: (chain) => chain.insertInlineMath({ latex: '' }),
    },
  })
  context.editor.registerSyntax({
    id: 'block',
    label: 'Block math',
    group: 'LaTeX',
    description: '$$ expression $$',
    level: 'block',
    extensions: ['blockMath'],
    matches: (token) => token.type === 'blockMath',
    slash: {
      markdown: '$$\n\n$$',
      cursor: 3,
      rich: (chain) => chain.insertBlockMath({ latex: '' }),
    },
  })
  let rich: Editor | null = null
  let source: EditorView | null = null
  let target: 'rich' | 'source' = 'rich'
  context.editor.registerRich({
    id: 'editing',
    attach(editor) {
      rich = editor
      const focus = () => {
        target = 'rich'
      }
      editor.on('focus', focus)
      return () => {
        editor.off('focus', focus)
        if (rich === editor) rich = null
      }
    },
  })
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
  async function edit(node: Node, pos: number, block: boolean) {
    const editor = rich
    if (!editor?.isEditable) return
    const doc = editor.state.doc
    const latex = await prompt(String(node.attrs.latex ?? ''))
    if (latex === null || editor.isDestroyed || editor.state.doc !== doc) return
    if (block) editor.chain().focus().updateBlockMath({ pos, latex }).run()
    else editor.chain().focus().updateInlineMath({ pos, latex }).run()
  }
  async function insert(block: boolean) {
    const document = context.editor.getDocument()
    if (!document || !supported(document.name)) {
      context.notify('Math insertion is not available for this format.')
      return
    }
    const editor = rich,
      view = source,
      inSource = target === 'source' || !isMarkdownDocument(document.name)
    const doc = editor?.state.doc,
      text = view?.state.doc
    const selection = inSource
      ? view?.state.selection.main
      : editor?.state.selection
    if (
      !selection ||
      (!inSource && !editor?.schema.nodes[block ? 'blockMath' : 'inlineMath'])
    ) {
      context.notify('Enable math from the format menu in the status bar.')
      return
    }
    const latex = await prompt()
    if (latex === null) return
    if (inSource && view && view.state.doc === text && view === source) {
      const value = block ? `\n\n$$\n${latex}\n$$\n\n` : `$${latex}$`
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: value },
        selection: { anchor: selection.from + value.length },
        userEvent: 'input.format',
        scrollIntoView: true,
      })
      view.focus()
    } else if (
      !inSource &&
      editor &&
      !editor.isDestroyed &&
      editor.state.doc === doc
    ) {
      const chain = editor
        .chain()
        .focus()
        .setTextSelection({ from: selection.from, to: selection.to })
      if (block) chain.insertBlockMath({ latex }).run()
      else chain.insertInlineMath({ latex }).run()
    }
  }
  const inline = InlineMath.extend({
    markdownTokenizer: {
      name: 'inlineMath',
      level: 'inline',
      start: (source) => source.indexOf('$'),
      tokenize: inlineMath,
    },
    addInputRules() {
      return [
        new InputRule({
          find: /(?:^|[^\\$])(\$(?!\$)(?:\\.|[^$\n])+?\$)$/,
          handler: ({ state, range, match }) => {
            const raw = match[1],
              token = raw && inlineMath(raw)
            if (!token) return null
            state.tr.replaceWith(
              range.to - raw.length,
              range.to,
              this.type.create({ latex: token.latex }),
            )
          },
        }),
      ]
    },
  }).configure({
    katexOptions: options,
    onClick: (node, pos) => {
      void edit(node, pos, false)
    },
  })
  const block = BlockMath.extend({
    markdownTokenizer: {
      name: 'blockMath',
      level: 'block',
      start: (source) => source.indexOf('$$'),
      tokenize: blockMath,
    },
    addInputRules() {
      return [
        new InputRule({
          find: /^\$\$([^$\n]+)\$\$$/,
          handler: ({ state, range, match }) => {
            const token = blockMath(match[0])
            const from = state.doc.resolve(range.from)
            if (!token || !from.depth || !from.parent.isTextblock) return null
            state.tr.replaceWith(
              from.before(),
              from.after(),
              this.type.create({ latex: token.latex }),
            )
          },
        }),
      ]
    },
  }).configure({
    katexOptions: options,
    onClick: (node, pos) => {
      void edit(node, pos, true)
    },
  })
  const renderers: MarkedExtension = {
    extensions: ['inlineMath', 'blockMath'].map((name) => ({
      name,
      renderer: (token) =>
        katex.renderToString(String(token.latex ?? ''), {
          ...options,
          displayMode: name === 'blockMath',
          output: 'htmlAndMathml',
        }),
    })),
  }
  context.styles.register('math', mathStyles)
  context.editor.registerFlavor({
    ...mathFlavor,
    richExtensions: [inline, block],
    export: { extensions: [mathTokens, renderers], css: mathStyles },
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
      onClick: () => insert(block),
      hidden: true,
    })
    context.editor.onDocumentChange((document) =>
      item.update({ hidden: !supported(document.name) }),
    )
  }
}
