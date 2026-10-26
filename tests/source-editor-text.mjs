import { Text } from '@codemirror/state'
import { normalizedSource } from '../src/shared/source-projection.ts'

// Synchronous oracle for fixtures; production construction stays cooperative.
export const sourceEditorText = (source) =>
  Text.of(normalizedSource(source.materialize()).split('\n'))
