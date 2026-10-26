import type { PartialParse } from '@lezer/common'
import type {
  LeafBlockParser,
  MarkdownConfig,
  MarkdownExtension,
  MarkdownParser,
} from '@lezer/markdown'

class FlavorSyntaxFailure {}
const guarded = new WeakMap<MarkdownConfig, () => boolean>()

/** Each registration owns its callbacks, including objects returned by leaf/wrap. */
export function guardMarkdownSyntax(
  syntax: MarkdownConfig | readonly MarkdownConfig[],
  active: () => boolean,
  failed: (error: unknown) => void,
): MarkdownConfig | readonly MarkdownConfig[] {
  let enabled = true
  const available = () => enabled && active()
  const guard = <Args extends unknown[], Result>(
    callback: (...args: Args) => Result,
  ) =>
    function (this: unknown, ...args: Args): Result {
      if (!available()) throw new FlavorSyntaxFailure()
      try {
        return callback.apply(this, args)
      } catch (error) {
        // A nested callback already identified its owner.
        if (error instanceof FlavorSyntaxFailure) throw error
        enabled = false
        failed(error)
        // Discard this parse: the callback may have changed its context.
        throw new FlavorSyntaxFailure()
      }
    }
  const wrapLeaf = (leaf: LeafBlockParser | null): LeafBlockParser | null =>
    leaf && {
      nextLine: guard(leaf.nextLine.bind(leaf)),
      finish: guard(leaf.finish.bind(leaf)),
    }
  const wrapParse = (parse: PartialParse): PartialParse => ({
    advance: guard(() => parse.advance()),
    stopAt: guard((position: number) => parse.stopAt(position)),
    get parsedPos() {
      return guard(() => parse.parsedPos)()
    },
    get stoppedAt() {
      return guard(() => parse.stoppedAt)()
    },
  })
  const wrap = (config: MarkdownConfig): MarkdownConfig => {
    const wrapper = config.wrap
    const result: MarkdownConfig = {
      ...config,
      ...(config.parseInline && {
        parseInline: config.parseInline.map((rule) => ({
          ...rule,
          parse: guard(rule.parse),
        })),
      }),
      ...(config.parseBlock && {
        parseBlock: config.parseBlock.map((rule) => {
          const leaf = rule.leaf
          return {
            ...rule,
            ...(rule.parse && { parse: guard(rule.parse) }),
            ...(rule.endLeaf && { endLeaf: guard(rule.endLeaf) }),
            ...(leaf && {
              leaf: guard((...args: Parameters<typeof leaf>) =>
                wrapLeaf(leaf(...args)),
              ),
            }),
          }
        }),
      }),
      ...(config.defineNodes && {
        defineNodes: config.defineNodes.map((node) =>
          typeof node === 'string' || !node.composite
            ? node
            : { ...node, composite: guard(node.composite) },
        ),
      }),
      ...(wrapper && {
        wrap: guard((...args: Parameters<typeof wrapper>) =>
          wrapParse(wrapper(...args)),
        ),
      }),
    }
    guarded.set(result, available)
    return result
  }
  return Array.isArray(syntax)
    ? syntax.map(wrap)
    : wrap(syntax as MarkdownConfig)
}

/** Configure owned syntax with fresh-context recovery, including derived parsers. */
export function protectMarkdownParser(
  base: MarkdownParser,
  extensions: MarkdownExtension,
): MarkdownParser {
  const configs: MarkdownConfig[] = []
  const flatten = (extension: MarkdownExtension) => {
    if (Array.isArray(extension)) extension.forEach(flatten)
    else configs.push(extension as MarkdownConfig)
  }
  flatten(extensions)
  const owners = configs.filter((config) => guarded.has(config))
  if (!owners.length) return base.configure(extensions)
  // Keep node ids stable, but restore overridden/removed rules after quarantine.
  const configure = () =>
    base.configure(
      configs.map((config) => {
        if (guarded.get(config)?.() !== false) return config
        return config.defineNodes
          ? {
              defineNodes: config.defineNodes.map((node) =>
                typeof node === 'string'
                  ? node
                  : { name: node.name, block: node.block ?? false },
              ),
            }
          : {}
      }),
    )
  const result = configure()
  let current = result
  let create = current.createParse.bind(current)
  let inline = current.parseInline.bind(current)
  let parsing = 0
  const attempt = <T>(run: () => T, restart: () => void): T => {
    for (;;) {
      try {
        parsing++
        return run()
      } catch (error) {
        if (!(error instanceof FlavorSyntaxFailure)) throw error
        current = configure()
        create = current.createParse.bind(current)
        inline = current.parseInline.bind(current)
        restart()
      } finally {
        parsing--
      }
    }
  }
  result.createParse = (input, fragments, ranges) => {
    let parse: PartialParse | undefined
    let stoppedAt: number | null = null
    const start = () => {
      if (!parse) {
        parse = create(input, fragments, ranges)
        if (stoppedAt !== null) parse.stopAt(stoppedAt)
      }
      return parse
    }
    const restart = () => {
      fragments = []
      parse = undefined
    }
    attempt(start, restart)
    return {
      advance: () => attempt(() => start().advance(), restart),
      stopAt(position) {
        stoppedAt = position
        attempt(() => start().stopAt(position), restart)
      },
      get parsedPos() {
        return attempt(() => start().parsedPos, restart)
      },
      get stoppedAt() {
        return attempt(() => start().stoppedAt, restart)
      },
    }
  }
  result.parseInline = (text, offset) =>
    parsing
      ? inline(text, offset)
      : attempt(
          () => inline(text, offset),
          () => {},
        )
  result.configure = (spec) => protectMarkdownParser(base, [extensions, spec])
  return result
}
