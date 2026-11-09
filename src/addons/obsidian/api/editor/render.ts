import { syntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { formattedSyntaxTree } from '../../../../renderer/src/formatted-contributions.ts'
import { formattedRegistry } from '../../../../renderer/src/formatted-registry.ts'
import type { FencedRenderer } from '../../../_shared/formatted-fence'
import { Component } from '../core/component.ts'
import { reportError } from '../core/events.ts'
import type { App, PluginInstance } from '../types'
import { editorInfoField } from './extensions.ts'

export type MarkdownSectionInformation = {
  text: string
  lineStart: number
  lineEnd: number
}
export type MarkdownPostProcessorContext = {
  docId: string
  sourcePath: string
  frontmatter: unknown
  addChild: (child: Component) => void
  getSectionInfo: (el: HTMLElement) => MarkdownSectionInformation | null
}
export type CodeBlockProcessor = (
  source: string,
  el: HTMLElement,
  context: MarkdownPostProcessorContext,
) => unknown
export type MarkdownPostProcessor = ((
  el: HTMLElement,
  context: MarkdownPostProcessorContext,
) => unknown) & { sortOrder?: number }

/** A component whose life is one rendered element. */
export class MarkdownRenderChild extends Component {
  readonly containerEl: HTMLElement
  constructor(containerEl: HTMLElement) {
    super()
    this.containerEl = containerEl
  }
}

type Renderer = {
  /** Markdown to safe HTML with the note's flavors, as previews render it. */
  html: (markdown: string) => string
  code: Map<string, CodeBlockProcessor>
  post: Set<MarkdownPostProcessor>
}
const renderers = new WeakMap<App, Renderer>()
/** Vaults in this window, for the app-less legacy renderMarkdown. */
const apps = new Set<App>()

let sequence = 0
const language = (info: string) => info.trim().split(/\s+/)[0]!.toLowerCase()
const settle = (result: unknown) =>
  result && typeof (result as Promise<unknown>).then === 'function'
    ? (result as Promise<unknown>).then(undefined, reportError)
    : undefined

function processorContext(
  sourcePath: string,
  owner: Component,
  // ponytail: MarkdownRenderer output keeps no source lines, so null ("unknown"); map Marked token lines if plugins need it there.
  getSectionInfo: MarkdownPostProcessorContext['getSectionInfo'] = () => null,
): MarkdownPostProcessorContext {
  return {
    docId: `obsidian-${++sequence}`,
    sourcePath,
    frontmatter: null,
    addChild: (child) => owner.addChild(child),
    getSectionInfo,
  }
}

/** The note of the editor a rendered block is in, never the focused pane's. */
function blockPath(el: HTMLElement) {
  const editor = el.closest?.<HTMLElement>('.cm-editor')
  const view = editor && EditorView.findFromDOM(editor)
  const file = view?.state.field(editorInfoField, false)?.file as
    | { path?: string }
    | null
    | undefined
  return file?.path ?? ''
}

/** The fence holding a rendered block in a formatted view: the note and its 0-based lines. */
export function fenceSection(
  el: HTMLElement,
): MarkdownSectionInformation | null {
  const editor = el.closest<HTMLElement>('.cm-editor')
  const view = editor && EditorView.findFromDOM(editor)
  if (!view) return null
  let at: number
  try {
    at = view.posAtDOM(el)
  } catch {
    return null
  }
  // The formatted view parses near the viewport into its own tree.
  const tree = formattedSyntaxTree(view.state) ?? syntaxTree(view.state)
  // A replaced fence starts at the block; a revealed one ends there.
  for (const side of [1, -1] as const) {
    for (
      let node: SyntaxNode | null = tree.resolveInner(at, side);
      node;
      node = node.parent
    ) {
      if (node.name !== 'FencedCode') continue
      const { doc } = view.state
      return {
        text: doc.toString(),
        lineStart: doc.lineAt(node.from).number - 1,
        lineEnd: doc.lineAt(node.to).number - 1,
      }
    }
  }
  return null
}

/** Code block and post processors of one vault, with removal on plugin unload. */
export class Processors {
  readonly code = new Map<string, CodeBlockProcessor>()
  readonly post = new Set<MarkdownPostProcessor>()

  private readonly app: App

  constructor(app: App, html: Renderer['html']) {
    this.app = app
    renderers.set(app, { html, code: this.code, post: this.post })
    apps.add(app)
  }

  dispose() {
    renderers.delete(this.app)
    apps.delete(this.app)
  }

  registerPost(plugin: PluginInstance, processor: MarkdownPostProcessor) {
    this.post.add(processor)
    plugin.register(() => this.post.delete(processor))
    return processor
  }

  /** Fences of the language render in the formatted view and in MarkdownRenderer. */
  registerCode(
    plugin: PluginInstance,
    name: string,
    handler: CodeBlockProcessor,
  ) {
    const key = language(name)
    if (!key || this.code.has(key))
      throw new Error(`A code block processor for "${name}" already exists.`)
    this.code.set(key, handler)
    const id = `obsidian.code-${++sequence}`
    const remove = formattedRegistry.register({
      id,
      load: () =>
        import('../../../_shared/formatted-fence.ts').then(
          ({ fencedView, markedFenceText, RenderedBlocks }) => {
            const renderer: FencedRenderer = {
              id,
              className: 'obsidian-code-block',
              matches: (info) => language(info) === key,
              source: markedFenceText,
              indented: () => true,
              mount: (dom, block) => {
                let owner = new Component()
                let current = 0
                // Runs once the block is in the view, so getSectionInfo can find its fence.
                const render = (source: string) => {
                  const run = ++current
                  queueMicrotask(() => {
                    if (run !== current) return
                    owner.unload()
                    owner = new Component()
                    owner.load()
                    dom.replaceChildren()
                    try {
                      settle(
                        handler(
                          source,
                          dom,
                          processorContext(blockPath(dom), owner, fenceSection),
                        ),
                      )
                    } catch (error) {
                      reportError(error)
                    }
                  })
                }
                render(block.source)
                return {
                  update: ({ source }) => render(source),
                  dispose: () => {
                    current++
                    owner.unload()
                  },
                }
              },
              settled: () => true,
              ask: async () => null,
              blocks: new RenderedBlocks(16),
            }
            return { id, views: [fencedView(renderer)] }
          },
        ),
    })
    plugin.register(() => {
      remove()
      if (this.code.get(key) === handler) this.code.delete(key)
    })
  }
}

export class MarkdownRenderer extends MarkdownRenderChild {
  /** Render Markdown into `el` as sanitized HTML, then run the vault's processors. */
  static async render(
    app: App,
    markdown: string,
    el: HTMLElement,
    sourcePath: string,
    component: Component,
  ) {
    const renderer = renderers.get(app)
    if (!renderer) throw new Error('Markdown rendering is not available.')
    const [{ default: DOMPurify }, { renderedHtmlOptions }] = await Promise.all(
      [import('dompurify'), import('../../../../shared/rendered-html.ts')],
    )
    const html = renderer.html(markdown)
    el.append(
      DOMPurify.sanitize(html, {
        ...renderedHtmlOptions,
        // Preserve safe app links alongside DOMPurify's existing URI whitelist.
        ALLOWED_URI_REGEXP:
          /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|(?:obsidian:\/\/|hibi:\/\/obsidian\/)|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
        // Inline styles in a note could cover or restyle the app around it.
        FORBID_ATTR: [...(renderedHtmlOptions.FORBID_ATTR ?? []), 'style'],
        RETURN_DOM_FRAGMENT: true,
      }),
    )
    const context = processorContext(sourcePath, component)
    for (const code of el.querySelectorAll<HTMLElement>(
      'pre > code[class^="language-"]',
    )) {
      const name = /^language-(\S+)/.exec(code.className)?.[1] ?? ''
      const handler = renderer.code.get(language(name))
      if (!handler) continue
      const block = document.createElement('div')
      block.className = `block-language-${language(name)}`
      code.parentElement!.replaceWith(block)
      await handler(code.textContent!.replace(/\n$/, ''), block, context)
    }
    for (const processor of [...renderer.post].sort(
      (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
    ))
      await processor(el, context)
  }
  /** Obsidian's older name. */
  static renderMarkdown(
    markdown: string,
    el: HTMLElement,
    sourcePath: string,
    component: Component,
  ) {
    const app = [...apps].at(-1)
    if (!app) throw new Error('Markdown rendering is not available.')
    return MarkdownRenderer.render(app, markdown, el, sourcePath, component)
  }
}
