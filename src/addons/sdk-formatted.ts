/** The formatted capability shares CodeMirror with the source view and adds Markdown syntax. */

import {
  DefaultBufferLength,
  IterMode,
  MountedTree,
  NodeProp,
  NodeSet,
  NodeType,
  NodeWeakMap,
  Parser,
  parseMixed,
  Tree,
  TreeBuffer,
  TreeCursor,
  TreeFragment,
} from '@lezer/common'

/** Keep the namespace table in this lazy module, sharing the host's constructors. */
export const common = Object.freeze({
  DefaultBufferLength,
  IterMode,
  MountedTree,
  NodeProp,
  NodeSet,
  NodeType,
  NodeWeakMap,
  Parser,
  Tree,
  TreeBuffer,
  TreeCursor,
  TreeFragment,
  parseMixed,
})
export * as markdown from '@lezer/markdown'
export * from './sdk-source'
