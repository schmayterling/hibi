import type { WorkspaceMetadataPage } from './workspace-index-metadata.ts'
import type { MetadataParseInput } from './workspace-metadata-parser.ts'

export {
  RecordReader,
  type RecordSlice,
  type RecordToken,
  RecordWriter,
  recordSliceBytes,
  recordSliceCharacters,
  recordSliceTokens,
  recordTokens,
} from '../shared/metadata-stream.ts'

export function incompleteMetadataPage(
  input: MetadataParseInput,
): WorkspaceMetadataPage {
  return {
    id: input.id,
    path: input.path,
    version: input.version,
    syntax: { ...input.syntax, complete: false },
    metadata: {
      references: { links: [], wikilinks: [] },
      referenceComplete: false,
      tags: [],
      properties: { values: {}, complete: false },
      headings: { items: [], complete: false, count: 0, paged: true },
    },
  }
}
