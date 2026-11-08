import { formattedRegistry } from '../../../../renderer/src/formatted-registry.ts'
import type { FencedRenderer } from '../../../_shared/formatted-fence'
import { Component } from '../core/component.ts'
import { reportError } from '../core/events.ts'
import type { App, PluginInstance } from '../types'

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
  sourcePath: () => string
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
): MarkdownPostProcessorContext {
  return {
    docId: `obsidian-${++sequence}`,
    sourcePath,
    frontmatter: null,
    addChild: (child) => owner.addChild(child),
    // ponytail: rendered blocks do not keep their source lines; null is Obsidian's "unknown". Add when a fence widget passes its range.
    getSectionInfo: () => null,
  }
}

/** Code block and post processors of one vault, with removal on plugin unload. */
export class Processors {
  readonly code = new Map<string, CodeBlockProcessor>()
  readonly post = new Set<MarkdownPostProcessor>()

  private readonly app: App
  readonly sourcePath: () => string

  constructor(app: App, html: Renderer['html'], sourcePath: () => string) {
    this.app = app
    this.sourcePath = sourcePath
    renderers.set(app, { html, sourcePath, code: this.code, post: this.post })
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
                const render = (source: string) => {
                  owner.unload()
                  owner = new Component()
                  owner.load()
                  dom.replaceChildren()
                  try {
                    settle(
                      handler(
                        source,
                        dom,
                        processorContext(this.sourcePath(), owner),
                      ),
                    )
                  } catch (error) {
                    reportError(error)
                  }
                }
                render(block.source)
                return {
                  update: ({ source }) => render(source),
                  dispose: () => owner.unload(),
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
