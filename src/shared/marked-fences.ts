import type { MarkedExtension, Tokenizer } from 'marked'

type Rules = Tokenizer['rules']
const commonMark = new WeakMap<Rules, Rules>()

/**
 * Marked's rules with its fence rules corrected to CommonMark: a closing
 * fence may end in tabs as well as spaces, it repeats only the opening
 * fence's character, and tilde fences remove their indentation from body
 * lines as backtick fences do.
 */
function fenceRules(rules: Rules) {
  // Pedantic mode has no fence rule.
  if (!(rules.block.fences instanceof RegExp)) return rules
  let fixed = commonMark.get(rules)
  if (!fixed) {
    const { fences } = rules.block
    const { indentCodeCompensation: indent } = rules.other
    fixed = {
      ...rules,
      block: {
        ...rules.block,
        fences: new RegExp(
          fences.source
            .replace(' *(?=\\n|$)', '[ \\t]*(?=\\n|$)')
            .replace('\\1[~`]*', '\\1(?:(?<=`)`*|(?<=~)~*)'),
          fences.flags,
        ),
      },
      other: {
        ...rules.other,
        indentCodeCompensation: new RegExp(
          indent.source.replace('(?:```)', '(?:```|~~~)'),
          indent.flags,
        ),
      },
    }
    commonMark.set(rules, fixed).set(fixed, fixed)
  }
  return fixed
}

/** Runs `read` with the corrected fence rules. */
export function withFenceRules<Result>(
  tokenizer: Tokenizer,
  read: () => Result,
) {
  const rules = tokenizer.rules
  tokenizer.rules = fenceRules(rules)
  try {
    return read()
  } finally {
    tokenizer.rules = rules
  }
}

/**
 * Gives a parser's fence tokenizers the corrected rules for the rest of its
 * lexing; each lexer installs fresh rules. The earlier tokenizers still read.
 */
export const commonMarkFences: MarkedExtension = {
  tokenizer: {
    fences() {
      this.rules = fenceRules(this.rules)
      return false
    },
  },
}
