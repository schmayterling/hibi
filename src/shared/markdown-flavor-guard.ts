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
      ...(config.props && { props: config.props.map(guard) }),
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
  const owners = configs
    .map((config) => guarded.get(config))
    .filter((available) => available !== undefined)
  if (!owners.length) return base.configure(extensions)
  const activeOwners = () =>
    owners.reduce((count, available) => count + Number(available()), 0)
  const retry = <T>(run: () => T): T => {
    let remaining = activeOwners()
    for (;;) {
      try {
        return run()
      } catch (error) {
        const next = activeOwners()
        if (!(error instanceof FlavorSyntaxFailure) || next >= remaining)
          throw error
        remaining = next
      }
    }
  }
  // Keep node ids stable, but restore overridden/removed rules after quarantine.
  const configure = () =>
    retry(() =>
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
      ),
    )
  const result = configure()
  let current = result
  let count = activeOwners()
  let create = current.createParse.bind(current)
  let inline = current.parseInline.bind(current)
  let parsing = 0
  const attempt = <T>(run: () => T): T =>
    retry(() => {
      try {
        parsing++
        if (activeOwners() !== count) {
          current = configure()
          count = activeOwners()
          create = current.createParse.bind(current)
          inline = current.parseInline.bind(current)
        }
        const value = run()
        if (activeOwners() !== count) throw new FlavorSyntaxFailure()
        return value
      } finally {
        parsing--
      }
    })
  result.createParse = (input, fragments, ranges) => {
    let parse: PartialParse | undefined
    let version = current
    // Fragments made before quarantine may contain the removed owner's nodes.
    if (activeOwners() !== owners.length) fragments = []
    let stoppedAt: number | null = null
    const start = () => {
      if (version !== current) {
        fragments = []
        parse = undefined
        version = current
      }
      if (!parse) {
        parse = create(input, fragments, ranges)
        if (stoppedAt !== null) parse.stopAt(stoppedAt)
      }
      return parse
    }
    attempt(start)
    return {
      advance: () => attempt(() => start().advance()),
      stopAt(position) {
        stoppedAt = position
        attempt(() => start().stopAt(position))
      },
      get parsedPos() {
        return attempt(() => start().parsedPos)
      },
      get stoppedAt() {
        return attempt(() => start().stoppedAt)
      },
    }
  }
  result.parseInline = (text, offset) =>
    parsing ? inline(text, offset) : attempt(() => inline(text, offset))
  result.configure = (spec) => protectMarkdownParser(base, [extensions, spec])
  return result
}
