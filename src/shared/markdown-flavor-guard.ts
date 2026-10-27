import type { PartialParse } from '@lezer/common'
import {
  GFM,
  type LeafBlockParser,
  type MarkdownConfig,
  type MarkdownExtension,
  type MarkdownParser,
} from '@lezer/markdown'

class FlavorSyntaxFailure {}
type SyntaxOwner = { available: () => boolean; fail: (error: unknown) => never }
const guarded = new WeakMap<
  MarkdownConfig,
  { owner: SyntaxOwner; source: MarkdownConfig }
>()
const shared = new Set<MarkdownConfig>(GFM)

/** Each registration owns its callbacks, including objects returned by leaf/wrap. */
export function guardMarkdownSyntax(
  syntax: MarkdownConfig | readonly MarkdownConfig[],
  active: () => boolean,
  failed: (error: unknown) => void,
): MarkdownConfig | readonly MarkdownConfig[] {
  let enabled = true
  const available = () => enabled && active()
  const owner: SyntaxOwner = {
    available,
    fail(error) {
      enabled = false
      failed(error)
      throw new FlavorSyntaxFailure()
    },
  }
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
        // Discard this parse: the callback may have changed its context.
        return owner.fail(error)
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
        defineNodes: config.defineNodes.map((node) => {
          if (typeof node === 'string') return node
          const { name, block, style, composite } = node
          return {
            ...node,
            name,
            ...(block === undefined ? {} : { block }),
            ...(style === undefined ? {} : { style }),
            ...(composite ? { composite: guard(composite) } : {}),
          }
        }),
      }),
      ...(wrapper && {
        wrap: guard((...args: Parameters<typeof wrapper>) =>
          wrapParse(wrapper(...args)),
        ),
      }),
    }
    guarded.set(result, { owner, source: config })
    return result
  }
  try {
    return Array.isArray(syntax)
      ? syntax.map(wrap)
      : wrap(syntax as MarkdownConfig)
  } catch (error) {
    enabled = false
    failed(error)
    const empty = {}
    guarded.set(empty, { owner, source: empty })
    return empty
  }
}

const configurations = new WeakMap<
  MarkdownParser,
  {
    base: MarkdownParser
    stages: readonly MarkdownExtension[]
  }
>()

/** Configure owned syntax with fresh-context recovery, including derived parsers. */
export function protectMarkdownParser(
  base: MarkdownParser,
  extensions: MarkdownExtension,
): MarkdownParser {
  const previous = configurations.get(base)
  const stages = previous ? [...previous.stages, extensions] : [extensions]
  base = previous?.base ?? base
  const configs: MarkdownConfig[] = []
  const ends: number[] = []
  const flatten = (extension: MarkdownExtension) => {
    if (Array.isArray(extension)) extension.forEach(flatten)
    else configs.push(extension as MarkdownConfig)
  }
  for (const stage of stages) {
    flatten(stage)
    ends.push(configs.length)
  }
  const apply = (configs: MarkdownConfig[]) => {
    let result = base
    let start = 0
    for (const end of ends) {
      result = result.configure(configs.slice(start, end))
      start = end
    }
    return result
  }
  const owners = [
    ...new Set(
      configs
        .map((config) => guarded.get(config)?.owner)
        .filter((owner) => owner !== undefined),
    ),
  ]
  if (!owners.length) return apply(configs)
  const activeOwners = () =>
    owners.reduce((count, owner) => count + Number(owner.available()), 0)
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
    retry(() => {
      const names = new Map<string, SyntaxOwner | null>(
        base.nodeSet.types.map((type) => [type.name, null]),
      )
      for (const config of configs) {
        const registration = guarded.get(config)
        if (!registration || shared.has(registration.source))
          for (const node of config.defineNodes ?? [])
            names.set(typeof node === 'string' ? node : node.name, null)
      }
      for (const config of configs) {
        const registration = guarded.get(config)
        if (!registration?.owner.available() || shared.has(registration.source))
          continue
        for (const node of config.defineNodes ?? []) {
          const name = typeof node === 'string' ? node : node.name
          if (names.has(name) && names.get(name) !== registration.owner)
            registration.owner.fail(
              new Error(
                `Syntax node "${name}" is already defined. Use a unique addon-prefixed name.`,
              ),
            )
          names.set(name, registration.owner)
        }
      }
      const configured = configs.map((config) => {
        const owner = guarded.get(config)?.owner
        return {
          owner,
          config:
            owner?.available() !== false
              ? config
              : config.defineNodes
                ? {
                    defineNodes: config.defineNodes.map((node) =>
                      typeof node === 'string'
                        ? node
                        : { name: node.name, block: node.block ?? false },
                    ),
                  }
                : {},
        }
      })
      try {
        return apply(configured.map(({ config }) => config))
      } catch (error) {
        if (error instanceof FlavorSyntaxFailure) throw error
        // Attribute structural errors without discarding a healthy registration's other configs.
        const accepted = new Set<SyntaxOwner>()
        const partial = () =>
          configured.map(({ owner, config }) =>
            owner?.available() && !accepted.has(owner) ? {} : config,
          )
        let result = apply(partial())
        for (const owner of owners) {
          if (!owner.available()) continue
          accepted.add(owner)
          try {
            result = apply(partial())
          } catch (failure) {
            if (failure instanceof FlavorSyntaxFailure) throw failure
            owner.fail(failure)
          }
        }
        return result
      }
    })
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
  configurations.set(result, { base, stages })
  result.configure = (spec) => protectMarkdownParser(result, spec)
  return result
}
